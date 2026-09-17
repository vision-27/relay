"""Consented local automation: isolated worktrees, bounded tests, owned helpers.

No model can choose a command, Git destination, credential, or helper budget.
Tests execute trusted repository code with the developer's OS privileges; this
is not a sandbox. Nothing pushes or changes the developer's checked-out branch.
"""
import hashlib
import json
import os
from pathlib import Path
import secrets
import shlex
import signal
import socket
import subprocess
import sys
import threading
import time

from .adapters import redact
from .client import git_info
from .managed_tools import safe_file
from .processes import background_options
from .worker import atomic_json, instance_lock


def git(root, *args):
    # No hooks, signing prompts, pager, external diff or network operation.
    result = subprocess.run(['git', '-c', 'core.hooksPath=' + os.devnull,
        '-c', 'commit.gpgsign=false', '-c', 'user.name=Relay',
        '-c', 'user.email=relay@localhost', '-C', str(root), *args],
        stdin=subprocess.DEVNULL, capture_output=True, text=True, encoding='utf-8',
        errors='replace', timeout=30, **background_options())
    if result.returncode:
        raise ValueError('Git ' + args[0] + ' stopped: ' + redact(result.stderr)[-800:])
    return result.stdout.strip()


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest() if path.exists() else 'missing'


def worktree(source, directory, branch=None, base='HEAD'):
    directory = Path(directory).absolute()
    if directory.exists():
        raise ValueError('Automation checkout already exists; it was preserved for inspection')
    if any(p.is_symlink() for p in directory.parents):
        raise ValueError('Automation directories cannot be redirected')
    directory.parent.mkdir(parents=True, exist_ok=True)
    args = ['worktree', 'add'] + (['-b', branch] if branch else ['--detach'])
    git(source, *args, str(directory), base)
    return directory


def apply_artifacts(root, artifacts):
    """Validate every byte/base before any replacement; never silently resolve conflicts."""
    prepared = []
    seen = set()
    for item in artifacts:
        path = safe_file(root, item['path'])
        content = item['content'].encode('utf-8')
        if item['path'] in seen or hashlib.sha256(content).hexdigest() != item['sha256']:
            raise ValueError('Artifact hash or duplicate path conflict')
        seen.add(item['path'])
        current = digest(path)
        if current not in (item.get('base_sha256'), item['sha256']):
            raise ValueError('Merge conflict in ' + item['path'] + '; original work is preserved')
        prepared.append((path, content))
    for path, content in prepared:
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(content)


def commit_files(root, paths, message):
    if paths:
        git(root, 'add', '--', *paths)
    if git(root, 'diff', '--cached', '--name-only'):
        git(root, 'commit', '-m', message)
    return git(root, 'rev-parse', 'HEAD')


