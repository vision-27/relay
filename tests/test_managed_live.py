import hashlib
import json
import os
from pathlib import Path
import subprocess
import tempfile
import time
from types import SimpleNamespace
import unittest
from unittest.mock import patch

import test_relay
from relay.client import git_info
from relay.managed_live import LiveRuntime, destination, launch, repository_key
from relay.managed_tools import ManagedTools, safe_file
from relay.worker import atomic_json


class ManagedTests(unittest.TestCase):
    setUp = test_relay.RelayIntegrationTests.setUp
    tearDown = test_relay.RelayIntegrationTests.tearDown

    def setup_repo(self):
        repo = self.directory / 'repo'
        repo.mkdir()
        for command in [['git', 'init', str(repo)], ['git', '-C', str(repo), '-c', 'user.name=QA', '-c', 'user.email=qa@localhost',
                                                 'commit', '--allow-empty', '-m', 'fixture']]:
            subprocess.run(command, check=True, capture_output=True)
        return repo

    def managed(self, repo):
        directory = self.directory / 'private' / 'run'
        directory.mkdir(parents=True)
        config = dict(url=self.url, token=self.token, repo=str(repo), project_id=self.project,
                      session_id=self.a_session, managed_live=True, live_instance='controller', provider='codex', repository_key=repository_key(repo))
        path = directory / 'connection.json'
        atomic_json(path, config)
        atomic_json(directory / 'control.json', dict(instance='controller', active=True, network_ok=True, seen=time.time(), generation=1))
        self.alice.action('live-join', dict(session_id=self.a_session, instance='controller', repository_key=config['repository_key']))
        return path, ManagedTools(path)

    def start_plan(self, repo):
        work = self.alice.action('work-plan', dict(session_id=self.a_session, title='Fixture', plan='Write src/hello.txt',
            paths=['src'], contracts=[], base_commit=git_info(repo)['commit_sha']))['work']
        self.alice.action('work-start', dict(session_id=self.a_session, work_id=work['id'], revision=1, base_commit=git_info(repo)['commit_sha']))
        return work

    def test_guard_requires_plan_scope_and_fresh_file_then_backs_up(self):
        repo = self.setup_repo()
        path, tools = self.managed(repo)
        args = dict(path='src/hello.txt', content='first', expected_sha256='missing')
        with self.assertRaisesRegex(ValueError, 'no_started_plan'):
            tools.call('relay_write_file', args)
        self.start_plan(repo)
        with self.assertRaisesRegex(ValueError, 'outside_agreed_scope'):
            tools.call('relay_write_file', dict(args, path='other.txt'))
        tools.call('relay_write_file', args)
        self.assertEqual((repo / 'src/hello.txt').read_text(), 'first')
        with self.assertRaisesRegex(ValueError, 'File changed'):
            tools.call('relay_write_file', dict(args, content='lost update'))
        read = tools.call('relay_read_file', {'path': 'src/hello.txt'})
        tools.call('relay_write_file', dict(args, content='second', expected_sha256=read['sha256']))
        self.assertEqual(next((path.parent / 'backups').iterdir()).read_text(), 'first')

    def test_network_pause_and_new_event_block_actual_write(self):
        repo = self.setup_repo()
        path, tools = self.managed(repo)
        work = self.start_plan(repo)
        self.bob.action('work-message', dict(session_id=self.b_session, work_id=work['id'], note='Please review the contract first'))
        with self.assertRaisesRegex(ValueError, 'unacknowledged_messages'):
            tools.call('relay_write_file', dict(path='src/blocked.txt', content='bad', expected_sha256='missing'))
        self.assertFalse((repo / 'src/blocked.txt').exists())
        state = json.loads(path.with_name('control.json').read_text())
        state['network_ok'] = False
        atomic_json(path.with_name('control.json'), state)
        with self.assertRaisesRegex(ValueError, 'paused, offline'):
            tools.call('relay_read_file', dict(path='src/file.txt'))

    def test_paths_secrets_links_and_changed_head_are_rejected(self):
        repo = self.setup_repo()
        path, tools = self.managed(repo)
        self.start_plan(repo)
        for name in ['../escape', '/escape', 'C:\\escape', '.git/config', '.claude/settings.json', '.env.local', 'secret.key', 'x:stream', 'folder./file']:
            with self.assertRaises(ValueError, msg=name):
                safe_file(repo, name)
        subprocess.run(['git', '-C', str(repo), '-c', 'user.name=QA', '-c', 'user.email=qa@localhost',
                        'commit', '--allow-empty', '-m', 'changed'], check=True, capture_output=True)
        with self.assertRaisesRegex(ValueError, 'base_changed'):
            tools.call('relay_write_file', dict(path='src/file.txt', content='bad', expected_sha256='missing'))

    def test_cancel_happens_before_any_provider_or_workspace_change(self):
        args = SimpleNamespace(repo=None)
        with patch('relay.managed_live.confirm_repository', return_value=None), patch('relay.managed_live.preflight') as provider:
            launch(args)
        provider.assert_not_called()

    def test_version_reporting_failure_does_not_disable_live_coordination(self):
        repo = self.setup_repo()
        path, _ = self.managed(repo)
        output = []
        runtime = LiveRuntime(path, output=output.append)
        runtime.active = True
        with patch('relay.managed_live.release_info', side_effect=ValueError('Refusing to bundle symlinked source')):
            runtime.heartbeat_once()
            runtime.heartbeat_once()
        self.assertTrue(runtime.network_ok)
        self.assertEqual(runtime.fault, '')
        self.assertTrue(json.loads(path.with_name('control.json').read_text())['network_ok'])
        self.assertEqual(len(output), 1)
        self.assertIn('version reporting unavailable', output[0])

    def test_explicit_turn_rejection_reoffers_once_with_fresh_limits(self):
        from relay.managed_providers import TurnEndedBeforeDelivery
        from unittest.mock import Mock
        repo = self.setup_repo()
        path, _ = self.managed(repo)
        runtime = LiveRuntime(path, output=lambda *_: None)
        runtime.active = runtime.network_ok = True
        runtime.provider = SimpleNamespace(busy=True, offer=Mock(side_effect=[TurnEndedBeforeDelivery(), ['accepted']]))
        with patch.object(runtime, 'delivered') as delivered:
            runtime.offer('peer update', [{'message_id': 77}])
        self.assertEqual(runtime.provider.offer.call_count, 2)
        self.assertEqual(runtime.provider.offer.call_args_list[0], runtime.provider.offer.call_args_list[1])
        self.assertEqual(runtime.generation, 1)
        self.assertGreater(runtime.turn_started, 0)
        self.assertEqual(runtime.offered, {77})
        delivered.assert_called_once_with('accepted')

    def test_uncertain_delivery_is_not_retried_or_marked_delivered(self):
        from unittest.mock import Mock
        repo = self.setup_repo()
        path, _ = self.managed(repo)
        runtime = LiveRuntime(path)
        runtime.active = runtime.network_ok = True
        runtime.provider = SimpleNamespace(busy=True, offer=Mock(side_effect=TimeoutError('uncertain')))
        with patch.object(runtime, 'delivered') as delivered:
            with self.assertRaises(TimeoutError):
                runtime.offer('peer update', [{'message_id': 77}])
        runtime.provider.offer.assert_called_once()
        delivered.assert_not_called()
        self.assertEqual(runtime.offered, set())

    def test_dead_provider_resume_fails_before_rejoining_hub(self):
        from unittest.mock import Mock
        repo = self.setup_repo()
        path, _ = self.managed(repo)
        runtime = LiveRuntime(path)
        runtime.provider = SimpleNamespace(ensure_available=Mock(side_effect=ValueError('process stopped')))
        with patch.object(runtime, 'action') as action:
            with self.assertRaisesRegex(ValueError, 'process stopped'):
                runtime.resume()
        action.assert_not_called()
        self.assertFalse(runtime.active)

    def test_initial_offer_failure_keeps_controls_open_without_retry(self):
        from unittest.mock import MagicMock
        repo = self.setup_repo()
        args = SimpleNamespace(repo=str(repo), agent='claude')
        runtime = MagicMock()
        runtime.offer.side_effect = ValueError('Startup network failure')
        runtime.stop.wait.side_effect = lambda *_: time.sleep(.01)
        with patch('relay.managed_live.confirm_repository', return_value=str(repo)), \
             patch('relay.managed_live.preflight'), \
             patch('relay.managed_live.destination', return_value=(self.alice, {'id': self.project})), \
             patch('relay.managed_live.data_directory', return_value=self.directory / 'private' / 'companion'), \
             patch('relay.managed_live.LiveRuntime', return_value=runtime), \
             patch('builtins.input', side_effect=['Test', 'y', '/status', '/quit']), \
             patch('builtins.print') as output:
            launch(args)
        runtime.offer.assert_called_once_with('Test')
        runtime.pause.assert_called_once_with('Startup network failure')
        runtime.close.assert_called_once()
        self.assertTrue(any(call.args and call.args[0] == 'Active:' for call in output.call_args_list))
        self.assertFalse(any('Task sent' in str(call) for call in output.call_args_list))

    def test_reuses_browser_url_identity_without_editing_existing_connections(self):
        repo = self.setup_repo()
        private = self.directory / 'companion'
        private.mkdir()
        content = json.dumps(dict(url=self.url, token=self.token))
        (private / 'workspace.json').write_text(content)
        args = SimpleNamespace(url=None, project=self.project, token_file=None)
        with patch('relay.managed_live.data_directory', return_value=private), patch('relay.managed_live.session_directory', return_value=self.directory / 'cli'), patch('builtins.input', side_effect=AssertionError('No prompt expected')):
            client, project = destination(args, repo)
        self.assertEqual(client.url, self.url)
        self.assertEqual((private / 'workspace.json').read_text(), content)

    def test_native_provider_commands_create_fresh_sources_and_restrict_tools(self):
        from relay.managed_providers import ClaudeWorking, CodexWorking
        repo = self.setup_repo()
        path, tools = self.managed(repo)
        claude = ClaudeWorking(repo, path, executable='claude')
        command = claude.command()
        self.assertIn('--session-id', command)
        self.assertNotIn('--resume', command)
        self.assertIn('--restricted', command)
        self.assertIn('--strict-mcp-config', command)
        self.assertEqual(command[command.index('--tools') + 1], '')
        self.assertNotIn('--dangerously-skip-permissions', command)
        class RPC:
            def __init__(self, *args): self.requests = []
            def request(self, method, data):
                self.requests.append((method, data))
                if method == 'config/read': return {'config': {'mcp_servers': {'unrelated': {}}}}
                if method == 'thread/start': return {'thread': {'id': 'brand-new'}, 'sandbox': {'type': 'readOnly'}, 'cwd': str(repo)}
                if method == 'turn/start': return {'turn': {'id': 'new-turn'}}
                return {}
            def close(self): pass
        with patch('relay.managed_providers.ManagedRPC', RPC):
            codex = CodexWorking(repo, path, tools.call, executable='codex')
            codex.offer('User task', 'receipt')
            codex.offer('Peer data', 'receipt2')
            self.assertEqual([x[0] for x in codex.rpc.requests], ['config/read', 'thread/start', 'turn/start', 'turn/steer'])
            self.assertFalse(codex.rpc.requests[1][1]['config']['mcp_servers.unrelated.enabled'])
            self.assertEqual(codex.source_id, 'brand-new')

    def test_runtime_wakes_idle_agent_and_does_not_ack_on_delivery(self):
        repo = self.setup_repo()
        path, tools = self.managed(repo)
        class Fake:
            source_id = 'new-owned-source'
            busy = False
            def __init__(self, *args): self.offers = []; self.stopped = False
            def offer(self, text, receipt): self.offers.append(text); return [receipt]
            def poll(self): return []
            def interrupt(self): self.stopped = True
            def close(self): self.stopped = True
        runtime = LiveRuntime(path, provider_factory=Fake, output=lambda *args: None)
        try:
            runtime.connect()
            runtime.task_started = True
            runtime.offer('Work on the assigned feature')
            work = self.start_plan(repo)
            self.bob.action('work-message', dict(session_id=self.b_session, work_id=work['id'], note='Please use interface v2'))
            runtime.events = runtime.action('poll')['messages']
            runtime.tick()
            runtime.tick()
            self.assertEqual(len(runtime.provider.offers), 2)
            messages = runtime.action('poll')['messages']
            self.assertGreater(messages[0]['delivered'], 0)
            self.assertEqual(messages[0]['acknowledged'], 0)
            runtime.pause()
            self.assertFalse(json.loads(path.with_name('control.json').read_text())['active'])
        finally:
            runtime.close()

    def test_expired_control_and_controller_mismatch_deny_tools(self):
        repo = self.setup_repo()
        path, tools = self.managed(repo)
        for extra in [{'seen': 0}, {'instance': 'foreign'}, {'active': False}]:
            state = dict(instance='controller', active=True, network_ok=True, seen=time.time(), generation=1, **{})
            state.update(extra)
            atomic_json(path.with_name('control.json'), state)
            with self.assertRaisesRegex(ValueError, 'paused, offline'):
                tools.call('relay_files', {})

    def test_human_release_does_not_start_a_model_or_change_files(self):
        from relay.managed_live import release
        repo = self.setup_repo()
        path, tools = self.managed(repo)
        work = self.start_plan(repo)
        args = SimpleNamespace(run=str(path))
        with patch('relay.managed_live.confirm_repository', return_value=str(repo)):
            with self.assertRaisesRegex(ValueError, 'Stop or pause'):
                release(args)
            self.alice.action('live-leave', dict(session_id=self.a_session, instance='controller'))
            with patch('builtins.input', side_effect=['Changes cancelled; no file edits were made', 'y']):
                release(args)
        state = self.alice.request('/api/state')['coordination']
        self.assertEqual(next(p for p in state['plans'] if p['id'] == work['id'])['status'], 'released')
