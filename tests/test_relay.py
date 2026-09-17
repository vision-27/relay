import json
import io
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import threading
import unittest
from zipfile import ZipFile
from urllib.error import HTTPError
from urllib.request import Request, urlopen

from relay.client import Client, git_info
from relay.mcp import Connector
from relay.server import Hub
from relay.store import Store
from relay.distribution import PACKAGE_FILES, client_archive

ROOT = Path(__file__).resolve().parents[1]


class RelayIntegrationTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        # Match the canonical roots used by onboarding. CI temp directories may
        # use macOS /var aliases or Windows DOS-short user names.
        self.directory = Path(self.temp.name).resolve()
        self.store = Store(self.directory / 'hub')
        self.server = Hub(('127.0.0.1', 0), self.store)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.url = f'http://127.0.0.1:{self.server.server_address[1]}'
        self.token = (self.directory / 'hub' / 'owner-token').read_text()
        self.alice = Client(self.url, self.token)
        self.alice.action('profile', {'name': 'Alice'})
        invitation = self.alice.action('invite', {'name': 'Bob'})
        self.bob_id, self.bob_token = invitation['id'], invitation['token']
        self.bob = Client(self.url, self.bob_token)
        self.project = self.alice.action('project', {'name': 'Product'})['id']
        self.a_session = self.alice.action('session', {'project_id': self.project, 'name': 'Alice / auth'})['id']
        self.b_session = self.bob.action('session', {'project_id': self.project, 'name': 'Bob / billing'})['id']

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join()
        self.temp.cleanup()

    def checkpoint(self, **overrides):
        return dict(session_id=self.a_session, title='Organisation authentication',
                    summary='Organisation authentication scopes access to an organisation.',
                    decisions='JWT carries organisation_id. Client-supplied headers are not trusted.',
                    constraints='Cache keys must include organisation_id.',
                    rejected='A global user cache leaked access between organisations in a local test.',
                    assumptions='Multi-organisation switching is untested.',
                    evidence='src/auth.py:12 at abc123; selected test output: 4 passed.',
                    commit_sha='abc123', branch='feature/auth', **overrides)

    def test_two_developer_handoff_and_offline_retrieval(self):
        feature = self.alice.action('checkpoint', self.checkpoint())
        result = self.bob.request('/api/search?project_id=' + self.project + '&q=cache&commit=def456')
        self.assertEqual(result['results'][0]['feature']['id'], feature['id'])
        self.assertEqual(result['results'][0]['revision_status'], 'different_revision')
        self.assertIn('organisation_id', result['results'][0]['feature']['checkpoint']['constraints'])
        question = self.bob.action('question', {'feature_id': feature['id'], 'body': 'Can billing trust organisation_id?'})
        self.assertEqual(question['status'], 'queued')
        self.alice.action('answer', {'question_id': question['id'], 'answer': 'Yes, after JWT verification.', 'evidence': 'src/auth.py:12'})
        self.assertEqual(self.bob.request('/api/state')['questions'][0]['answer'], 'Yes, after JWT verification.')
        self.alice.action('offline', {'session_id': self.a_session})
        self.assertFalse(next(s for s in self.bob.request('/api/state')['sessions'] if s['id']==self.a_session)['online'])
        self.assertEqual(len(self.bob.request('/api/history/' + feature['id'])), 1)

    def test_cannot_publish_as_another_session_or_answer_for_it(self):
        with self.assertRaisesRegex(ValueError, 'Only this session'):
            self.bob.action('checkpoint', self.checkpoint())
        feature = self.alice.action('checkpoint', self.checkpoint())
        question = self.bob.action('question', {'feature_id': feature['id'], 'body': 'Why?'})
        with self.assertRaisesRegex(ValueError, 'Only this session'):
            self.bob.action('answer', {'question_id': question['id'], 'answer': 'Forged answer'})
        with self.assertRaisesRegex(ValueError, 'Only this session'):
            self.bob.action('heartbeat', {'session_id': self.a_session})

    def test_version_conflict_and_immutable_history(self):
        feature = self.alice.action('checkpoint', self.checkpoint())
        update = self.checkpoint(feature_id=feature['id'], base_version=1)
        update['summary'] = 'Updated constraints'
        self.alice.action('checkpoint', update)
        with self.assertRaisesRegex(ValueError, 'Checkpoint changed'):
            self.alice.action('checkpoint', update)
        history = self.bob.request('/api/history/' + feature['id'])
        self.assertEqual([v['version'] for v in history], [2, 1])
        self.assertNotEqual(history[0]['checkpoint']['summary'], history[1]['checkpoint']['summary'])

    def test_ownership_transfer_preserves_attribution(self):
        feature = self.alice.action('checkpoint', self.checkpoint())
        self.alice.action('transfer', {'feature_id': feature['id'], 'session_id': self.b_session})
        with self.assertRaisesRegex(ValueError, 'another session'):
            self.alice.action('checkpoint', self.checkpoint(feature_id=feature['id'], base_version=1))
        data = self.checkpoint(feature_id=feature['id'], base_version=1)
        data['session_id'] = self.b_session
        self.bob.action('checkpoint', data)
        history = self.bob.request('/api/history/' + feature['id'])
        self.assertEqual([v['checkpoint']['author'] for v in history], ['Bob', 'Alice'])

    def test_revocation_and_invite_permissions(self):
        with self.assertRaisesRegex(ValueError, 'Only the workspace owner'):
            self.bob.action('invite', {'name': 'Mallory'})
        self.alice.action('revoke', {'member_id': self.bob_id})
        with self.assertRaisesRegex(ValueError, 'valid workspace access token'):
            self.bob.request('/api/state')

    def test_client_download_requires_member_and_extracted_cli_runs(self):
        url = self.url + '/api/download/relay-client.zip'
        with self.assertRaises(HTTPError) as caught:
            urlopen(url)
        self.assertEqual(caught.exception.code, 401)
        req = Request(url, headers={'Authorization': 'Bearer ' + self.bob_token})
        with urlopen(req) as response:
            self.assertEqual(response.headers.get_content_type(), 'application/zip')
            self.assertIn('attachment', response.headers['Content-Disposition'])
            payload = response.read()
        with ZipFile(io.BytesIO(payload)) as archive:
            expected = {'relay-workspace/relay/' + name for name in PACKAGE_FILES}
            expected.add('relay-workspace/START_HERE.txt')
            self.assertEqual(set(archive.namelist()), expected)
            self.assertIsNone(archive.testzip())
            archive.extractall(self.directory / 'download')
        result = subprocess.run([sys.executable, '-m', 'relay', 'start', '--help'],
            cwd=self.directory / 'download/relay-workspace', capture_output=True, text=True, timeout=15)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn('--url', result.stdout)
        self.alice.action('revoke', {'member_id': self.bob_id})
        with self.assertRaises(HTTPError) as caught:
            urlopen(req)
        self.assertEqual(caught.exception.code, 401)

    def test_client_archive_ignores_unlisted_files(self):
        package = self.directory / 'fake-package'
        for name in PACKAGE_FILES:
            target = package / name
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_text('fixture', encoding='utf-8')
        for name in ('.env', 'private.py', '.relay/owner-token', 'web/private.json'):
            target = package / name
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_text('NEVER-SHARE-THIS', encoding='utf-8')
        with ZipFile(io.BytesIO(client_archive(package))) as archive:
            for name in archive.namelist():
                self.assertNotIn(b'NEVER-SHARE-THIS', archive.read(name))

    def test_atomic_rejection_leaves_no_partial_feature(self):
        data = self.checkpoint()
        data['summary'] = ''
        with self.assertRaisesRegex(ValueError, 'summary is required'):
            self.alice.action('checkpoint', data)
        self.assertEqual(self.alice.request('/api/state')['features'], [])

    def test_http_origin_csrf_auth_and_local_bootstrap(self):
        for headers, path, body in [({}, '/api/state', None),
                ({'Origin': 'https://evil.example', 'Authorization': 'Bearer '+self.token}, '/api/state', None),
                ({'Host': 'evil.example'}, '/health', None),
                ({'Content-Type': 'application/json'}, '/api/local-session', b'{}')]:
            with self.assertRaises(HTTPError) as caught:
                urlopen(Request(self.url+path, data=body, headers=headers))
            self.assertIn(caught.exception.code, (401,403))
        req = Request(self.url+'/api/local-session', data=b'{}', headers={'Content-Type':'application/json','X-Relay-Client':'web'})
        with urlopen(req) as res:
            self.assertIn('HttpOnly', res.headers['Set-Cookie'])
            self.assertNotIn('token', json.load(res))
        self.server.public_origin = 'https://relay.example'
        with self.assertRaises(HTTPError) as caught:
            urlopen(req)
        self.assertEqual(caught.exception.code, 401)

    def test_input_validation_and_unknown_paths(self):
        with self.assertRaisesRegex(ValueError, 'must be text'):
            self.alice.action('project', {'name': ['bad']})
        with self.assertRaisesRegex(ValueError, 'exceeds'):
            self.alice.action('project', {'name': 'a'*121})
        with self.assertRaisesRegex(ValueError, 'Not found'):
            self.alice.request('/api/nope')

    def test_static_assets_and_content_security_policy(self):
        for path in ('/', '/app.js', '/style.css', '/favicon.svg'):
            with urlopen(self.url+path) as response:
                self.assertEqual(response.status, 200)
                self.assertIn("frame-ancestors 'none'", response.headers['Content-Security-Policy'])
                self.assertGreater(len(response.read()), 100)

    def repo(self):
        repo = self.directory / 'repo'
        repo.mkdir()
        def git(*args):
            subprocess.run(['git','-C',str(repo),*args], check=True, capture_output=True)
        git('init')
        git('config', 'user.email', 'test@example.test')
        git('config', 'user.name', 'Integration Test')
        (repo/'auth.py').write_text('ORGANISATION_SCOPED = True\n')
        git('add', 'auth.py')
        git('commit', '-m', 'Initial feature')
        return repo

    def test_mcp_two_local_connectors_and_git_provenance(self):
        repo = self.repo()
        config = {'url':self.url,'token':self.token,'session_id':self.a_session,'project_id':self.project,'repo':str(repo)}
        connector = Connector(config, self.alice)
        result = connector.call('relay_publish', {'title':'Organisation auth','summary':'Scopes access','constraints':'Cache key includes organisation_id'})
        bob_config = dict(config, token=self.bob_token, session_id=self.b_session)
        bob_connector = Connector(bob_config, self.bob)
        found = bob_connector.call('relay_search', {'query':'organisation_id'})['results'][0]
        self.assertEqual(found['revision_status'], 'same_revision')
        self.assertEqual(found['feature']['checkpoint']['commit_sha'], git_info(repo)['commit_sha'])
        q = bob_connector.call('relay_ask', {'feature_id':result['id'],'question':'Why the cache constraint?'})
        self.assertEqual(connector.call('relay_inbox', {})[0]['id'], q['id'])
        connector.call('relay_answer', {'question_id':q['id'],'answer':'Avoid cross-organisation cache hits.'})
        self.assertIn('cross-organisation', bob_connector.call('relay_inbox', {})[0]['answer'])
        other_project = self.alice.action('project', {'name':'Other'})['id']
        limited = Connector(dict(config, project_id=other_project), self.alice)
        with self.assertRaisesRegex(ValueError, 'not in this connector'):
            limited.call('relay_history', {'feature_id':result['id']})

    def test_stdio_protocol_subprocess(self):
        repo = self.repo()
        config = self.directory/'connector.json'
        config.write_text(json.dumps(dict(url=self.url,token=self.token,session_id=self.a_session,project_id=self.project,repo=str(repo))))
        messages = [
            {'jsonrpc':'2.0','id':1,'method':'initialize','params':{'protocolVersion':'2025-06-18','capabilities':{},'clientInfo':{'name':'test','version':'1'}}},
            {'jsonrpc':'2.0','method':'notifications/initialized'},
            {'jsonrpc':'2.0','id':2,'method':'tools/list'},
            {'jsonrpc':'2.0','id':3,'method':'tools/call','params':{'name':'relay_publish','arguments':{'title':'Auth','summary':'Unicode organisation ✓'}}},
            {'jsonrpc':'2.0','id':4,'method':'tools/call','params':{'name':'relay_inbox','arguments':{}}},
            {'jsonrpc':'2.0','id':5,'method':'tools/call','params':{'name':'missing','arguments':{}}},
        ]
        proc = subprocess.run([sys.executable,'-m','relay','mcp','--config',str(config)], input='\n'.join(json.dumps(m) for m in messages)+'\n', text=True, encoding='utf-8', capture_output=True, cwd=ROOT, timeout=30)
        self.assertEqual(proc.returncode, 0, proc.stderr)
        replies = [json.loads(line) for line in proc.stdout.splitlines()]
        self.assertEqual([r['id'] for r in replies], [1,2,3,4,5])
        self.assertEqual({t['name'] for t in replies[1]['result']['tools']}, {
            'relay_project', 'relay_search', 'relay_history', 'relay_publish',
            'relay_ask', 'relay_clarify', 'relay_inbox', 'relay_answer',
            'relay_work_plan', 'relay_work_review', 'relay_work_message', 'relay_work_update',
            'relay_live_inbox', 'relay_live_ack'})
        self.assertNotIn('isError', replies[2]['result'])
        self.assertTrue(replies[4]['result']['isError'])
        self.assertFalse(self.alice.request('/api/state')['sessions'][0]['online'])

    def test_publish_requires_explicit_share_and_never_scans_repo(self):
        repo = self.repo()
        config = self.directory/'connector.json'
        config.write_text(json.dumps(dict(url=self.url,token=self.token,session_id=self.a_session,project_id=self.project,repo=str(repo))))
        checkpoint = self.directory/'checkpoint.json'
        checkpoint.write_text(json.dumps({'title':'Auth','summary':'Selected notes only'}))
        command = [sys.executable,'-m','relay','publish','--config',str(config),'--file',str(checkpoint)]
        preview = subprocess.run(command,capture_output=True,text=True,cwd=ROOT,timeout=20)
        self.assertEqual(preview.returncode,0,preview.stderr)
        self.assertIn('Preview only',preview.stdout)
        self.assertEqual(self.alice.request('/api/state')['features'],[])
        shared = subprocess.run(command+['--share'],capture_output=True,text=True,cwd=ROOT,timeout=20)
        self.assertEqual(shared.returncode,0,shared.stderr)
        self.assertEqual(len(self.alice.request('/api/state')['features']),1)


if __name__ == '__main__':
    unittest.main()
