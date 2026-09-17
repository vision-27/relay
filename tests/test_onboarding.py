import contextlib
import io
import json
import os
from pathlib import Path
import subprocess
import sys
from types import SimpleNamespace
import unittest
from unittest.mock import patch

import test_relay
from relay import onboarding


class OnboardingTests(unittest.TestCase):
    repo=test_relay.RelayIntegrationTests.repo

    def setUp(self):
        test_relay.RelayIntegrationTests.setUp(self)
        self.private_patch = patch('relay.companion.data_directory', return_value=self.directory/'private/companion')
        self.private_patch.start()

    def tearDown(self):
        self.private_patch.stop()
        test_relay.RelayIntegrationTests.tearDown(self)

    @contextlib.contextmanager
    def directory_context(self):
        previous=Path.cwd()
        os.chdir(self.directory)
        try:yield
        finally:os.chdir(previous)

    def args(self):
        return SimpleNamespace(url=self.url,project=self.project,token_file=str(self.directory/'hub'/'owner-token'),setup_only=True,repo=str(self.directory/'repo'))

    def run_setup(self, consent='y'):
        repo=self.repo()
        class Source:
            def snapshot(self):return {'cursor':'turn-1','events':[]}
            def close(self):pass
        with self.directory_context(), patch.dict(os.environ,{'RELAY_TOKEN':''}), \
             patch('builtins.input',side_effect=['y','1','1','Authentication',consent]), \
             patch('relay.onboarding.shutil.which',return_value='codex'), \
             patch('relay.onboarding.client.discover_sessions',return_value=[{'id':'source-1','name':'Auth session'}]), \
             patch('relay.adapters.adapter',return_value=Source()), contextlib.redirect_stdout(io.StringIO()) as output:
            path=onboarding.start(self.args())
        return path,output.getvalue()

    def test_guided_setup_registers_selected_source_without_token_in_output(self):
        path,output=self.run_setup()
        config=json.loads(path.read_text())
        self.assertEqual(config['source_id'],'source-1')
        self.assertEqual(config['provider'],'codex')
        self.assertNotIn(self.token,output)
        self.assertIn('mcp',output)
        self.assertIn('launch.py',output)
        self.assertEqual(len(self.alice.request('/api/state')['bindings']),1)
        self.assertEqual(len(self.alice.request('/api/state')['observations']),0)

    def test_declining_sharing_creates_nothing(self):
        path,output=self.run_setup('n')
        self.assertIsNone(path)
        self.assertFalse((self.directory/'.relay/connections').exists())
        self.assertEqual(self.alice.request('/api/state')['bindings'],[])
        self.assertIn('Cancelled',output)

    def test_resume_reuses_config_without_discovery(self):
        path,_=self.run_setup()
        with self.directory_context(),patch('builtins.input',side_effect=['y','1']), \
             patch('relay.onboarding.client.discover_sessions') as discover, \
             contextlib.redirect_stdout(io.StringIO()):
            self.assertEqual(onboarding.start(self.args()),path)
        discover.assert_not_called()
        self.assertEqual(len(self.alice.request('/api/state')['bindings']),1)

    def test_paused_connection_is_not_silently_resumed(self):
        path,_=self.run_setup()
        config=json.loads(path.read_text())
        self.alice.action('session-toggle',dict(session_id=config['session_id'],enabled=False))
        with self.directory_context(),patch('builtins.input',side_effect=['y','1']),contextlib.redirect_stdout(io.StringIO()):
            with self.assertRaisesRegex(ValueError,'paused'):
                onboarding.start(self.args())

    def test_start_remembers_remote_workspace_without_reentering_url(self):
        path,_=self.run_setup()
        args=self.args();args.url=None;args.project=None;args.token_file=None
        with self.directory_context(),patch('builtins.input',side_effect=['y','1']),contextlib.redirect_stdout(io.StringIO()):
            self.assertEqual(onboarding.start(args),path)
        saved=json.loads((onboarding.session_directory(self.directory/'repo')/'workspace.json').read_text())
        self.assertEqual(saved,{'url':self.url,'project_id':self.project})
        self.assertNotIn(self.token,json.dumps(saved))

    def test_explicit_hub_does_not_reuse_previous_project(self):
        self.run_setup()
        args=self.args();args.url='https://different.example';args.project=None
        with self.directory_context():
            self.assertEqual(onboarding.workspace_defaults(args),('https://different.example',None))

    def test_guided_setup_starts_watcher(self):
        path,_=self.run_setup()
        args=self.args();args.setup_only=False
        with self.directory_context(),patch('builtins.input',side_effect=['y','1']), \
             patch('relay.onboarding.worker.watch') as watch,contextlib.redirect_stdout(io.StringIO()):
            onboarding.start(args)
        self.assertEqual(watch.call_args[0][0].config,str(path))

    def test_entrypoint_works_outside_relay_directory(self):
        entry=Path(onboarding.__file__).with_name('launch.py')
        result=subprocess.run([sys.executable,str(entry),'--help'],cwd=self.directory,capture_output=True,text=True,timeout=10)
        self.assertEqual(result.returncode,0,result.stderr)
        self.assertIn('start',result.stdout)

    def second_repo(self):
        target = self.directory/'different repo'
        subprocess.run(['git', 'clone', '--local', str(self.directory/'repo'), str(target)], check=True, capture_output=True)
        return target

    def test_cancel_root_confirmation_does_not_contact_hub_or_write_state(self):
        self.repo()
        with self.directory_context(), patch('builtins.input', return_value='q'), \
                patch('relay.onboarding.client.Client.request') as request, contextlib.redirect_stdout(io.StringIO()):
            self.assertIsNone(onboarding.start(self.args()))
        request.assert_not_called()
        self.assertFalse((self.directory/'private').exists())

    def test_cli_entrypoint_confirms_explicit_root_before_unreachable_hub(self):
        repo = self.repo()
        entry = Path(onboarding.__file__).with_name('launch.py')
        result = subprocess.run([sys.executable, str(entry), 'start', '--repo', str(repo),
            '--url', 'http://127.0.0.1:1', '--setup-only'], input='q\n', cwd=self.directory,
            capture_output=True, text=True, timeout=15)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn('Is this the right folder root?', result.stdout)
        self.assertIn('Cancelled', result.stdout)
        self.assertNotIn('Workspace access token', result.stdout)

    def test_current_subfolder_is_normalized_and_confirmation_is_not_skipped(self):
        repo = self.repo()
        sub = repo/'src'; sub.mkdir()
        args = self.args(); args.repo = None
        with self.directory_context():
            os.chdir(sub)
            with patch('builtins.input', return_value='y') as prompt, \
                    patch('relay.onboarding.start_in_repository', side_effect=lambda *a: Path.cwd()) as start, \
                    contextlib.redirect_stdout(io.StringIO()) as output:
                self.assertEqual(onboarding.start(args), repo)
            self.assertEqual(Path.cwd(), sub)
        self.assertIn('right folder root', prompt.call_args[0][0])
        self.assertEqual(start.call_args[0][2], str(repo))
        self.assertIn(str(repo), output.getvalue())

    def test_switch_root_creates_a_separate_session_without_retargeting_old_one(self):
        first, _ = self.run_setup()
        previous = first.read_bytes()
        second = self.second_repo()
        class Source:
            def snapshot(self): return {'cursor': 'turn-2', 'events': []}
            def close(self): pass
        with self.directory_context(), patch('builtins.input', side_effect=['n', str(second/'auth.py'), str(second), 'y', '1', '1', 'Other feature', 'y']), \
                patch('relay.onboarding.shutil.which', return_value='codex'), \
                patch('relay.onboarding.client.discover_sessions', return_value=[{'id': 'source-2', 'name': 'Other conversation'}]) as discover, \
                patch('relay.adapters.adapter', return_value=Source()), contextlib.redirect_stdout(io.StringIO()):
            result = onboarding.start(self.args())
            self.assertEqual(Path.cwd(), self.directory)
        self.assertEqual(first.read_bytes(), previous)
        self.assertEqual(json.loads(result.read_text())['repo'], str(second))
        self.assertEqual(discover.call_args[0], ('codex', str(second)))
        self.assertNotEqual(first.parent, result.parent)
        self.assertFalse((second/'.relay').exists())
        self.assertFalse((self.directory/'repo/.relay').exists())

    def test_resume_filters_saved_connections_from_other_checkout(self):
        path, _ = self.run_setup()
        other = self.second_repo()
        wrong = json.loads(path.read_text()); wrong.update(repo=str(other), session_id='wrong-root')
        (path.parent/'foreign.json').write_text(json.dumps(wrong))
        with self.directory_context(), patch('builtins.input', side_effect=['y', '1']), \
                contextlib.redirect_stdout(io.StringIO()) as output:
            self.assertEqual(onboarding.start(self.args()), path)
        self.assertNotIn('wrong-root', output.getvalue())
        self.assertNotIn(str(other), output.getvalue())
        self.assertIn('Repository root for this shared session', output.getvalue())

    def test_legacy_connection_can_resume_without_moving_or_overwriting_it(self):
        path, _ = self.run_setup()
        legacy = self.directory/'.relay/connections/legacy.json'
        legacy.parent.mkdir(parents=True)
        legacy.write_bytes(path.read_bytes())
        path.unlink()  # Only this test's private fixture config.
        before = legacy.read_bytes()
        with self.directory_context(), patch('builtins.input', side_effect=['y','1']), contextlib.redirect_stdout(io.StringIO()):
            self.assertEqual(onboarding.start(self.args()), legacy)
        self.assertEqual(legacy.read_bytes(), before)

    def test_already_online_worker_is_not_started_twice(self):
        path, _ = self.run_setup()
        config = json.loads(path.read_text())
        self.alice.action('worker-status', dict(session_id=config['session_id'], status='watching'))
        args = self.args(); args.setup_only = False
        with self.directory_context(), patch('builtins.input', side_effect=['y','1']), \
                patch('relay.onboarding.worker.watch') as watch, contextlib.redirect_stdout(io.StringIO()):
            onboarding.start(args)
        watch.assert_not_called()

    def test_switch_does_not_inherit_launchers_project_or_save_global_root(self):
        path, _ = self.run_setup()
        second = self.second_repo()
        legacy = self.directory/'.relay'; legacy.mkdir()
        (legacy/'workspace.json').write_text(json.dumps({'url': self.url, 'project_id': 'wrong-project'}))
        args = self.args(); args.project = None
        with self.directory_context():
            os.chdir(second)
            value = onboarding.workspace_defaults(args, onboarding.session_directory(second), [legacy])
        self.assertEqual(value, (self.url, None))
        saved = json.loads((path.parent.parent/'workspace.json').read_text())
        self.assertEqual(set(saved), {'url', 'project_id'})


