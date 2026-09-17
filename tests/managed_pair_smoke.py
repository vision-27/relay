"""Native Codex + Claude cooperation in separate temporary checkouts, not two physical PCs."""
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import threading
import time

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from relay.client import Client
from relay.managed_live import LiveRuntime, repository_key
from relay.server import Hub
from relay.store import Store
from relay.worker import atomic_json


def main():
    with tempfile.TemporaryDirectory(prefix='relay-pair-', dir=Path('.relay').resolve()) as temporary:
        root = Path(temporary)
        a, b = root / 'a', root / 'b'
        for command in [['git', 'init', str(a)], ['git', '-C', str(a), '-c', 'user.name=QA', '-c', 'user.email=qa@localhost',
                        'commit', '--allow-empty', '-m', 'QA'], ['git', 'clone', str(a), str(b)]]:
            subprocess.run(command, check=True, capture_output=True)
        store = Store(root / 'hub')
        server = Hub(('127.0.0.1', 0), store)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        url = 'http://127.0.0.1:' + str(server.server_address[1])
        alice = Client(url, (root / 'hub/owner-token').read_text())
        invite = alice.action('invite', {'name': 'QA Claude'})
        bob = Client(url, invite['token'])
        project = alice.action('project', {'name': 'Native pair QA'})['id']
        runtimes, outputs = [], []
        try:
            for provider, client, repo in [('codex', alice, a), ('claude', bob, b)]:
                directory = root / 'private' / provider
                directory.mkdir(parents=True)
                sid = client.action('session', {'project_id': project, 'name': provider})['id']
                path = directory / 'connection.json'
                atomic_json(path, dict(url=url, token=client.token, project_id=project, session_id=sid, repo=str(repo),
                    managed_live=True, live_instance=provider, provider=provider, repository_key=repository_key(repo)))
                runtime = LiveRuntime(path, output=lambda text, p=provider: outputs.append((p, text)))
                runtimes.append(runtime)
                runtime.connect()
                runtime.task_started = True
            for runtime, file in zip(runtimes, ['left.txt', 'right.txt']):
                runtime.offer('Native pair integration test: create ' + file + ' containing exactly coordinated. '
                    'Use only guarded Relay tools. Publish a plan for only that file with contracts [], inspect the other '
                    'agent plan and review it if genuinely disjoint. Both agents must exchange reviews before edits. '
                    'Acknowledge incoming events using live inbox/ack. Start your plan, read then write the file. '
                    'Leave your plan working, do not finish/release. Do not invent commands or tests. '
                    'If the peer has not planned yet, end your response and wait for Relay to wake you; do not poll repeatedly.')
            end = time.monotonic() + 360
            while time.monotonic() < end:
                for runtime in runtimes:
                    runtime.tick()
                    assert runtime.active, 'Runtime paused: ' + str(outputs[-4:])
                if (a / 'left.txt').exists() and (b / 'right.txt').exists() and all(not r.provider.busy for r in runtimes):
                    break
                time.sleep(.05)
            assert (a / 'left.txt').read_text() == 'coordinated', str(outputs[-4:])
            assert (b / 'right.txt').read_text() == 'coordinated', str(outputs[-4:])
            state = alice.request('/api/state')['coordination']
            assert len([m for m in state['messages'] if m['kind'] == 'agree']) >= 2
            report = {'result': 'passed', 'providers': ['codex', 'claude'], 'separate_checkouts': True,
                      'peer_reviews_exchanged': True, 'both_guarded_writes': True,
                      'physical_two_pc_test': False, 'existing_conversations_touched': False}
            Path('.relay/managed-pair-verification.json').write_text(json.dumps(report, indent=2))
            print(json.dumps(report))
        finally:
            for runtime in runtimes:
                runtime.close()
            server.shutdown()
            server.server_close()
            thread.join(timeout=5)


if __name__ == '__main__':
    main()
