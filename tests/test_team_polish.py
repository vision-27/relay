"""Regressions from the physical Windows/Mac trials; isolated hubs only."""
import json
import threading
import time
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch

from relay.client import HubUnavailable
from relay.managed_live import LiveRuntime
from relay.team_cli import is_shell_command
from test_managed_live import ManagedTests
from test_team import TeamTests


class DeliveryPolishTests(unittest.TestCase):
    setUp = TeamTests.setUp
    tearDown = TeamTests.tearDown
    action = TeamTests.action
    setup_team = TeamTests.setup_team
    propose = TeamTests.propose
    assignments = TeamTests.assignments
    drain = TeamTests.drain
    start = TeamTests.start

    def test_old_deliveries_stay_auditable_but_do_not_gate_new_goal(self):
        self.propose()
        legacy = self.alice.action('session', {'project_id': self.project, 'name': 'Old session'})['id']
        with self.store.connect() as db:
            mid = db.execute("INSERT INTO work_messages(project_id,work_id,session_id,kind,body,created) VALUES(?,NULL,?,'note','Old unrelated traffic',?)", (self.project, legacy, time.time())).lastrowid
            db.execute('INSERT INTO live_deliveries(message_id,session_id) VALUES(?,?)', (mid, self.a_session))
        self.drain(self.alice, self.a_session)
        a, _ = self.assignments()
        self.start(self.alice, self.a_session, a['task'])
        gate = self.alice.action('live-gate', dict(session_id=self.a_session, instance=self.a_session, path=a['task']['paths'][0], base_commit='a'*40))
        self.assertTrue(gate['proceed'], gate)
        with self.store.connect() as db:
            self.assertEqual(db.execute('SELECT acknowledged FROM live_deliveries WHERE message_id=?', (mid,)).fetchone()[0], 0)

    def test_goal_messages_retain_delivery_ack_gate_and_session_identity(self):
        self.propose()
        self.drain(self.alice, self.a_session)
        a, _ = self.assignments()
        mid = self.action(self.bob, self.b_session, 'message', task_id=a['task']['id'], note='Check the exact byte contract')['message_id']
        messages = self.alice.action('live-poll', dict(session_id=self.a_session, instance=self.a_session))['messages']
        message = next(m for m in messages if m['message_id'] == mid)
        self.assertEqual(message['author_session'], self.b_session)
        self.assertEqual(message['acknowledged'], 0)
        self.start(self.alice, self.a_session, a['task'])
        gate = self.alice.action('live-gate', dict(session_id=self.a_session, instance=self.a_session, path=a['task']['paths'][0], base_commit='a'*40))
        self.assertIn('unacknowledged_messages', [x['kind'] for x in gate['blockers']])
        self.drain(self.alice, self.a_session)
        self.assertEqual(self.alice.action('live-poll', dict(session_id=self.a_session, instance=self.a_session))['messages'], [])

    def test_different_goals_do_not_receive_join_events(self):
        self.setup_team()
        self.drain(self.alice, self.a_session)
        other = self.alice.action('team-create', dict(project_id=self.project, repository_key=self.key, objective='Other goal'))['id']
        sid = self.alice.action('session', dict(project_id=self.project, name='Other worker'))['id']
        self.alice.action('live-join', dict(session_id=sid, instance=sid, repository_key=self.key))
        self.action(self.alice, sid, 'enroll', goal_id=other)
        self.assertEqual(self.alice.action('live-poll', dict(session_id=self.a_session, instance=self.a_session))['messages'], [])

    def test_same_goal_join_is_delivered_after_enrollment(self):
        self.setup_team()
        messages = self.alice.action('live-poll', dict(session_id=self.a_session, instance=self.a_session))['messages']
        self.assertTrue(any(m['kind'] == 'participant joined' and m['author_session'] == self.b_session for m in messages))

    def test_combined_poll_renews_expired_lease_and_returns_current_assignment(self):
        self.setup_team()
        with self.store.connect() as db:
            db.execute('UPDATE live_runtimes SET seen=0 WHERE session_id=?', (self.a_session,))
        result = self.alice.action('live-poll', dict(session_id=self.a_session, instance=self.a_session))
        self.assertEqual(result['team']['summary']['id'], self.goal)
        self.assertEqual(result['team']['assignment']['kind'], 'plan')
        self.assertEqual(self.action(self.alice, self.a_session, 'state')['goals'][0]['id'], self.goal)

    def test_old_plan_revision_is_rejected_then_new_review_can_proceed(self):
        self.setup_team()
        graph = [dict(key='one', title='One', instructions='Create one', acceptance='Exact bytes', paths=['one.txt'])]
        self.action(self.alice, self.a_session, 'plan', revision=1, tasks=graph)
        self.action(self.bob, self.b_session, 'poll')
        self.action(self.bob, self.b_session, 'request', body='Keep the same scope')
        with self.assertRaisesRegex(ValueError, 'assignment changed'):
            self.action(self.bob, self.b_session, 'plan-review', revision=1, decision='accept', note='Old')
        job = self.action(self.alice, self.a_session, 'poll')['assignment']
        self.action(self.alice, self.a_session, 'plan', revision=job['goal']['revision'], tasks=graph)
        job = self.action(self.bob, self.b_session, 'poll')['assignment']
        self.assertEqual(job['goal']['revision'], 2)
        self.action(self.bob, self.b_session, 'plan-review', revision=2, decision='accept', note='Current graph accepted')


