import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import threading
from types import SimpleNamespace
import unittest
from unittest.mock import patch

import test_team
from relay.automation import Automation, apply_artifacts, commit_files, git, run_tests, worktree
from relay.processes import background_options
from relay.worker import atomic_json


def artifact(path='result.txt', content='ready', base='missing'):
    return dict(path=path, content=content, sha256=hashlib.sha256(content.encode()).hexdigest(), base_sha256=base)


class GitAutomationTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        # Guards require a canonical root, as supplied by real onboarding.
        self.root = Path(self.temp.name).resolve()
        self.repo = self.root / 'source'
        self.repo.mkdir()
        git(self.repo, 'init')
        (self.repo / 'original.txt').write_text('original')
        commit_files(self.repo, ['original.txt'], 'initial')
        self.base = git(self.repo, 'rev-parse', 'HEAD')

    def tearDown(self): self.temp.cleanup()

    def test_worktree_rejects_redirected_destination(self):
        target = self.root / 'outside'
        target.mkdir()
        alias = self.root / 'redirected'
        try:
            alias.symlink_to(target, target_is_directory=True)
        except OSError:
            self.skipTest('Directory symlink creation is unavailable on this host')
        with self.assertRaisesRegex(ValueError, 'redirected'):
            worktree(self.repo, alias / 'worker')
        self.assertFalse((target / 'worker').exists())

    def test_isolation_preserves_dirty_source(self):
        (self.repo / 'original.txt').write_text('private dirty changes')
        root = worktree(self.repo, self.root / 'worker')
        apply_artifacts(root, [artifact()])
        commit_files(root, ['result.txt'], 'task')
        self.assertEqual((self.repo / 'original.txt').read_text(), 'private dirty changes')
        self.assertFalse((self.repo / 'result.txt').exists())
        self.assertEqual(git(self.repo, 'rev-parse', 'HEAD'), self.base)

    def test_conflict_validates_whole_bundle_before_writes(self):
        with self.assertRaisesRegex(ValueError, 'conflict'):
            apply_artifacts(self.repo, [artifact(), artifact('original.txt', 'changed')])
        self.assertFalse((self.repo / 'result.txt').exists())
        self.assertEqual((self.repo / 'original.txt').read_text(), 'original')

    def test_protected_paths_and_hash_mismatch(self):
        with self.assertRaises(ValueError): apply_artifacts(self.repo, [artifact('../escape')])
        with self.assertRaises(ValueError): apply_artifacts(self.repo, [artifact('.git/config')])
        wrong = dict(artifact(), sha256='0'*64)
        with self.assertRaisesRegex(ValueError, 'hash'): apply_artifacts(self.repo, [wrong])

    def test_real_test_exit_failure_and_cancellation(self):
        cancel = threading.Event()
        result = run_tests([sys.executable, '-c', 'print("verified")'], self.repo, cancel)
        self.assertEqual(result['exit_code'], 0)
        self.assertIn('verified', result['output'])
        self.assertEqual(run_tests([sys.executable, '-c', 'raise SystemExit(3)'], self.repo, cancel)['exit_code'], 3)
        cancel.set()
        with self.assertRaisesRegex(ValueError, 'cancelled'):
            run_tests([sys.executable, '-c', 'import time; time.sleep(30)'], self.repo, cancel)

    def test_timeout_kills_owned_tests(self):
        with self.assertRaisesRegex(ValueError, 'time limit'):
            run_tests([sys.executable, '-c', 'import time; time.sleep(30)'], self.repo, threading.Event(), timeout=.15)

    def test_timeout_stops_descendants_too(self):
        import time
        child = 'import time; from pathlib import Path; time.sleep(.6); Path("escaped.txt").write_text("escaped")'
        parent = 'import subprocess,sys,time; subprocess.Popen([sys.executable,"-c",' + repr(child) + ']); time.sleep(30)'
        with self.assertRaisesRegex(ValueError, 'time limit'):
            run_tests([sys.executable, '-c', parent], self.repo, threading.Event(), timeout=.2)
        time.sleep(.8)
        self.assertFalse((self.repo/'escaped.txt').exists())

    def test_dependency_sync_is_automatic_and_repeatable(self):
        root = worktree(self.repo, self.root / 'worker')
        dependency = dict(id='dep', task_key='dep', status='complete', dependencies=[])
        task = dict(id='task', task_key='task', status='assigned', attempt=1, dependencies=['dep'])
        actions = []
        def action(name, data):
            actions.append(name)
            if name == 'team-state': return {'tasks': [dependency, task]}
            if name == 'team-artifacts': return {'artifacts': [artifact()]}
            return {'ok': True}
        runtime = SimpleNamespace(path=self.root/'connection.json', config=dict(repo=str(root), session_id='a', live_instance='a', automation={}), client=SimpleNamespace(action=action))
        runner = Automation(runtime)
        for _ in range(2): runner.prepare(dict(kind='implement', task=task))
        self.assertEqual((root/'result.txt').read_text(), 'ready')
        self.assertEqual(actions.count('team-checkout'), 2)
        self.assertFalse((self.repo/'result.txt').exists())

    def test_tests_cannot_change_git_history_and_then_get_merged(self):
        directory = self.root / 'private'
        directory.mkdir()
        integration = worktree(self.repo, directory/'integration', 'relay/history')
        # Repository code may run Git, but the controller must detect it.
        command = [sys.executable, '-c', 'import subprocess; subprocess.run(["git","-c","user.name=QA","-c","user.email=qa@local","-c","commit.gpgsign=false","commit","--allow-empty","-m","unexpected"],check=True)']
        config = dict(repo=str(self.repo), session_id='a', live_instance='a', team_goal_id='g', automation=dict(integration_root=str(integration), test_argv=command, branch='relay/history'))
        client = SimpleNamespace(action=lambda name, data: {'artifacts':[artifact()]} if name=='team-artifacts' else {'goals':[{'status':'active','revision':1}]})
        runner = Automation(SimpleNamespace(path=directory/'connection.json', config=config, client=client, active=True, network_ok=True))
        runner.integrate(dict(id='a'*16, attempt=1), 1)
        self.assertIn('Git history', runner.pending[2]['error'])
        self.assertEqual(git(integration, 'rev-parse', 'HEAD'), self.base)

    def test_pipeline_merges_tested_tree_only_on_separate_branch(self):
        for passes in (True, False):
            directory = self.root / str(passes)
            directory.mkdir()
            integration = worktree(self.repo, directory / 'integration', 'relay/test-' + str(passes).lower())
            command = [sys.executable, '-c', 'from pathlib import Path; assert Path("result.txt").read_text()=="ready"' if passes else 'raise SystemExit(2)']
            config = dict(repo=str(self.repo), session_id='a', live_instance='a', team_goal_id='g',
                          automation=dict(integration_root=str(integration), test_argv=command, branch='relay/test-' + str(passes).lower()))
            client = SimpleNamespace(action=lambda name, data: {'artifacts': [artifact()]} if name == 'team-artifacts' else {'goals': [{'status': 'active', 'revision': 1}]})
            runtime = SimpleNamespace(path=directory/'connection.json', config=config, client=client, active=True, network_ok=True)
            runner = Automation(runtime)
            runner.integrate(dict(id='a'*16, title='Create result', attempt=1), 1)
            receipt = runner.pending[2]
            self.assertEqual(receipt['status'], 'passed' if passes else 'failed', receipt)
            self.assertEqual((integration/'result.txt').exists(), passes)
            self.assertEqual(git(self.repo, 'rev-parse', 'HEAD'), self.base)
            self.assertFalse((self.repo/'result.txt').exists())
            if passes:
                self.assertEqual(len(git(integration, 'rev-list', '--parents', '-n', '1', 'HEAD').split()), 3)