class SetupHelpers(unittest.TestCase):
    def test_network_origin_is_persistent_and_fails_closed(self):
        import tempfile
        from relay.server import configured_origin,Hub
        from relay.store import Store
        with tempfile.TemporaryDirectory() as directory:
            path=Path(directory)/'network.json'
            self.assertIsNone(configured_origin(directory))
            path.write_text(json.dumps({'public_origin':'https://relay.example/'}))
            self.assertEqual(configured_origin(directory),'https://relay.example')
            hub=Hub(('127.0.0.1',0),Store(directory))
            try:self.assertEqual(hub.public_origin,'https://relay.example')
            finally:hub.server_close()
            for value in ['',None,'https://user:password@relay.example','https://relay.example/path']:
                path.write_text(json.dumps({'public_origin':value}))
                with self.assertRaises(ValueError):configured_origin(directory)

    def test_choice_reprompts_for_invalid_values(self):
        with patch('builtins.input',side_effect=['','0','bad','3','2']),contextlib.redirect_stdout(io.StringIO()):
            self.assertEqual(onboarding.choose('Pick one',['a','b'],str),'b')

    def test_shell_quoting_and_provider_integration(self):
        quoted=onboarding.shell_command(['codex','a b',"it's",'$token'],windows=True)
        self.assertEqual(quoted,"& 'codex' 'a b' 'it''s' '$token'")
        import shlex
        parts=['codex','a b',"it's",'$token']
        self.assertEqual(shlex.split(onboarding.shell_command(parts,windows=False)),parts)
        config=dict(provider='claude',session_id='abc12345full')
        command=onboarding.integration_command(Path('connector.json').resolve(),config)
        self.assertEqual(command[:7],['claude','mcp','add','--transport','stdio','--scope','local'])
        self.assertNotIn('--scope user',command)


if __name__=='__main__':unittest.main()