def run_tests(argv, root, cancel, timeout=120):
    """Kill only the owned process tree on pause/timeout; keep bounded private output."""
    import tempfile
    options = background_options()
    job = None
    if os.name == 'nt':
        import ctypes
        from ctypes import wintypes
        kernel = ctypes.WinDLL('kernel32', use_last_error=True)
        kernel.CreateJobObjectW.restype = wintypes.HANDLE
        kernel.AssignProcessToJobObject.argtypes = [wintypes.HANDLE, wintypes.HANDLE]
        kernel.TerminateJobObject.argtypes = [wintypes.HANDLE, wintypes.UINT]
        kernel.CloseHandle.argtypes = [wintypes.HANDLE]
        kernel.SetInformationJobObject.argtypes = [wintypes.HANDLE, ctypes.c_int, ctypes.c_void_p, wintypes.DWORD]
        job = kernel.CreateJobObjectW(None, None)
        if not job: raise ctypes.WinError(ctypes.get_last_error())
        # JOBOBJECT_EXTENDED_LIMIT_INFORMATION; LimitFlags sits at offset 16.
        limits = ctypes.create_string_buffer(144 if ctypes.sizeof(ctypes.c_void_p) == 8 else 112)
        ctypes.c_uint32.from_buffer(limits, 16).value = 0x2000  # KILL_ON_JOB_CLOSE
        if not kernel.SetInformationJobObject(job, 9, limits, len(limits)):
            kernel.CloseHandle(job)
            raise ValueError('Cannot enable test-tree cleanup; tests were not started')
        options['creationflags'] |= 0x4  # CREATE_SUSPENDED: attach before children can escape.
    else:
        options['start_new_session'] = True
    env = {k: v for k, v in os.environ.items() if not any(s in k.upper() for s in ('TOKEN', 'SECRET', 'PASSWORD', 'API_KEY'))}
    env.update(PYTHONDONTWRITEBYTECODE='1', CI='1', GIT_TERMINAL_PROMPT='0')
    process = None
    try:
        with tempfile.TemporaryFile() as log:
            process = subprocess.Popen(argv, cwd=root, stdin=subprocess.DEVNULL, stdout=log,
                                       stderr=log, env=env, **options)
            if job:
                if not kernel.AssignProcessToJobObject(job, int(process._handle)):
                    process.kill()
                    raise ValueError('Cannot contain the test process tree; tests were not started')
                resume = ctypes.WinDLL('ntdll').NtResumeProcess
                resume.argtypes = [wintypes.HANDLE]
                if resume(int(process._handle)) != 0:
                    raise ValueError('Cannot start the contained test process')
            deadline = time.monotonic() + timeout
            while process.poll() is None:
                if cancel.wait(.05): raise ValueError('Test run cancelled; no merge')
                if time.monotonic() >= deadline: raise ValueError('Test time limit reached; no merge')
                if log.tell() > 2_000_000: raise ValueError('Test output limit reached; no merge')
            log.seek(0)
            output = redact(log.read(2_000_000).decode('utf-8', errors='replace'))[-4000:]
            return {'exit_code': process.returncode, 'output': output, 'test_argv': argv}
    finally:
        # Also remove lingering descendants after a successful parent exits.
        if job:
            kernel.TerminateJobObject(job, 1)
            kernel.CloseHandle(job)
        elif process:
            try: os.killpg(process.pid, signal.SIGKILL)
            except ProcessLookupError: pass
        if process:
            process.wait(timeout=10)


def consent(goal, client):
    """One-time, per-start choices. No repo-local file can silently enable execution."""
    if input('Use automatic helpers and isolated worktrees? [y/N]: ').strip().lower() not in ('y', 'yes'):
        return None
    print('One extra new agent may start on this PC when useful; model usage uses your login.')
    print('Your current folder is untouched. Agents start from committed HEAD, not uncommitted edits.')
    owner = not goal or goal['member_id'] == client.request('/api/state')['me']['id']
    argv, setup_argv = None, None
    if owner:
        command = input('Test command to run automatically (blank keeps integration manual): ').strip()
        if command:
            argv = shlex.split(command, posix=os.name != 'nt')
            argv = [a[1:-1] if len(a) >= 2 and a[0] == a[-1] and a[0] in "\"'" else a for a in argv]
            setup = input('Dependency setup command in each isolated checkout (blank for none): ').strip()
            if setup:
                setup_argv = shlex.split(setup, posix=os.name != 'nt')
                setup_argv = [a[1:-1] if len(a) >= 2 and a[0] == a[-1] and a[0] in "\"'" else a for a in setup_argv]
            print('Tests execute repository code with YOUR OS permissions; this is not a sandbox.')
            print('Approved tests: ' + command + ' (120 seconds per command).')
            print('Dependency setup: ' + (setup or 'none; dependencies must already be available'))
            print('Reviewed passing changes merge only into a new local relay/... branch. No push or main-branch merge.')
    if input('Approve these automation settings for this run? [y/N]: ').strip().lower() not in ('y', 'yes'):
        return None
    return dict(helper_limit=1, test_argv=argv, setup_argv=setup_argv)