class IntegrationProtocolTests(unittest.TestCase):
    setUp = test_team.TeamTests.setUp
    tearDown = test_team.TeamTests.tearDown
    action = test_team.TeamTests.action
    setup_team = test_team.TeamTests.setup_team
    propose = test_team.TeamTests.propose
    assignments = test_team.TeamTests.assignments
    start = test_team.TeamTests.start

    def ready(self):
        self.propose(paths=('result.txt',))
        task = self.assignments()[0]['task']
        self.start(self.alice, self.a_session, task)
        self.action(self.alice, self.a_session, 'submit', task_id=task['id'], summary='Done', evidence='Awaiting automated tests', artifacts=[artifact()])
        self.action(self.bob, self.b_session, 'poll')
        self.action(self.bob, self.b_session, 'review', task_id=task['id'], decision='accept', note='Peer artifact reviewed')
        self.policy = dict(test_argv=['python', '-m', 'unittest'], branch='relay/test')
        self.action(self.alice, self.a_session, 'auto-enable', policy=self.policy)
        return task

    def test_owner_receipt_fencing_and_idempotence(self):
        task = self.ready()
        args = dict(task_id=task['id'], attempt=1, revision=1)
        with self.assertRaisesRegex(ValueError, 'Only the goal owner'):
            self.action(self.bob, self.b_session, 'auto-claim', **args)
        self.action(self.alice, self.a_session, 'auto-claim', **args)
        with self.assertRaisesRegex(ValueError, 'already attempted'):
            self.action(self.alice, self.a_session, 'auto-claim', **args)
        receipt = dict(status='passed', files={'result.txt': artifact()['sha256']}, test_argv=self.policy['test_argv'], exit_code=0, commit='a'*40, branch='relay/test')
        with self.assertRaisesRegex(ValueError, 'do not match'):
            self.action(self.alice, self.a_session, 'auto-result', **args, receipt=dict(receipt, exit_code=1))
        self.assertEqual(self.action(self.alice, self.a_session, 'auto-result', **args, receipt=receipt)['status'], 'complete')
        self.assertTrue(self.action(self.alice, self.a_session, 'auto-result', **args, receipt=receipt)['idempotent'])

    def test_changed_goal_prevents_success_receipt(self):
        task = self.ready()
        args = dict(task_id=task['id'], attempt=1, revision=1)
        self.action(self.alice, self.a_session, 'auto-claim', **args)
        self.action(self.bob, self.b_session, 'request', body='Add one requirement')
        with self.assertRaisesRegex(ValueError, 'changed or paused'):
            self.action(self.alice, self.a_session, 'auto-result', **args, receipt={'status': 'passed'})

    def test_failure_stays_integration_until_explicit_retry(self):
        task = self.ready()
        args = dict(task_id=task['id'], attempt=1, revision=1)
        self.action(self.alice, self.a_session, 'auto-claim', **args)
        self.action(self.alice, self.a_session, 'auto-result', **args, receipt={'status': 'failed', 'error': 'Tests failed'})
        state = self.action(self.alice, self.a_session, 'state')
        self.assertEqual(state['tasks'][0]['status'], 'integration')
        self.assertEqual(state['integrations'][0]['status'], 'failed')
        self.action(self.alice, self.a_session, 'auto-retry', **args)
        self.action(self.alice, self.a_session, 'auto-claim', **args)

    def test_model_surface_has_no_execution_or_automation_authority(self):
        from relay.managed_tools import tools_for_config
        names = {t['name'] for t in tools_for_config({'team_goal_id': 'g'})}
        self.assertFalse(any('auto' in n or 'shell' in n or 'spawn' in n or 'accept' in n for n in names))

    def test_failed_tests_return_fenced_corrections_to_same_worker(self):
        task = self.ready()
        args = dict(task_id=task['id'], attempt=1, revision=1)
        self.action(self.alice, self.a_session, 'auto-claim', **args)
        self.action(self.alice, self.a_session, 'auto-result', **args, receipt=dict(status='failed', exit_code=1, output='Expected ready'))
        changed = self.action(self.alice, self.a_session, 'state')['tasks'][0]
        self.assertEqual(changed['status'], 'assigned')
        self.assertEqual(changed['attempt'], 2)
        self.assertEqual(changed['assignee'], task['assignee'])


if __name__ == '__main__': unittest.main()
