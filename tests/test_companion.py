import json
from pathlib import Path
import subprocess
import tempfile
import threading
import sys
import time
import unittest
from unittest.mock import patch
from urllib.error import HTTPError
from urllib.parse import parse_qs, urlsplit
from urllib.request import Request, urlopen

import test_relay
from relay.client import Client
from relay.companion import Companion, CompanionServer, runtime
from relay.discovery import same_repository, metadata
from relay.join import invitation
from relay.store import Problem


class JoinTests(unittest.TestCase):
    setUp = test_relay.RelayIntegrationTests.setUp
    tearDown = test_relay.RelayIntegrationTests.tearDown

    def test_proxy_trimmed_legacy_pairing_is_supported_without_browser_auth_bypass(self):
        def post(path, data, extra=None):
            headers = {'Authorization': 'Bearer', 'Content-Type': 'application/json', **(extra or {})}
            with urlopen(Request(self.url + path, data=json.dumps(data).encode(), headers=headers)) as response:
                return json.load(response)
        pair = post('/api/pair/start', {'machine': 'Legacy companion behind HTTPS proxy'})
        self.assertEqual(post('/api/pair/poll', pair), {'status': 'pending'})
        for path, extra in [('/api/pair/approve', {}), ('/api/login', {}),
                            ('/api/actions/invite', {}), ('/api/pair/start', {'Origin': 'https://evil.example'}),
                            ('/api/pair/start', {'Origin': self.url}),
                            ('/api/pair/start', {'Cookie': 'relay_token=' + self.token})]:
            with self.assertRaises(HTTPError) as caught:
                post(path, pair, extra)
            self.assertEqual(caught.exception.code, 403)
        with self.assertRaises(HTTPError):
            post('/api/pair/poll', {'device_secret': 'wrong'})
        # The same request must work once the browser explicitly approves it.
        self.bob.request('/api/pair/approve', pair)
        self.assertEqual(post('/api/pair/poll', pair)['token'], self.bob_token)

    def test_anonymous_client_sends_explicit_header_and_no_empty_bearer(self):
        with patch('relay.client.build_opener') as opener:
            opener.return_value.open.return_value.__enter__.return_value.read.return_value = b'{}'
            Client(self.url, '').request('/api/pair/start', {'machine': 'QA'})
            request = opener.return_value.open.call_args.args[0]
            self.assertIsNone(request.get_header('Authorization'))
            self.assertEqual(request.get_header('X-relay-client'), 'web')

    def test_invite_is_one_use_expiring_and_owner_only(self):
        with self.assertRaisesRegex(ValueError, 'Only the workspace owner'):
            self.bob.action('invite-link', {'name': 'Eve'})
        link = self.alice.action('invite-link', {'name': 'Carol'})['url']
        secret = parse_qs(urlsplit(link).fragment)['invite'][0]
        anonymous = Client(self.url, '')
        self.assertEqual(anonymous.request('/api/invitation', {'secret': secret}), {'name': 'Carol'})
        self.assertEqual(anonymous.request('/api/join', {'secret': secret})['name'], 'Carol')
        with self.assertRaisesRegex(ValueError, 'already been used'):
            anonymous.request('/api/join', {'secret': secret})
        other = self.alice.action('invite-link', {'name': 'Expired'})['url']
        with self.store.connect() as db:
            db.execute('UPDATE invitations SET expires=0')
        with self.assertRaises(Problem):
            invitation(self.store, {'secret': parse_qs(urlsplit(other).fragment)['invite'][0]})
        state = json.dumps(self.alice.request('/api/state'))
        self.assertNotIn(secret, state)
        self.assertEqual(self.bob.request('/api/state')['me']['name'], 'Bob')

    def test_pair_requires_browser_approval_and_is_one_use(self):
        anonymous = Client(self.url, '')
        p = anonymous.request('/api/pair/start', {'machine': 'Test Mac'})
        self.assertEqual(anonymous.request('/api/pair/poll', p), {'status': 'pending'})
        with self.assertRaises(ValueError):
            anonymous.request('/api/pair/approve', p)
        self.assertEqual(self.bob.request('/api/pair/preview', p)['machine'], 'Test Mac')
        self.bob.request('/api/pair/approve', p)
        with self.assertRaisesRegex(ValueError, 'already been approved'):
            self.alice.request('/api/pair/approve', p)
        result = anonymous.request('/api/pair/poll', p)
        self.assertEqual(result['token'], self.bob_token)
        with self.assertRaises(ValueError):
            anonymous.request('/api/pair/poll', p)
        self.assertNotIn(self.bob_token, json.dumps(self.alice.request('/api/state')))

    def test_pair_revocation_expiry_and_origin(self):
        anonymous = Client(self.url, '')
        p = anonymous.request('/api/pair/start', {'machine': 'Test PC'})
        self.bob.request('/api/pair/approve', p)
        self.alice.action('revoke', {'member_id': self.bob_id})
        with self.assertRaises(ValueError):
            anonymous.request('/api/pair/poll', p)
        for item in self.server.pairings.pending.values():
            item['expires'] = 0
        with self.assertRaisesRegex(ValueError, 'expired'):
            anonymous.request('/api/pair/poll', p)
        request = Request(self.url + '/api/pair/start', data=b'{"machine":"evil"}',
                          headers={'Content-Type': 'application/json', 'X-Relay-Client': 'web', 'Origin': 'https://evil.example'})
        with self.assertRaises(HTTPError) as caught:
            urlopen(request)
        self.assertEqual(caught.exception.code, 403)

    def test_companion_pair_connect_pause_with_fake_source(self):
        companion = Companion(self.directory / 'local', self.url)
        with patch('relay.companion.webbrowser.open'):
            pairing = companion.action('pair', {'url': self.url})
        self.bob.request('/api/pair/approve', pairing)
        self.assertEqual(companion.action('poll', {}), {'status': 'approved'})
        self.assertEqual(companion.state()['member'], 'Bob')
        with patch.object(companion.client, 'request', side_effect=ValueError('Hub unavailable')):
            offline = companion.state()
        self.assertTrue(offline['saved_workspace'])
        self.assertIsNone(offline['member'])
        self.assertEqual(offline['network_error'], 'Hub unavailable')
        with self.assertRaisesRegex(ValueError, 'Confirm sharing'):
            companion.action('connect', {'consent': False})
        repo = self.directory / 'repo'
        repo.mkdir()
        subprocess.run(['git', 'init', str(repo)], capture_output=True, check=True)
        subprocess.run(['git', '-C', str(repo), '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid',
                        'commit', '--allow-empty', '-m', 'test'], capture_output=True, check=True)
        source = {'id': 'fake', 'name': 'A readable feature', 'source_file': str(repo / 'fake.jsonl')}
        with patch('relay.companion.discover_sessions', return_value=[source]):
            companion.action('sessions', {'provider': 'claude', 'repo': str(repo)})
        with patch('relay.adapters.adapter') as adapter:
            adapter.return_value.snapshot.side_effect = ValueError('different repository')
            with self.assertRaisesRegex(ValueError, 'different repository'):
                companion.action('connect', {'project': self.project, 'source_id': 'fake', 'consent': True})
            self.assertEqual(self.alice.request('/api/state')['bindings'], [])
            self.assertEqual(list(companion.connections.glob('*.json')), [])
        with patch('relay.adapters.adapter') as adapter, patch.object(companion, 'start_worker'):
            adapter.return_value.snapshot.return_value = {'events': []}
            companion.action('connect', {'project': self.project, 'source_id': 'fake', 'name': 'Feature', 'consent': True})
        item = companion.state()['connections'][0]
        self.assertTrue(item['enabled'])
        companion.action('toggle', {'id': item['id'], 'enabled': False})
        self.assertFalse(companion.state()['connections'][0]['enabled'])
        self.assertNotIn(self.bob_token, json.dumps(companion.state()))
        with patch('relay.integrations.register') as register:
            with self.assertRaisesRegex(ValueError, 'Approve adding'):
                companion.action('enable-tools', {'id': item['id'], 'consent': False})
            register.assert_not_called()
        team = companion.action('team', {})
        self.assertNotIn(self.bob_token, json.dumps(team))
        feature = team['features'][0]
        question = companion.action('ask', {'feature_id': feature['id'], 'question': 'Why this approach?'})
        self.assertTrue(question['id'])
        self.assertEqual(len(companion.action('team', {})['questions']), 1)
        with self.assertRaisesRegex(ValueError, 'already connected'):
            companion.action('connect', {'project': self.project, 'source_id': 'fake', 'consent': True})
        with self.assertRaises(ValueError):
            companion.action('toggle', {'id': '../workspace', 'enabled': True})
        # Registration receipts are metadata, never extra worker connections.
        (companion.connections / (item['id'] + '.tools.json')).write_text('{"provider":"claude"}')
        self.assertEqual(len(companion.state()['connections']), 1)
        self.assertTrue(companion.state()['connections'][0]['tools_configured'])