class RuntimePolishTests(unittest.TestCase):
    setUp = ManagedTests.setUp
    tearDown = ManagedTests.tearDown
    setup_repo = ManagedTests.setup_repo
    managed = ManagedTests.managed

    def runtime(self):
        path, tools = self.managed(self.setup_repo())
        self.output = []
        r = LiveRuntime(path, output=self.output.append)
        r.active = r.network_ok = True
        r.provider = SimpleNamespace(busy=False, offer=Mock(return_value=[]), poll=Mock(return_value=[]), interrupt=Mock())
        return r, tools

    def test_outage_closes_guard_and_reconnect_does_not_replay_model(self):
        r, tools = self.runtime()
        r.team_offered.add('previous-assignment')
        r.network_lost(HubUnavailable('test outage'))
        with self.assertRaisesRegex(ValueError, 'paused, offline'):
            tools.call('relay_files', {})
        r.tick()
        r.provider.poll.assert_not_called()
        r.heartbeat_once()
        self.assertTrue(r.network_ok)
        self.assertTrue(r.active)
        self.assertEqual(r.team_offered, {'previous-assignment'})
        r.provider.offer.assert_not_called()
        self.assertEqual(r.fault, '')
        self.assertTrue(any('reconnected' in x for x in self.output))

    def test_explicit_pause_cannot_be_undone_by_delayed_heartbeat(self):
        r, tools = self.runtime()
        r.pause()
        with patch.object(r, 'action', return_value={'messages': []}):
            r.heartbeat_once()
        self.assertFalse(r.active)
        with self.assertRaisesRegex(ValueError, 'paused, offline'):
            tools.call('relay_files', {})
        r.provider.offer.assert_not_called()

    def test_transport_retry_is_only_for_delivery_receipt_not_model_turn(self):
        r, _ = self.runtime()
        r.receipts['receipt'] = [7]
        with patch.object(r, 'action', side_effect=HubUnavailable('timeout')):
            with self.assertRaises(HubUnavailable): r.delivered('receipt')
        self.assertIn('receipt', r.delivery_pending)
        with patch.object(r, 'action', return_value={'ok': True}) as action:
            r.tick()
        action.assert_called_once_with('delivered', message_id=7)
        self.assertFalse(r.delivery_pending)
        r.provider.offer.assert_not_called()

    def test_sleep_wake_waits_for_fresh_heartbeat_before_team_operations(self):
        r, _ = self.runtime()
        r.seen = time.time() - 31
        r.automation = SimpleNamespace(cancel=threading.Event(), tick=Mock())
        r.tick()
        self.assertTrue(r.active)
        self.assertFalse(r.network_ok)
        r.automation.tick.assert_not_called()
        r.provider.poll.assert_not_called()
        r.heartbeat_once()
        r.tick()
        self.assertTrue(r.network_ok)
        r.automation.tick.assert_called_once()

    def test_completed_goal_does_not_wake_model_or_spend_event_budget(self):
        r, _ = self.runtime()
        r.team_summary = dict(status='complete', tasks=[dict(status='complete')])
        r.events = [dict(message_id=10)]
        r.task_started = True
        r.auto_turns = [time.time()] * 12
        r.tick(); r.tick()
        r.provider.offer.assert_not_called()
        self.assertTrue(r.active)
        self.assertEqual(len(self.output), 1)
        self.assertIn('1/1 tasks complete', self.output[0])

    def test_file_guard_rejects_sleep_staleness_before_controller_tick(self):
        from relay.worker import atomic_json
        r, tools = self.runtime()
        r.seen = time.time() - 31
        r.save_control()
        with self.assertRaisesRegex(ValueError, 'paused, offline'):
            tools.call('relay_files', {})
        r.heartbeat_once()
        tools.call('relay_files', {})
        r.provider.offer.assert_not_called()
        # A resumed network must not grant a deliberately paused local guard.
        state = json.loads(r.path.with_name('control.json').read_text())
        state['active'] = False
        atomic_json(r.path.with_name('control.json'), state)
        with self.assertRaisesRegex(ValueError, 'paused, offline'):
            tools.call('relay_files', {})

    def test_repeated_disconnects_keep_controller_and_do_not_reoffer_work(self):
        r, tools = self.runtime()
        identity = (r.config['session_id'], r.config['live_instance'])
        r.team_offered.add('already-accepted-assignment')
        r.offered.add(123)
        for _ in range(3):
            r.network_lost(HubUnavailable('injected network interruption'))
            r.tick()
            with self.assertRaisesRegex(ValueError, 'paused, offline'):
                tools.call('relay_files', {})
            r.heartbeat_once()
            tools.call('relay_files', {})
            self.assertEqual((r.config['session_id'], r.config['live_instance']), identity)
            self.assertEqual(r.team_offered, {'already-accepted-assignment'})
            self.assertEqual(r.offered, {123})
            self.assertEqual(r.network_failures, 0)
        r.provider.offer.assert_not_called()
        r.provider.interrupt.assert_not_called()

    def test_pause_during_outage_survives_restored_connectivity(self):
        r, tools = self.runtime()
        r.network_lost(HubUnavailable('injected network interruption'))
        with patch.object(r, 'action', side_effect=HubUnavailable('still offline')):
            r.pause()
        with patch.object(r, 'action', return_value={'messages': []}):
            r.heartbeat_once()
        r.tick()
        self.assertFalse(r.active)
        with self.assertRaisesRegex(ValueError, 'paused, offline'):
            tools.call('relay_files', {})
        r.provider.offer.assert_not_called()

    def test_combined_poll_avoids_second_request_and_throttles_reporting(self):
        r, _ = self.runtime()
        r.config['team_goal_id'] = 'goal'
        data = dict(messages=[], team=dict(assignment=None, summary=dict(status='complete', tasks=[])))
        with patch.object(r, 'action', return_value=data), patch.object(r.client, 'action') as call, patch('relay.managed_live.release_info', return_value={'version': 'test'}) as release:
            r.heartbeat_once(); r.heartbeat_once()
        self.assertEqual(call.call_count, 1)
        self.assertEqual(call.call_args.args[0], 'heartbeat')
        release.assert_called_once()

    def test_shell_commands_are_not_goal_requirements(self):
        for value in ('relay-workspace team --agent', 'claude --goal abc', '--goal abc', 'python F:/cowork/relay/launch.py team', 'brew update && brew upgrade relay/workspace/relay-workspace'):
            self.assertTrue(is_shell_command(value), value)
        for value in ('Build the report', 'Add a Claude integration', 'Test'):
            self.assertFalse(is_shell_command(value), value)

    def test_real_http_outage_reconnects_same_controller_without_model_replay(self):
        from relay.store import Problem
        r, tools = self.runtime()
        fake = r.provider
        fake.source_id = 'new-qa-conversation'
        fake.close = Mock()
        r.provider_factory = lambda *args: fake
        unavailable = threading.Event()
        unavailable.set()
        mutate = self.store.mutate
        def flaky(action, data, member):
            if action == 'live-poll' and unavailable.is_set():
                raise Problem('QA injected temporary outage', 503)
            return mutate(action, data, member)
        def until(predicate, seconds):
            deadline = time.monotonic() + seconds
            while not predicate() and time.monotonic() < deadline:
                time.sleep(.02)
            self.assertTrue(predicate())
        with patch.object(self.store, 'mutate', side_effect=flaky):
            try:
                r.connect()
                until(lambda: r.network_failures > 0, 5)
                # The counter changes before save_control completes. Observe
                # the completed transition, not an unsynchronized intermediate.
                with r.lock:
                    self.assertFalse(r.network_ok)
                    self.assertTrue(r.active)
                    with self.assertRaisesRegex(ValueError, 'paused, offline'):
                        tools.call('relay_files', {})
                unavailable.clear()
                # The heartbeat persists the guard inside its lock before
                # announcing reconnection; observe that completed boundary.
                until(lambda: any('reconnected to the same session' in line for line in self.output), 10)
                self.assertEqual(r.config['live_instance'], 'controller')
                self.assertEqual(r.provider.source_id, 'new-qa-conversation')
                self.assertEqual(r.fault, '')
                fake.offer.assert_not_called()
                fake.interrupt.assert_not_called()
                tools.call('relay_files', {})
            finally:
                r.close()


# Imported fixture classes are not additional tests in this module.
del ManagedTests, TeamTests
