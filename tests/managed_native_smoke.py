"""Explicit native-provider QA in a temporary repo and isolated hub, never a user's source session."""
import argparse
import hashlib
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
    parser = argparse.ArgumentParser()
    parser.add_argument('--provider', choices=['codex', 'claude'], required=True)
    args = parser.parse_args()
    with tempfile.TemporaryDirectory(prefix='relay-native-', dir=Path('.relay').resolve()) as temporary:
        base = Path(temporary)
        repo = base / 'repo'
        repo.mkdir()
        for command in [['git', 'init', str(repo)], ['git', '-C', str(repo), '-c', 'user.name=Relay QA',
                        '-c', 'user.email=qa@localhost', 'commit', '--allow-empty', '-m', 'isolated QA']]:
            subprocess.run(command, capture_output=True, check=True)
        store = Store(base / 'hub')
        server = Hub(('127.0.0.1', 0), store)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        token = (base / 'hub/owner-token').read_text()
        url = 'http://127.0.0.1:' + str(server.server_address[1])
        client = Client(url, token)
        project = client.action('project', {'name': 'Isolated native QA'})['id']
        sid = client.action('session', {'project_id': project, 'name': 'Fresh QA agent'})['id']
        directory = base / 'private/run'
        directory.mkdir(parents=True)
        path = directory / 'connection.json'
        atomic_json(path, dict(url=url, token=token, project_id=project, session_id=sid, repo=str(repo),
            provider=args.provider, managed_live=True, live_instance='native-qa', repository_key=repository_key(repo)))
        outputs = []
        runtime = LiveRuntime(path, output=lambda text: outputs.append(text))
        report = {'provider': args.provider, 'existing_sessions_touched': False}
        try:
            runtime.connect()
            runtime.task_started = True
            runtime.offer('This is an isolated Relay integration test. Use relay_project, publish one work plan for hello.txt, '
                'start it with relay_work_update, then use relay_read_file and relay_write_file to create hello.txt containing '
                'exactly first. Do not use native shell or file-edit tools. Leave your work plan working (do not finish/release), '
                'then finish your response. A later teammate event will ask you to reconsider the file within this same task.')
            end = time.monotonic() + 240
            while time.monotonic() < end and (not (repo / 'hello.txt').exists() or runtime.provider.busy):
                runtime.tick()
                time.sleep(.05)
            assert (repo / 'hello.txt').read_text() == 'first', 'Native agent did not perform the guarded write: ' + str(outputs[-3:])
            assert not runtime.provider.busy, 'Initial native turn did not finish'
            report['initial_guarded_write'] = True
            state = client.request('/api/state')
            work = next(p for p in state['coordination']['plans'] if p['session_id'] == sid)
            invite = client.action('invite', {'name': 'QA teammate'})
            peer = Client(url, invite['token'])
            peer_sid = peer.action('session', {'project_id': project, 'name': 'QA teammate'})['id']
            peer.action('work-message', dict(session_id=peer_sid, work_id=work['id'],
                note='For the already-assigned test, update hello.txt to exactly second. Acknowledge this event, then read the file and use its hash for the guarded write.'))
            end = time.monotonic() + 180
            while time.monotonic() < end:
                runtime.tick()
                if (repo / 'hello.txt').read_text() == 'second' and not runtime.provider.busy:
                    break
                time.sleep(.05)
            assert (repo / 'hello.txt').read_text() == 'second', 'Idle delivery/acknowledged write failed: ' + str(outputs[-3:])
            assert runtime.action('poll')['messages'] == [], 'Working agent did not acknowledge delivery'
            report['idle_wakeup_and_acknowledgement'] = True
            report['new_owned_source_id'] = runtime.provider.source_id
            runtime.pause()
            assert not json.loads(directory.joinpath('control.json').read_text())['active']
            report['pause_blocks_tools'] = True
            report['result'] = 'passed'
        finally:
            runtime.close()
            server.shutdown()
            server.server_close()
            thread.join(timeout=5)
        Path('.relay/managed-' + args.provider + '-verification.json').write_text(json.dumps(report, indent=2))
        print(json.dumps(report))


if __name__ == '__main__':
    main()