class LocalSecurityTests(unittest.TestCase):
    def test_real_background_service_starts_and_quits_without_a_terminal(self):
        with tempfile.TemporaryDirectory() as directory:
            process = subprocess.Popen([sys.executable, '-m', 'relay', 'desktop', '--data', directory],
                                       stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            try:
                ready = None
                for _ in range(40):
                    ready = runtime(Path(directory))
                    if ready:
                        break
                    time.sleep(.1)
                self.assertIsNotNone(ready)
                client = Client(ready['origin'], ready['capability'])
                self.assertEqual(client.request('/api/state')['connections'], [])
                client.request('/api/quit', {})
                self.assertEqual(process.wait(timeout=8), 0)
            finally:
                if process.poll() is None:
                    process.terminate()
                    process.wait(timeout=5)

    def test_local_capability_host_and_origin_are_required(self):
        with tempfile.TemporaryDirectory() as directory:
            companion = Companion(directory)
            server = CompanionServer(companion)
            thread = threading.Thread(target=server.serve_forever, daemon=True)
            thread.start()
            try:
                with urlopen(server.origin) as response:
                    self.assertIn(b'Connect workspace', response.read())
                for headers in ({}, {'Authorization': 'Bearer wrong'},
                                {'Authorization': 'Bearer ' + server.capability, 'Origin': 'https://evil.example'},
                                {'Authorization': 'Bearer ' + server.capability, 'Host': 'evil.example'}):
                    with self.assertRaises(HTTPError):
                        urlopen(Request(server.origin + '/api/state', headers=headers))
                self.assertIsNone(Client(server.origin, server.capability).request('/api/state')['member'])
            finally:
                server.shutdown()
                server.server_close()
                thread.join()

    def test_checkout_identity_accepts_subfolder_not_nested_or_other_repo(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            repo = root / 'one'
            other = root / 'two'
            for path in (repo, other):
                subprocess.run(['git', 'init', str(path)], check=True, capture_output=True)
            sub = repo / 'src'
            sub.mkdir()
            self.assertTrue(same_repository(str(sub), str(repo)))
            self.assertFalse(same_repository(str(other), str(repo)))
            nested = repo / 'nested'
            subprocess.run(['git', 'init', str(nested)], check=True, capture_output=True)
            self.assertFalse(same_repository(str(nested), str(repo)))
            self.assertFalse(same_repository('../one', str(repo)))

    def test_local_titles_are_bounded_and_redacted(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'session.jsonl'
            rows = [{'sessionId': 'session', 'cwd': directory, 'type': 'user', 'message': None},
                    {'sessionId': 'session', 'cwd': directory, 'type': 'user', 'message': {'content': 'Build a nicer onboarding flow'}}]
            path.write_text(''.join(json.dumps(r)+'\n' for r in rows))
            self.assertEqual(metadata(path)['name'], '')
            self.assertEqual(metadata(path, title=True)['name'], 'Build a nicer onboarding flow')
            rows[1]['message']['content'] = 'Fix api_key=sk-proj-' + 'A'*30
            path.write_text(''.join(json.dumps(r)+'\n' for r in rows))
            self.assertNotIn('A'*30, metadata(path, title=True)['name'])


if __name__ == '__main__':
    unittest.main()
