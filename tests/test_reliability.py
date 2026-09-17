import json
from io import BytesIO
import os
from pathlib import Path
import plistlib
import signal
import subprocess
import sys
import tempfile
import time
import unittest
from unittest.mock import patch
from zipfile import ZipFile, ZIP_STORED, ZIP_DEFLATED

import test_relay
from relay.client import Client, HubUnavailable
from relay.companion import runtime
from relay.lifecycle import startup_spec, configure_startup, startup_status, stop, running
from relay.processes import background_options
from relay.reliability import release_info, team_check, build_identity
from relay.worker import atomic_json, Worker
from relay.adapters import event, SUMMARY_SCHEMA


class ReadinessTests(unittest.TestCase):
    setUp = test_relay.RelayIntegrationTests.setUp
    tearDown = test_relay.RelayIntegrationTests.tearDown
    repo = test_relay.RelayIntegrationTests.repo

    def test_two_worker_roundtrip_after_failed_upload_restart_and_pause(self):
        repo = self.repo()
        facts = {self.a_session: 'Cache keys include organisation ID.', self.b_session: 'Billing retries use idempotency keys.'}
        class Source:
            def __init__(self, config): self.sid = config['session_id']
            def snapshot(self):
                return dict(cursor=facts[self.sid], source_ref='fixture/'+self.sid,
                    events=[event(facts[self.sid], 'assistant', facts[self.sid], 'fixture/'+self.sid)])
            def explain(self, prompt, schema, snapshot):
                data = {k: '' for k in schema['required']}
                if schema == SUMMARY_SCHEMA: data.update(title='QA decision', summary=facts[self.sid])
                else: data.update(answer=facts[self.sid], evidence=snapshot['source_ref'])
                return dict(data=data, source_ref=snapshot['source_ref'], response_session='qa-read-only-fork')
            def close(self): pass
        workers, features = [], []
        for client, sid in [(self.alice, self.a_session), (self.bob, self.b_session)]:
            features.append(client.action('bind', dict(session_id=sid, provider='codex', source_id='fixture-'+sid, title='QA'))['id'])
            path = self.directory / (sid+'.json')
            atomic_json(path, dict(url=self.url, token=client.token, project_id=self.project, session_id=sid,
                repo=str(repo), provider='codex', source_id='fixture-'+sid, share_session=True, summary_interval=0))
            worker = Worker(path, Source)
            worker.observe_once(); worker.work_once(); workers.append(worker)
        facts[self.a_session] += ' Permission version is also included.'
        with patch.object(workers[0].client, 'action', side_effect=HubUnavailable('Offline fixture')):
            with self.assertRaises(HubUnavailable): workers[0].observe_once()
        self.assertEqual(len(workers[0].data['pending']), 1)
        question = self.bob.action('question', dict(feature_id=features[0], body='Why this cache key?'))
        restored = Worker(workers[0].config_path, Source)
        restored.observe_once(); restored.work_once()
        self.assertEqual(restored.data['pending'], [])
        answer = next(q for q in self.bob.request('/api/state')['questions'] if q['id'] == question['id'])
        self.assertIn('Permission version', answer['answer'])
        self.assertIn('fixture/', answer['evidence'])
        reverse = self.alice.action('question', dict(feature_id=features[1], body='Why retry keys?'))
        workers[1].work_once()
        answer = next(q for q in self.alice.request('/api/state')['questions'] if q['id'] == reverse['id'])
        self.assertIn('idempotency', answer['answer'])
        self.bob.action('session-toggle', dict(session_id=self.b_session, enabled=False))
        paused = Worker(workers[1].config_path, Source)
        paused.observe_once()
        before = len(paused.data['calls'])
        paused.work_once()
        self.assertFalse(paused.enabled)
        self.assertEqual(len(paused.data['calls']), before)

    def prepare(self, client, sid):
        client.action('bind', dict(session_id=sid, provider='codex', source_id='fixture-'+sid, title='QA'))
        client.action('auto-context', dict(session_id=sid, source_cursor='fixture', title='QA', summary='Recorded QA decision'))
        client.action('worker-status', dict(session_id=sid, status='watching', release=release_info()))
        client.action('heartbeat', dict(session_id=sid, release=release_info()))
        client.action('agent-tool-used', dict(session_id=sid, release=release_info()))

    def check(self):
        return team_check(self.alice.request('/api/state'), self.project)

    def test_two_distinct_people_matching_builds_and_verified_tools(self):
        self.prepare(self.alice, self.a_session)
        self.assertFalse(self.check()['ready'])
        self.prepare(self.bob, self.b_session)
        self.assertTrue(self.check()['ready'])
        self.bob.action('worker-status', dict(session_id=self.b_session, status='watching'))
        result = self.check()
        self.assertFalse(result['ready'])
        self.assertIn('Update/reopen Relay', str(result))

    def test_same_person_two_sessions_does_not_count_as_two_people(self):
        other = self.alice.action('session', dict(project_id=self.project, name='Second agent'))['id']
        self.prepare(self.alice, self.a_session)
        self.prepare(self.alice, other)
        self.assertFalse(self.check()['ready'])

    def test_offline_pause_revocation_mismatched_hub_and_agent_build_fail_closed(self):
        self.prepare(self.alice, self.a_session)
        self.prepare(self.bob, self.b_session)
        state = self.alice.request('/api/state')
        self.assertFalse(team_check(state, self.project, dict(release_info(), build='0'*64))['ready'])
        self.bob.action('heartbeat', dict(session_id=self.b_session, release=dict(release_info(), build='1'*64)))
        self.assertFalse(self.check()['ready'])
        self.bob.action('heartbeat', dict(session_id=self.b_session, release=release_info()))
        self.bob.action('offline', dict(session_id=self.b_session))
        self.assertFalse(self.check()['ready'])
        self.bob.action('heartbeat', dict(session_id=self.b_session, release=release_info()))
        self.bob.action('session-toggle', dict(session_id=self.b_session, enabled=False))
        self.assertFalse(self.check()['ready'])
        self.alice.action('revoke', dict(member_id=self.bob_id))
        self.assertEqual(len(self.check()['participants']), 1)


