import concurrent.futures
import threading
import unittest
from unittest.mock import patch

import test_relay
from relay.mcp import Connector
from relay.store import Store

SHA = 'a' * 40


class CoordinationTests(unittest.TestCase):
    setUp = test_relay.RelayIntegrationTests.setUp
    tearDown = test_relay.RelayIntegrationTests.tearDown

    def plan(self, client, session, paths=None, **extra):
        return client.action('work-plan', dict(session_id=session, title='Feature', plan='Change implementation and test it',
            paths=paths or ['src/auth.py'], contracts=[], base_commit=SHA, **extra))['work']

    def update(self, client, session, work, operation, **extra):
        return client.action('work-' + operation, dict(session_id=session, work_id=work['id'],
            revision=work['revision'], base_commit=SHA, **extra))

    def review(self, client, session, target, own, decision='agree'):
        return client.action('work-review', dict(session_id=session, work_id=target['id'], revision=target['revision'],
            reviewer_revision=own['revision'], decision=decision, note='Reviewed scope and interface against my plan'))

    def test_nonoverlapping_work_requires_peer_exchange_then_runs_in_parallel(self):
        a = self.plan(self.alice, self.a_session)
        b = self.plan(self.bob, self.b_session, ['src/billing.py'])
        self.assertFalse(self.update(self.alice, self.a_session, a, 'start')['proceed'])
        self.review(self.bob, self.b_session, a, b)
        self.review(self.alice, self.a_session, b, a)
        self.assertTrue(self.update(self.alice, self.a_session, a, 'start')['proceed'])
        self.assertTrue(self.update(self.bob, self.b_session, b, 'start')['proceed'])
        state = self.alice.request('/api/state')['coordination']
        self.assertEqual([p['status'] for p in state['plans']], ['working', 'working'])
        self.assertEqual(state['mode'], 'advisory')
        self.assertFalse(state['edit_gate'])
        self.assertEqual(len([m for m in state['messages'] if m['kind'] == 'agree']), 2)

    def test_simultaneous_conflicting_starts_only_one_wins(self):
        a = self.plan(self.alice, self.a_session, ['SRC/Auth.py'])
        b = self.plan(self.bob, self.b_session, ['src'])
        self.review(self.bob, self.b_session, a, b)
        self.review(self.alice, self.a_session, b, a)
        barrier = threading.Barrier(2)
        def start(client, session, work):
            barrier.wait()
            return self.update(client, session, work, 'start')['proceed']
        with concurrent.futures.ThreadPoolExecutor(2) as pool:
            futures = [pool.submit(start, self.alice, self.a_session, a), pool.submit(start, self.bob, self.b_session, b)]
            self.assertEqual(sorted(f.result() for f in futures), [False, True])

    def test_shared_interface_conflicts_across_different_files(self):
        a = self.plan(self.alice, self.a_session)
        b = self.plan(self.bob, self.b_session, ['ui/login.ts'])
        for client, session, work in [(self.alice, self.a_session, a), (self.bob, self.b_session, b)]:
            client.action('work-plan', dict(session_id=session, title='Auth', plan='Change the login API',
                paths=work['paths'], contracts=['API:LOGIN'], base_commit=SHA, revision=1))
            work['revision'] = 2
        self.review(self.bob, self.b_session, a, b)
        self.review(self.alice, self.a_session, b, a)
        self.assertTrue(self.update(self.alice, self.a_session, a, 'start')['proceed'])
        result = self.update(self.bob, self.b_session, b, 'start')
        self.assertFalse(result['proceed'])
        self.assertEqual(result['blockers'][0]['contracts'], ['api:login'])

    def test_replanning_invalidates_both_directions_of_review(self):
        a = self.plan(self.alice, self.a_session)
        b = self.plan(self.bob, self.b_session, ['ui'])
        self.review(self.bob, self.b_session, a, b)
        self.review(self.alice, self.a_session, b, a)
        a = self.plan(self.alice, self.a_session, ['src/other.py'], revision=1)
        self.assertFalse(self.update(self.alice, self.a_session, a, 'start')['proceed'])
        self.assertFalse(self.update(self.bob, self.b_session, b, 'start')['proceed'])
        with self.assertRaisesRegex(ValueError, 'Plan changed'):
            self.review(self.alice, self.a_session, b, dict(a, revision=1))

    def test_offline_and_finished_work_keep_reservations_until_release(self):
        a = self.plan(self.alice, self.a_session)
        self.update(self.alice, self.a_session, a, 'start')
        b = self.plan(self.bob, self.b_session)
        self.review(self.alice, self.a_session, b, a)
        with self.store.connect() as db:
            db.execute('UPDATE work_plans SET lease_until=0 WHERE id=?', (a['id'],))
        self.assertTrue(next(p for p in self.alice.request('/api/state')['coordination']['plans'] if p['id']==a['id'])['stale'])
        self.assertFalse(self.update(self.bob, self.b_session, b, 'start')['proceed'])
        self.update(self.alice, self.a_session, a, 'finish', note='Commit and test evidence pending integration')
        self.assertFalse(self.update(self.bob, self.b_session, b, 'start')['proceed'])
        with self.assertRaisesRegex(ValueError, 'note is required'):
            self.update(self.alice, self.a_session, a, 'release')
        self.update(self.alice, self.a_session, a, 'release', note='Cancelled; local changes reconciled. Agent-reported.')
        self.assertTrue(self.update(self.bob, self.b_session, b, 'start')['proceed'])

    def test_ownership_cross_project_revocation_and_self_review(self):
        a = self.plan(self.alice, self.a_session)
        with self.assertRaisesRegex(ValueError, 'Only this work session'):
            self.update(self.bob, self.b_session, a, 'release', note='Forged')
        with self.assertRaisesRegex(ValueError, 'Only this session'):
            self.update(self.bob, self.a_session, a, 'release', note='Forged')
        with self.assertRaisesRegex(ValueError, 'peer must review'):
            self.review(self.alice, self.a_session, a, a)
        project = self.bob.action('project', {'name': 'Other'})['id']
        session = self.bob.action('session', {'name': 'Other', 'project_id': project})['id']
        with self.assertRaisesRegex(ValueError, 'not in this session project'):
            self.bob.action('work-message', dict(session_id=session, work_id=a['id'], note='Wrong project'))
        self.alice.action('revoke', {'member_id': self.bob_id})
        with self.assertRaisesRegex(ValueError, 'valid workspace access token'):
            self.bob.action('work-message', dict(session_id=self.b_session, work_id=a['id'], note='Revoked'))

    def test_reject_unsafe_scope_and_non_git_base(self):
        for path in ['../src', '/root', 'C:\\repo', 'src/../auth', 'src/*', 'src//auth', '/']:
            with self.subTest(path=path), self.assertRaises(ValueError):
                self.plan(self.alice, self.a_session, [path])
        with self.assertRaisesRegex(ValueError, 'full Git commit'):
            self.alice.action('work-plan', dict(session_id=self.a_session, title='x', plan='x', paths=['.'], base_commit='abc'))

    def test_new_participant_and_revision_mismatch_stop_next_edit_check(self):
        a = self.plan(self.alice, self.a_session)
        self.update(self.alice, self.a_session, a, 'start')
        b = self.plan(self.bob, self.b_session, ['ui'])
        self.assertFalse(self.update(self.alice, self.a_session, a, 'check')['proceed'])
        self.review(self.bob, self.b_session, a, b, decision='changes_requested')
        self.assertFalse(self.update(self.alice, self.a_session, a, 'check')['proceed'])
        self.review(self.bob, self.b_session, a, b)
        result = self.alice.action('work-check', dict(session_id=self.a_session, work_id=a['id'], revision=1, base_commit='b'*40))
        self.assertFalse(result['proceed'])
        self.assertEqual(result['blockers'][0]['kind'], 'base_changed')
        with self.assertRaisesRegex(ValueError, 'Finish and explicitly release'):
            self.plan(self.alice, self.a_session, ['new-scope'], revision=1)

    def test_pausing_sharing_blocks_new_coordination_uploads(self):
        a = self.plan(self.alice, self.a_session)
        self.alice.action('bind', dict(session_id=self.a_session, provider='codex', source_id='qa-source', title='QA'))
        self.alice.action('session-toggle', dict(session_id=self.a_session, enabled=False))
        with self.assertRaisesRegex(ValueError, 'Sharing is paused'):
            self.alice.action('work-message', dict(session_id=self.a_session, work_id=a['id'], note='Must not upload'))
        self.assertFalse(any(m['body']=='Must not upload' for m in self.alice.request('/api/state')['coordination']['messages']))

    def test_mcp_binds_identity_and_revision_to_local_git(self):
        connector = Connector(dict(session_id=self.a_session, project_id=self.project, repo='fixture'), self.alice)
        with patch('relay.mcp.git_info', return_value={'commit_sha': SHA}):
            plan = connector.call('relay_work_plan', dict(title='Feature', plan='Implement', paths=['src']))['work']
            result = connector.call('relay_work_update', dict(work_id=plan['id'], revision=1, operation='start'))
        self.assertTrue(result['proceed'])
        self.assertEqual(plan['base_commit'], SHA)
        with self.assertRaisesRegex(ValueError, 'Unexpected'):
            connector.call('relay_work_plan', dict(title='x', plan='x', paths=['.'], session_id=self.b_session))
        with self.assertRaisesRegex(ValueError, 'list'):
            connector.call('relay_work_plan', dict(title='x', plan='x', paths='src'))
        connector.call('relay_work_message', dict(work_id=plan['id'], note='Interface discussion'))
        self.assertIn('Interface discussion', str(connector.call('relay_project', {})['coordination']))

    def test_migration_keeps_plans_and_legacy_data(self):
        self.plan(self.alice, self.a_session)
        Store(self.directory / 'hub')
        state = self.alice.request('/api/state')
        self.assertEqual(len(state['coordination']['plans']), 1)
        self.assertEqual(len(state['sessions']), 2)


if __name__ == '__main__':
    unittest.main()
