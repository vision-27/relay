import hashlib
import json
import threading
import unittest

import test_relay


class TeamTests(unittest.TestCase):
    setUp = test_relay.RelayIntegrationTests.setUp
    tearDown = test_relay.RelayIntegrationTests.tearDown

    def action(self, client, sid, action, **data):
        if action in ('start', 'submit', 'review', 'block'):
            data.setdefault('attempt', 1)
        return client.action('team-' + action, dict(session_id=sid, instance=sid, **data))

    def setup_team(self, objective='Build two independent components'):
        with self.store.connect() as db:
            db.execute('UPDATE sessions SET commit_sha=?', ('a' * 40,))
        self.key = hashlib.sha256(b'repo').hexdigest()
        self.goal = self.alice.action('team-create', dict(project_id=self.project, repository_key=self.key, objective=objective))['id']
        for client, sid in [(self.alice, self.a_session), (self.bob, self.b_session)]:
            client.action('live-join', dict(session_id=sid, instance=sid, repository_key=self.key))
            self.action(client, sid, 'enroll', goal_id=self.goal)
        return self.action(self.alice, self.a_session, 'poll')['assignment']

    def propose(self, paths=('src/a', 'src/b'), deps=None):
        job = self.setup_team()
        tasks = [dict(key='task' + str(i), title='Task ' + str(i), instructions='Implement only the scoped component',
                      acceptance='Review the code and run the agreed checks', paths=[p], contracts=[], dependencies=(deps or {}).get(i, [])) for i, p in enumerate(paths)]
        self.action(self.alice, self.a_session, 'plan', revision=job['goal']['revision'], tasks=tasks)
        review = self.action(self.bob, self.b_session, 'poll')['assignment']
        self.assertEqual(review['kind'], 'plan_review')
        self.action(self.bob, self.b_session, 'plan-review', revision=review['goal']['revision'], decision='accept', note='Scopes and interfaces reviewed against approved goal')
        return tasks

    def assignments(self):
        a = self.action(self.alice, self.a_session, 'poll')['assignment']
        b = self.action(self.bob, self.b_session, 'poll')['assignment']
        return a, b

    def start(self, client, sid, task):
        return self.action(client, sid, 'start', task_id=task['id'], base_commit=task['base_commit'])

    def drain(self, client, sid):
        for message in client.action('live-poll', dict(session_id=sid, instance=sid))['messages']:
            client.action('live-delivered', dict(session_id=sid, instance=sid, message_id=message['message_id']))
            client.action('live-ack', dict(session_id=sid, instance=sid, message_id=message['message_id'], note='Reviewed against assigned goal'))

    def test_parallel_disjoint_assignment_and_repeat_poll_are_idempotent(self):
        self.propose()
        a, b = self.assignments()
        self.assertEqual(a['kind'], 'implement')
        self.assertNotEqual(a['task']['id'], b['task']['id'])
        self.assertEqual(self.action(self.alice, self.a_session, 'poll')['assignment']['key'], a['key'])
        self.assertEqual(len(self.action(self.alice, self.a_session, 'state')['tasks']), 2)

    def test_concurrent_polls_do_not_duplicate_ownership(self):
        self.propose()
        errors = []
        def poll(client, sid):
            try: self.action(client, sid, 'poll')
            except Exception as exc: errors.append(str(exc))
        threads = [threading.Thread(target=poll, args=(c, s)) for c, s in [(self.alice, self.a_session), (self.bob, self.b_session)] * 3]
        for t in threads: t.start()
        for t in threads: t.join()
        self.assertEqual(errors, [])
        tasks = self.action(self.alice, self.a_session, 'state')['tasks']
        self.assertEqual(len(set(t['assignee'] for t in tasks)), 2)

    def test_overlap_stays_queued_and_offline_work_is_not_stolen(self):
        self.propose(paths=('src/shared', 'src/shared/file.py'))
        a, b = self.assignments()
        self.assertIsNone(b)
        self.alice.action('live-leave', dict(session_id=self.a_session, instance=self.a_session))
        self.assertIsNone(self.action(self.bob, self.b_session, 'poll')['assignment'])
        state = self.action(self.bob, self.b_session, 'state')
        self.assertEqual(next(t for t in state['tasks'] if t['id'] == a['task']['id'])['assignee'], self.a_session)

    def test_dependency_waits_for_integration_not_agent_submission(self):
        self.propose(deps={1: ['task0']})
        a, b = self.assignments()
        self.assertIsNone(b)
        self.start(self.alice, self.a_session, a['task'])
        self.action(self.alice, self.a_session, 'submit', task_id=a['task']['id'], summary='Implemented', evidence='Code inspected, tests not run', artifacts=[])
        review = self.action(self.bob, self.b_session, 'poll')['assignment']
        self.assertEqual(review['kind'], 'review')
        self.action(self.bob, self.b_session, 'review', task_id=a['task']['id'], decision='accept', note='Requirements reviewed; developer tests still needed')
        self.assertIsNone(self.action(self.alice, self.a_session, 'poll')['assignment'])
        self.alice.action('team-accept', dict(goal_id=self.goal, task_id=a['task']['id'], verified_files={}, note='Read-only fixture inspected; tests not applicable'))
        self.assertEqual(self.action(self.alice, self.a_session, 'poll')['assignment']['task']['task_key'], 'task1')

    def test_agent_cannot_accept_own_work_or_skip_review(self):
        self.propose(paths=('src/a',))
        a, _ = self.assignments()
        self.start(self.alice, self.a_session, a['task'])
        with self.assertRaisesRegex(ValueError, 'Peer review'):
            self.alice.action('team-accept', dict(goal_id=self.goal, task_id=a['task']['id'], verified_files={}, note='done'))
        self.action(self.alice, self.a_session, 'submit', task_id=a['task']['id'], summary='Done', evidence='Fixture evidence', artifacts=[])
        with self.assertRaisesRegex(ValueError, 'assigned independent reviewer'):
            self.action(self.alice, self.a_session, 'review', task_id=a['task']['id'], decision='accept', note='myself')

    def test_task_scope_and_base_are_enforced_at_actual_edit_gate(self):
        self.propose()
        a, _ = self.assignments()
        # Integration fixtures start with empty commit metadata; set a real hash.
        with self.store.connect() as db:
            db.execute('UPDATE team_tasks SET base_commit=? WHERE id=?', ('a' * 40, a['task']['id']))
        a['task']['base_commit'] = 'a' * 40
        self.start(self.alice, self.a_session, a['task'])
        self.drain(self.alice, self.a_session)
        def gate(path, base='a' * 40):
            return self.alice.action('live-gate', dict(session_id=self.a_session, instance=self.a_session, path=path, base_commit=base))
        assigned = a['task']['paths'][0]
        self.assertTrue(gate(assigned + '/file.py')['proceed'])
        self.assertFalse(gate('elsewhere/file.py')['proceed'])
        self.assertFalse(gate(assigned + '/file.py', 'b' * 40)['proceed'])
        self.alice.action('team-pause', dict(goal_id=self.goal, status='paused'))
        self.assertFalse(gate(assigned + '/file.py')['proceed'])

    def test_cyclic_graph_rolls_back_atomically(self):
        job = self.setup_team()
        tasks = [dict(key=k, title=k, instructions='Do it', acceptance='Inspect', paths=[k], dependencies=[d]) for k, d in [('a', 'b'), ('b', 'a')]]
        with self.assertRaisesRegex(ValueError, 'cyclic'):
            self.action(self.alice, self.a_session, 'plan', revision=job['goal']['revision'], tasks=tasks)
        self.assertEqual(self.action(self.alice, self.a_session, 'state')['tasks'], [])

    def test_no_task_starts_before_independent_plan_review(self):
        job = self.setup_team()
        self.action(self.alice, self.a_session, 'plan', revision=job['goal']['revision'], tasks=[
            dict(key='a', title='A', instructions='Implement A', acceptance='Inspect A', paths=['src/a'])])
        self.assertIsNone(self.action(self.alice, self.a_session, 'poll')['assignment'])
        self.assertEqual(self.action(self.bob, self.b_session, 'poll')['assignment']['kind'], 'plan_review')
        with self.assertRaisesRegex(ValueError, 'assignment changed'):
            self.action(self.alice, self.a_session, 'plan-review', revision=1, decision='accept', note='Self approve')
        self.action(self.bob, self.b_session, 'plan-review', revision=1, decision='changes_requested', note='Conflicting requirements need a developer choice')
        self.assertEqual(self.action(self.alice, self.a_session, 'state')['goals'][0]['status'], 'paused')
        self.assertIsNone(self.action(self.alice, self.a_session, 'poll')['assignment'])

    def test_stale_plan_cannot_overwrite_new_developer_request(self):
        job = self.setup_team()
        self.action(self.bob, self.b_session, 'request', body='Also preserve accessibility')
        with self.assertRaisesRegex(ValueError, 'revision changed'):
            self.action(self.alice, self.a_session, 'plan', revision=job['goal']['revision'], tasks=[dict(key='x')])

    def test_developer_question_pauses_goal_and_plain_language_reply_reopens_planning(self):
        self.setup_team()
        question = self.action(self.alice, self.a_session, 'question', question='Should signup require an invitation?')
        self.assertIsNone(self.action(self.bob, self.b_session, 'poll')['assignment'])
        request = self.action(self.bob, self.b_session, 'request', body='Yes, invitation-only signup')
        state = self.action(self.alice, self.a_session, 'state')
        self.assertEqual(state['goals'][0]['status'], 'active')
        self.assertEqual(state['goals'][0]['revision'], 2)
        self.assertEqual(next(q for q in state['questions'] if q['id'] == question['id'])['response_request'], request['id'])

    def test_new_request_can_be_planned_when_both_workers_hold_tasks(self):
        self.propose()
        a, b = self.assignments()
        self.start(self.alice, self.a_session, a['task'])
        self.start(self.bob, self.b_session, b['task'])
        self.action(self.bob, self.b_session, 'request', body='Also add a short usage document')
        planner = self.action(self.alice, self.a_session, 'poll')['assignment']
        self.assertEqual(planner['kind'], 'plan')
        self.action(self.alice, self.a_session, 'plan', revision=2, tasks=[dict(key='docs', title='Usage', instructions='Document usage', acceptance='Inspect usage', paths=['docs/usage.txt'])])
        review = self.action(self.bob, self.b_session, 'poll')['assignment']
        self.assertEqual(review['kind'], 'plan_review')
        self.action(self.bob, self.b_session, 'plan-review', revision=2, decision='accept', note='New request covered, existing work preserved')
        resumed = self.action(self.alice, self.a_session, 'poll')['assignment']
        self.assertEqual(resumed['task']['id'], a['task']['id'])
        self.assertNotEqual(resumed['key'], a['key'])

    def test_worker_cannot_retarget_or_claim_other_worker_task(self):
        self.propose()
        a, b = self.assignments()
        with self.assertRaisesRegex(ValueError, 'another worker'):
            self.start(self.bob, self.b_session, a['task'])
        other = self.alice.action('team-create', dict(project_id=self.project, repository_key=self.key, objective='Different goal'))
        with self.assertRaisesRegex(ValueError, 'new session'):
            self.action(self.alice, self.a_session, 'enroll', goal_id=other['id'])

    def test_wrong_repository_and_forged_controller_are_rejected(self):
        self.setup_team()
        other = self.alice.action('team-create', dict(project_id=self.project, repository_key='f' * 64, objective='Different repo'))
        with self.assertRaisesRegex(ValueError, 'different project or repository'):
            self.action(self.alice, self.a_session, 'enroll', goal_id=other['id'])
        with self.assertRaisesRegex(ValueError, 'active owned live controller'):
            self.alice.action('team-poll', dict(session_id=self.a_session, instance='forged'))

    def test_artifact_hash_and_integration_receipt_are_verified(self):
        self.propose(paths=('src/a',))
        a, _ = self.assignments()
        self.start(self.alice, self.a_session, a['task'])
        artifact = dict(path='src/a', content='hello', sha256='wrong')
        with self.assertRaisesRegex(ValueError, 'hash mismatch'):
            self.action(self.alice, self.a_session, 'submit', task_id=a['task']['id'], summary='Done', evidence='Inspected', artifacts=[artifact])
        artifact['sha256'] = hashlib.sha256(b'hello').hexdigest()
        self.action(self.alice, self.a_session, 'submit', task_id=a['task']['id'], summary='Done', evidence='Inspected', artifacts=[artifact])
        review = self.action(self.bob, self.b_session, 'poll')['assignment']
        self.assertEqual(review['task']['artifacts'][0]['content'], 'hello')
        self.assertNotIn('content', self.action(self.alice, self.a_session, 'state')['tasks'][0]['artifacts'][0])
        self.action(self.bob, self.b_session, 'review', task_id=a['task']['id'], decision='accept', note='Inspected artifact')
        with self.assertRaisesRegex(ValueError, 'hashes do not match'):
            self.alice.action('team-accept', dict(goal_id=self.goal, task_id=a['task']['id'], verified_files={}, note='checked'))
        self.alice.action('team-accept', dict(goal_id=self.goal, task_id=a['task']['id'], verified_files={'src/a': artifact['sha256']}, note='Integrated and checked'))
        self.assertEqual(self.action(self.alice, self.a_session, 'state')['goals'][0]['status'], 'complete')

    def test_recovery_requires_stopped_worker_and_explicit_reconciliation(self):
        self.propose(paths=('src/a',))
        a, _ = self.assignments()
        with self.assertRaisesRegex(ValueError, 'Pause or stop'):
            self.alice.action('team-recover', dict(goal_id=self.goal, task_id=a['task']['id'], note='Reconciled'))
        self.alice.action('live-leave', dict(session_id=self.a_session, instance=self.a_session))
        self.alice.action('team-recover', dict(goal_id=self.goal, task_id=a['task']['id'], note='No edits were made'))
        self.assertEqual(self.action(self.bob, self.b_session, 'poll')['assignment']['task']['assignee'], self.b_session)

    def test_review_corrections_return_to_original_owner_and_fence_stale_attempt(self):
        self.propose(paths=('src/a',))
        a, _ = self.assignments()
        self.start(self.alice, self.a_session, a['task'])
        self.action(self.alice, self.a_session, 'submit', task_id=a['task']['id'], summary='First version', evidence='Inspected', artifacts=[])
        self.action(self.bob, self.b_session, 'poll')
        self.action(self.bob, self.b_session, 'review', task_id=a['task']['id'], decision='changes_requested', note='Acceptance criterion needs correction')
        retry = self.action(self.alice, self.a_session, 'poll')['assignment']
        self.assertEqual(retry['task']['assignee'], self.a_session)
        self.assertEqual(retry['task']['attempt'], 2)
        self.assertNotEqual(retry['key'], a['key'])
        with self.assertRaisesRegex(ValueError, 'attempt changed'):
            self.action(self.alice, self.a_session, 'start', task_id=a['task']['id'], attempt=1, base_commit='a'*40)

    def test_same_goal_messages_are_not_broadcast_to_unrelated_live_sessions(self):
        self.propose()
        a, _ = self.assignments()
        third = self.alice.action('session', dict(project_id=self.project, name='Separate live agent'))['id']
        self.alice.action('live-join', dict(session_id=third, instance=third, repository_key=self.key))
        message = self.action(self.alice, self.a_session, 'message', task_id=a['task']['id'], note='What is the agreed interface?')
        peers = self.bob.action('live-poll', dict(session_id=self.b_session, instance=self.b_session))['messages']
        other = self.alice.action('live-poll', dict(session_id=third, instance=third))['messages']
        self.assertIn(message['message_id'], [m['message_id'] for m in peers])
        self.assertNotIn(message['message_id'], [m['message_id'] for m in other])

    def test_ordinary_live_work_cannot_bypass_team_reservations(self):
        self.propose(paths=('src/shared',))
        self.assignments()
        sid = self.alice.action('session', dict(project_id=self.project, name='Ordinary live worker'))['id']
        self.alice.action('live-join', dict(session_id=sid, instance=sid, repository_key=self.key))
        plan = self.alice.action('work-plan', dict(session_id=sid, title='Legacy overlapping work', plan='Edit shared file', paths=['src/shared/file.py'], contracts=[], base_commit='a'*40))['work']
        result = self.alice.action('work-start', dict(session_id=sid, work_id=plan['id'], revision=1, base_commit='a'*40))
        self.assertFalse(result['proceed'])
        self.assertIn('team_task_reserved', [b['kind'] for b in result['blockers']])