class Automation:
    def __init__(self, runtime):
        self.runtime = runtime
        self.settings = runtime.config['automation']
        self.directory = runtime.path.parent
        self.cancel = threading.Event()
        self.thread = None
        self.helpers = []
        self.helper_started = False
        self.next_check = 0
        self.pending = None
        self.failure = ''

    def state(self):
        return self.runtime.client.action('team-state', dict(session_id=self.runtime.config['session_id'], instance=self.runtime.config['live_instance']))

    def action(self, name, **data):
        return self.runtime.client.action('team-auto-' + name, dict(session_id=self.runtime.config['session_id'], instance=self.runtime.config['live_instance'], **data))

    def start(self):
        if self.settings.get('test_argv'):
            branch = 'relay/goal-' + self.runtime.config['team_goal_id'] + '-' + secrets.token_hex(3)
            root = worktree(self.settings['source_repo'], self.directory / 'integration', branch)
            self.settings.update(branch=branch, integration_root=str(root))
            atomic_json(self.runtime.path, self.runtime.config)
            self.action('enable', policy=dict(test_argv=self.settings['test_argv'], setup_argv=self.settings.get('setup_argv'), branch=branch))
            self.runtime.output('Automatic tests and merges: ' + branch + '\nIntegration checkout: ' + str(root))

    def prepare(self, assignment):
        if assignment['kind'] != 'implement' or assignment['task']['status'] != 'assigned': return
        task = assignment['task']
        root = Path(self.runtime.config['repo'])
        # A worker may have its own submitted edits. Commit only its journaled
        # changes, never unrelated files, before updating dependencies.
        journal_path = self.runtime.path.with_name('team-changes.json')
        journal = json.loads(journal_path.read_text()) if journal_path.exists() else {}
        latest = {p: item for changes in journal.values() for p, item in changes.items()}
        files = set(latest)
        if files:
            for path, item in latest.items():
                if digest(safe_file(root, path)) != item['sha256']:
                    raise ValueError('Worker files changed outside Relay; inspect before continuing')
            commit_files(root, sorted(files), 'Relay worker checkpoint')
        if git(root, 'status', '--porcelain'):
            raise ValueError('Isolated worker checkout has unexpected changes; nothing was overwritten')
        state = self.state()
        by_key = {t['task_key']: t for t in state['tasks']}
        ordered, visited = [], set()
        def visit(key):
            if key in visited: return
            visited.add(key)
            dependency = by_key[key]
            if dependency['status'] != 'complete': raise ValueError('Dependency integration is not complete')
            for dep in dependency['dependencies']: visit(dep)
            ordered.append(dependency)
        for dep in task['dependencies']: visit(dep)
        final, allowed = {}, {}
        for dependency in ordered:
            bundle = self.runtime.client.action('team-artifacts', dict(task_id=dependency['id'], session_id=self.runtime.config['session_id'], instance=self.runtime.config['live_instance']))
            for item in bundle['artifacts']:
                final[item['path']] = item
                allowed.setdefault(item['path'], set()).update((item.get('base_sha256'), item['sha256']))
        prepared = []
        for path, item in final.items():
            current = digest(safe_file(root, path))
            if current not in allowed[path]:
                raise ValueError('Dependency conflicts with this worker checkout: ' + path)
            prepared.append(dict(item, base_sha256=current))
        apply_artifacts(root, prepared)
        commit_files(root, list(final), 'Relay verified dependencies')
        # Older task journals are no longer pending local edits. Keeping them
        # would mistake a verified dependency update for an external mutation.
        atomic_json(journal_path, {task['id']: journal[task['id']]} if task['id'] in journal else {})
        commit = git(root, 'rev-parse', 'HEAD')
        self.runtime.client.action('team-checkout', dict(task_id=task['id'], attempt=task['attempt'], base_commit=commit, session_id=self.runtime.config['session_id'], instance=self.runtime.config['live_instance']))
        task['base_commit'] = commit

    def spawn_helper(self):
        from .managed_live import LiveRuntime
        config = self.runtime.config
        directory = self.directory / 'helper'
        root = worktree(self.settings['source_repo'], directory / 'checkout')
        info = git_info(root)
        session = self.runtime.client.action('session', dict(project_id=config['project_id'], name='Helper / ' + config['provider'], machine=socket.gethostname(), **info))
        child_config = dict(config, session_id=session['id'], live_instance=secrets.token_hex(24), repo=str(root),
                            automation=dict(source_repo=self.settings['source_repo'], helper_limit=0, test_argv=None))
        child_config.pop('owned_source_id', None)
        path = directory / 'connection.json'
        atomic_json(path, child_config)
        child = LiveRuntime(path, provider_factory=self.runtime.provider_factory,
                            output=lambda value: self.runtime.output('[Helper] ' + value))
        self.helpers.append(child)  # Even a partial initialization is owned and closed.
        self.helper_started = True
        child.connect()
        child.task_started = True
        child.automation = Automation(child)
        self.runtime.output('Relay started one helper in its own checkout. No extra terminal or existing conversation was opened.')

    def tick(self):
        for child in self.helpers:
            child.tick()
        if self.thread and self.thread.is_alive(): return
        if self.pending:
            task, revision, receipt = self.pending
            self.action('result', task_id=task['id'], attempt=task['attempt'], revision=revision, receipt=receipt)
            self.pending = None
            self.runtime.output('Integration ' + receipt['status'] + ': ' + task['title'] + (' — ' + receipt.get('error', '') if receipt.get('error') else ''))
        if self.failure or time.monotonic() < self.next_check: return
        self.next_check = time.monotonic() + 3
        state = self.state()
        goal = state['goals'][0]
        if goal['status'] != 'active': return
        if self.settings.get('helper_limit') and not self.helper_started:
            queued = [t for t in state['tasks'] if t['status'] == 'queued']
            busy = [t for t in state['tasks'] if t['status'] in ('assigned', 'working')]
            if queued and busy:
                self.spawn_helper()
        if not self.settings.get('test_argv'): return
        attempted = {(i['task_id'], i['attempt']) for i in state.get('integrations', [])}
        task = next((t for t in state['tasks'] if t['status'] == 'integration' and (t['id'], t['attempt']) not in attempted), None)
        if task:
            self.action('claim', task_id=task['id'], attempt=task['attempt'], revision=goal['revision'])
            self.cancel.clear()
            self.thread = threading.Thread(target=self.integrate, args=(task, goal['revision']), daemon=True)
            self.thread.start()

    def integrate(self, task, revision):
        receipt = dict(status='failed')
        try:
            root = Path(self.settings['integration_root'])
            with instance_lock(self.directory / 'integration-run.json'):
                if git(root, 'status', '--porcelain'):
                    raise ValueError('Integration checkout has external changes; inspect it before retrying')
                before = git(root, 'rev-parse', 'HEAD')
                candidate = worktree(root, self.directory / ('candidate-' + task['id'] + '-' + secrets.token_hex(3)), base=before)
                bundle = self.runtime.client.action('team-artifacts', dict(task_id=task['id'], session_id=self.runtime.config['session_id'], instance=self.runtime.config['live_instance']))
                apply_artifacts(candidate, bundle['artifacts'])
                candidate_commit = commit_files(candidate, [a['path'] for a in bundle['artifacts']], 'Relay task ' + task['id'])
                if self.settings.get('setup_argv'):
                    setup = run_tests(self.settings['setup_argv'], candidate, self.cancel)
                    receipt['setup'] = setup
                    if setup['exit_code'] != 0:
                        raise ValueError('Approved dependency setup failed; inspect the candidate and /retry after resolving it')
                receipt.update(run_tests(self.settings['test_argv'], candidate, self.cancel))
                if receipt['exit_code'] != 0: raise ValueError('Approved tests failed; candidate retained for inspection: ' + str(candidate))
                if git(candidate, 'rev-parse', 'HEAD') != candidate_commit:
                    raise ValueError('Tests changed Git history; no merge')
                if git(candidate, 'status', '--porcelain'):
                    raise ValueError('Tests changed checkout files; no merge')
                expected = {a['path']: a['sha256'] for a in bundle['artifacts']}
                if any(digest(safe_file(candidate, path)) != sha for path, sha in expected.items()):
                    raise ValueError('Tested artifact bytes changed; no merge')
                state = self.state()
                goal = state['goals'][0]
                if self.cancel.is_set() or not self.runtime.active or not self.runtime.network_ok or goal['status'] != 'active' or goal['revision'] != revision:
                    raise ValueError('Paused or changed goal; no merge')
                if git(root, 'rev-parse', 'HEAD') != before or git(root, 'status', '--porcelain'):
                    raise ValueError('Integration branch moved; no merge')
                git(root, 'merge', '--no-ff', '--no-edit', candidate_commit)
                if git(root, 'rev-parse', 'HEAD^{tree}') != git(candidate, 'rev-parse', 'HEAD^{tree}'):
                    raise ValueError('Merged tree differs from tested tree; inspect retained branch')
                receipt.update(status='passed', files=expected, commit=git(root, 'rev-parse', 'HEAD'),
                               branch=self.settings['branch'], tested_commit=candidate_commit)
        except (ValueError, OSError, subprocess.SubprocessError) as exc:
            receipt.update(status='failed', error=redact(str(exc))[:1000])
        atomic_json(self.directory / ('integration-' + task['id'] + '-' + str(task['attempt']) + '.json'), receipt)
        self.pending = (task, revision, receipt)

    def pause(self):
        self.cancel.set()
        for child in self.helpers: child.pause('Parent team session paused.')

    def resume(self):
        for child in self.helpers: child.resume()

    def close(self):
        self.cancel.set()
        if self.thread: self.thread.join(timeout=15)
        for child in self.helpers: child.close()