class StartupTests(unittest.TestCase):
    def test_build_identity_is_independent_of_zip_compression_and_order(self):
        payloads = []
        for compression, names in [(ZIP_STORED, ['a', 'b']), (ZIP_DEFLATED, ['b', 'a'])]:
            stream = BytesIO()
            with ZipFile(stream, 'w', compression=compression) as archive:
                for name in names: archive.writestr(name, name * 100)
            payloads.append(stream.getvalue())
        self.assertNotEqual(payloads[0], payloads[1])
        self.assertEqual(build_identity(payloads[0]), build_identity(payloads[1]))

    def test_native_descriptors_are_quiet_login_only_and_have_no_credentials(self):
        with tempfile.TemporaryDirectory() as tmp:
            with patch('relay.lifecycle.command', return_value=['/safe path/python', '/safe path/launch.py']):
                mac = startup_spec(tmp, platform='darwin', home=tmp)
                data = plistlib.loads(mac['value'].encode())
                self.assertTrue(data['RunAtLoad'])
                self.assertFalse(data['KeepAlive'])  # Quit must not immediately relaunch.
                self.assertIn('background', data['ProgramArguments'])
                linux = startup_spec(tmp, platform='linux', home=tmp)
                self.assertIn('Terminal=false', linux['value'])
                self.assertIn('"/safe path/python"', linux['value'])
                windows = startup_spec(tmp, platform='win32')
                self.assertIn('background', windows['value'])
                self.assertLessEqual(len(windows['value']), 260)
                for value in [mac['value'], linux['value'], windows['value']]:
                    self.assertNotIn('token', value.lower())

    def test_explicit_enable_disable_preserves_foreign_registration(self):
        with tempfile.TemporaryDirectory() as tmp:
            spec = dict(kind='file', path=str(Path(tmp)/'autostart/relay.desktop'), value='managed fixture')
            with patch('relay.lifecycle.startup_spec', return_value=spec):
                self.assertFalse(startup_status(tmp))
                self.assertTrue(configure_startup(tmp, True)['enabled'])
                self.assertTrue(startup_status(tmp))
                self.assertFalse(configure_startup(tmp, False)['enabled'])
                Path(spec['path']).write_text('someone else')
                with self.assertRaisesRegex(ValueError, 'outside Relay'):
                    configure_startup(tmp, True)
                self.assertEqual(Path(spec['path']).read_text(), 'someone else')

    def test_supervisor_recovers_real_child_crash_and_honors_quit(self):
        with tempfile.TemporaryDirectory() as tmp:
            directory = Path(tmp)
            atomic_json(directory/'desktop-control.json', {'run': True})
            process = subprocess.Popen([sys.executable, '-m', 'relay', 'supervise', '--data', tmp, '--kind', 'desktop'],
                stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, **background_options())
            seen_children = set()
            def wait_ready(previous=None):
                until = time.monotonic() + 25
                while time.monotonic() < until:
                    value = runtime(directory)
                    path = directory/'desktop-supervisor.json'
                    if value and path.exists():
                        state = json.loads(path.read_text())
                        pid = state.get('child_pid')
                        if pid: seen_children.add(pid)
                        if pid and pid != previous: return value, pid
                    time.sleep(.2)
                self.fail('Supervisor did not restore local app')
            try:
                value, first = wait_ready()
                # Only terminate the fixture child created by our owned supervisor.
                os.kill(first, signal.SIGTERM)
                value, second = wait_ready(first)
                self.assertNotEqual(first, second)
                client = Client(value['origin'], value['capability'])
                self.assertTrue(client.request('/api/quit', {})['ok'])
                process.wait(timeout=15)
                self.assertFalse(json.loads((directory/'desktop-control.json').read_text())['run'])
                self.assertIsNone(runtime(directory))
                self.assertFalse(running(directory, 'desktop'))
            finally:
                stop(directory)
                value = runtime(directory)
                if value:
                    Client(value['origin'], value['capability']).request('/api/quit', {})
                if process.poll() is None:
                    process.terminate()
                    process.wait(timeout=10)
