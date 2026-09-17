import json
import time
import unittest
from unittest.mock import patch

import test_relay
from relay.client import HubUnavailable
from relay.companion import Companion
from relay.mcp import Connector
from relay.worker import Worker, atomic_json


class ConnectionRecoveryTests(unittest.TestCase):
    setUp = test_relay.RelayIntegrationTests.setUp
    tearDown = test_relay.RelayIntegrationTests.tearDown
    repo = test_relay.RelayIntegrationTests.repo
    def worker(self):
        self.alice.action('bind', dict(session_id=self.a_session, provider='codex', source_id='fixture', title='Fixture'))
        config = dict(url=self.url, token=self.token, session_id=self.a_session,
                      project_id=self.project, repo=str(self.repo()), provider='codex',
                      source_id='fixture', share_session=True)
        path = self.directory / 'connection.json'
        atomic_json(path, config)

        class Source:
            def __init__(self, config): pass
            def snapshot(self): return dict(cursor='unchanged', events=[])
            def close(self): pass

        return Worker(path, Source)

    def test_observer_recovers_but_preserves_model_failures_and_busy_status(self):
        worker = self.worker()
        worker.status('error', HubUnavailable('Hub unavailable'), channel='observe')
        worker.observe_once()
        self.assertEqual((worker.phase, worker.error), ('watching', ''))
        worker.status('error', ValueError('Model login required'))
        worker.observe_once()
        self.assertEqual((worker.phase, worker.error), ('error', 'Model login required'))
        worker.status('summarizing')
        worker.observe_once()
        self.assertEqual(worker.phase, 'summarizing')

    def test_responder_recovers_without_new_source_turn_or_model_call(self):
        worker = self.worker()
        worker.observe_once()
        worker.last_summary = time.time()  # No model calls permitted during this test.
        worker.status('error', HubUnavailable('Hub returned 502'))
        worker.work_once()
        self.assertEqual((worker.phase, worker.error), ('watching', ''))
        worker.status('error', ValueError('Model login required'))
        worker.work_once()
        self.assertEqual(worker.error, 'Model login required')
        worker.status('error', TimeoutError('Model timed out'))
        worker.work_once()
        self.assertEqual(worker.error, 'Model timed out')
        worker.status('error', HubUnavailable('Hub unavailable'))
        worker.latest['cursor'] = ''
        worker.work_once()
        self.assertEqual((worker.phase, worker.error), ('watching', ''))

    def test_failed_capture_keeps_error_and_pending_events(self):
        worker = self.worker()
        worker.status('error', HubUnavailable('Hub unavailable'), channel='observe')
        worker.data['pending'] = [dict(key='fixture', kind='user', body='test')]
        with patch.object(worker.client, 'action', side_effect=HubUnavailable('Hub unavailable')):
            with self.assertRaises(HubUnavailable): worker.observe_once()
        self.assertEqual(worker.phase, 'error')
        self.assertEqual(len(worker.data['pending']), 1)
        worker.observe_once()
        self.assertEqual((worker.phase, worker.error), ('watching', ''))
        self.assertEqual(worker.data['pending'], [])

    def test_presence_distinguishes_worker_heartbeat_tool_use_and_offline(self):
        worker = self.worker()
        worker.observe_once()
        def session():
            return next(s for s in self.alice.request('/api/state')['sessions'] if s['id'] == self.a_session)
        self.assertFalse(session()['agent_online'])
        self.alice.action('heartbeat', dict(session_id=self.a_session))
        self.assertTrue(session()['agent_online'])
        self.assertFalse(session()['agent_tool_used'])
        connector = Connector(worker.config, self.alice)
        with self.assertRaises(ValueError): connector.call('unknown', {})
        self.assertFalse(session()['agent_tool_used'])
        connector.call('relay_project', {})
        self.assertTrue(session()['agent_tool_used'])
        self.alice.action('offline', dict(session_id=self.a_session))
        worker.observe_once()
        self.assertFalse(session()['agent_online'])
        self.assertTrue(session()['agent_tool_used'])
        with self.assertRaisesRegex(ValueError, 'Only this session'):
            self.bob.action('agent-tool-used', dict(session_id=self.a_session))

    def test_presence_expires_and_companion_exposes_it_without_secrets(self):
        worker = self.worker()
        companion = Companion(self.directory / 'local', self.url)
        target = companion.connections / 'fixture.json'
        atomic_json(target, worker.config)
        self.assertFalse(companion.state()['connections'][0]['agent_online'])
        Connector(worker.config, self.alice).call('relay_project', {})
        item = companion.state()['connections'][0]
        self.assertTrue(item['agent_online'])
        self.assertTrue(item['agent_tool_used'])
        self.assertNotIn(self.token, json.dumps(item))
        with self.store.connect() as db:
            db.execute('UPDATE agent_presence SET last_seen=?', (time.time() - 66,))
        self.assertFalse(companion.state()['connections'][0]['agent_online'])

    def test_old_hub_telemetry_failure_does_not_fail_successful_tool(self):
        worker = self.worker()
        with patch.object(self.alice, 'action', side_effect=ValueError('Unknown action')):
            result = Connector(worker.config, self.alice).call('relay_project', {})
        self.assertEqual(result['session_id'], self.a_session)
