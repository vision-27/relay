"""Actual provider-driven planning, assignment, guarded edits and artifact review.

Temporary checkouts and new QA conversations only. This is not physical Mac QA.
"""
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import threading
import time

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from relay.client import Client, git_info
from relay.managed_live import LiveRuntime, repository_key
from relay.server import Hub
from relay.store import Store
from relay.worker import atomic_json


def main():
    automated = '--automation' in sys.argv
    count = 3 if automated else 2
    final_status = 'complete' if automated else 'integration'
    with tempfile.TemporaryDirectory(prefix='team-native-', dir=Path('.relay').resolve()) as temporary:
        root = Path(temporary)
        a, b = root / 'a', root / 'b'
        for command in [['git', 'init', str(a)], ['git', '-C', str(a), '-c', 'user.name=QA', '-c', 'user.email=qa@localhost', 'commit', '--allow-empty', '-m', 'QA'], ['git', 'clone', str(a), str(b)]]:
            subprocess.run(command, check=True, capture_output=True)
        store = Store(root / 'hub')
        hub = Hub(('127.0.0.1', 0), store)
        thread = threading.Thread(target=hub.serve_forever, daemon=True)
        thread.start()
        alice = Client('http://127.0.0.1:' + str(hub.server_address[1]), (root / 'hub/owner-token').read_text())
        bob = Client(alice.url, alice.action('invite', {'name': 'QA Claude'})['token'])
        project = alice.action('project', {'name': 'Automatic team QA'})['id']
        objective = ('Create alpha.txt, beta.txt and gamma.txt, each containing exactly ready with no newline. Propose exactly three disjoint tasks with no dependencies. Do not add other files or tasks. Peer-review the graph, implement assigned files, and inspect peer artifacts. The developer-approved controller runs exact-content tests and integrates after review. Do not wait for a manual developer acceptance.' if automated else
            'Create alpha.txt and beta.txt, each containing exactly ready with no newline. These are two independent outputs: propose two disjoint tasks with no dependency. Do not add other files or tasks. Peer-review the graph before implementation; inspect the artifact bytes after implementation. Tests are not applicable beyond exact content checks; report that explicitly. Do not invent developer integration acceptance.')
        goal = alice.action('team-create', dict(project_id=project, repository_key=repository_key(a), objective=objective))
        runtimes, outputs = [], []
        try:
            for provider, client, repo in [('codex', alice, a), ('claude', bob, b)]:
                path = root / 'private' / provider / 'connection.json'
                path.parent.mkdir(parents=True)
                sid = client.action('session', dict(project_id=project, name=provider, **git_info(repo)))['id']
                atomic_json(path, dict(url=client.url, token=client.token, project_id=project, session_id=sid, repo=str(repo),
                    provider=provider, managed_live=True, live_instance=provider, repository_key=repository_key(repo), team_goal_id=goal['id']))
                if automated:
                    config = json.loads(path.read_text())
                    config['automation'] = dict(source_repo=str(repo), helper_limit=1 if provider == 'codex' else 0,
                        test_argv=[sys.executable, '-c', 'from pathlib import Path; files=list(Path(".").glob("*.txt")); assert files; assert all(p.read_bytes()==b"ready" for p in files); print("Exact-content tests passed")'] if provider == 'codex' else None)
                    atomic_json(path, config)
                def output(text, provider=provider):
                    outputs.append((provider, text))
                    print(provider + ': ' + text, flush=True)
                runtime = LiveRuntime(path, output=output)
                runtimes.append(runtime)
                runtime.connect()
                if automated:
                    from relay.automation import Automation
                    runtime.automation = Automation(runtime)
                    runtime.automation.start()
                runtime.task_started = True
            deadline = time.monotonic() + 540
            last_status = None
            while time.monotonic() < deadline:
                for runtime in runtimes:
                    runtime.tick()
                    if not runtime.active: raise AssertionError('A team runtime paused')
                state = alice.request('/api/state')['team']
                status = [(t['title'], t['status']) for t in state['tasks']]
                if status != last_status:
                    print('Task status: ' + json.dumps(status), flush=True)
                    last_status = status
                if len(state['tasks']) == count and all(t['status'] == final_status for t in state['tasks']):
                    break
                time.sleep(.1)
            assert len(state['tasks']) == count and all(t['status'] == final_status for t in state['tasks']), status
            assert len(set(t['assignee'] for t in state['tasks'])) >= 2, 'Tasks were not spread across workers'
            assert state['goals'][0]['status'] == ('complete' if automated else 'active')
            all_runtimes = runtimes + [h for r in runtimes if r.automation for h in r.automation.helpers]
            for task in state['tasks']:
                owner = next(r for r in all_runtimes if r.config['session_id'] == task['assignee'])
                assert len(task['artifacts']) == 1
                file = Path(owner.config['repo']) / task['artifacts'][0]['path']
                assert file.read_bytes() == b'ready'
            report = dict(result='passed', native_providers=['codex', 'claude'], automatic_task_decomposition=True,
                independent_plan_review=True, automatic_disjoint_assignment=True, guarded_edits=True,
                cross_checkout_artifact_review=True, developer_verification_gate_retained=not automated,
                physical_two_pc_test=False, existing_conversations_touched=False,
                task_states=[t['status'] for t in state['tasks']])
            if automated:
                assert runtimes[0].automation.helper_started, 'Automatic helper was not exercised'
                assert all(i['status'] == 'passed' for i in state['integrations'])
                integrated = Path(runtimes[0].automation.settings['integration_root'])
                assert all((integrated / name).read_bytes() == b'ready' for name in ('alpha.txt', 'beta.txt', 'gamma.txt'))
                report.update(automatic_helpers=True, automatic_tests=True, automatic_git_merge=True)
            atomic_json(Path('.relay/team-automation-native-verification.json' if automated else '.relay/team-native-verification.json'), report)
            print(json.dumps(report), flush=True)
        finally:
            for runtime in runtimes: runtime.close()
            hub.shutdown(); hub.server_close(); thread.join(timeout=5)


if __name__ == '__main__':
    main()
