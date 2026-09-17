import json
from pathlib import Path
import time
import unittest
from unittest.mock import patch
from urllib.request import Request, urlopen

import test_relay
from relay.adapters import ClaudeAdapter, CodexAdapter, SUMMARY_SCHEMA, ANSWER_SCHEMA, event, redact
from relay.client import Client
from relay.store import Store
from relay.worker import Worker, atomic_json, instance_lock


class LiveTests(unittest.TestCase):
    setUp=test_relay.RelayIntegrationTests.setUp
    tearDown=test_relay.RelayIntegrationTests.tearDown
    repo=test_relay.RelayIntegrationTests.repo

    def bind(self):
        return self.alice.action('bind',dict(session_id=self.a_session,provider='codex',source_id='source-auth',title='Auth'))['id']

    def test_migration_preserves_existing_records(self):
        fid=self.alice.action('checkpoint',dict(session_id=self.a_session,title='Old feature',summary='Preserved'))['id']
        Store(self.directory/'hub')
        self.assertEqual(self.alice.request('/api/history/'+fid)[0]['checkpoint']['summary'],'Preserved')
        self.bind()
        self.assertEqual(len(self.alice.request('/api/state')['features']),2)

    def test_source_binding_cannot_be_hijacked(self):
        with self.assertRaisesRegex(ValueError,'Only this session'):
            self.bob.action('bind',dict(session_id=self.a_session,provider='claude',source_id='stolen',title='Stolen'))
        self.bind()
        with self.assertRaisesRegex(ValueError,'different source'):
            self.alice.action('bind',dict(session_id=self.a_session,provider='codex',source_id='other',title='Other'))

    def test_ingestion_deduplication_and_pausing(self):
        self.bind()
        data={'session_id':self.a_session,'events':[event('a','assistant','Cache keys include organisation_id','source/t1')]}
        self.assertEqual(self.alice.action('ingest',data)['inserted'],1)
        self.assertEqual(self.alice.action('ingest',data)['inserted'],0)
        with self.assertRaisesRegex(ValueError,'Only this session'):
            self.bob.action('ingest',data)
        self.alice.action('session-toggle',dict(session_id=self.a_session,enabled=False))
        with self.assertRaisesRegex(ValueError,'paused'):
            self.alice.action('ingest',data)
        self.assertEqual(len(self.alice.request('/api/state')['observations']),1)

    def test_leases_are_exclusive_and_pause_invalidates_results(self):
        fid=self.bind()
        question=self.bob.action('question',dict(feature_id=fid,body='Why this cache key?'))
        self.assertTrue(question['automatic'])
        claim=self.alice.action('claim',dict(session_id=self.a_session))['job']
        self.assertEqual(self.alice.action('claim',dict(session_id=self.a_session)),{'job':None})
        self.alice.action('session-toggle',dict(session_id=self.a_session,enabled=False))
        self.alice.action('session-toggle',dict(session_id=self.a_session,enabled=True))
        with self.assertRaisesRegex(ValueError,'lease expired'):
            self.alice.action('job-complete',dict(session_id=self.a_session,question_id=question['id'],lease=claim['lease'],answer='late'))
        again=self.alice.action('claim',dict(session_id=self.a_session))['job']
        self.assertNotEqual(again['lease'],claim['lease'])

    def test_failed_job_can_be_retried_only_by_owner(self):
        fid=self.bind();question=self.bob.action('question',dict(feature_id=fid,body='Explain'))
        claim=self.alice.action('claim',dict(session_id=self.a_session))['job']
        self.alice.action('job-fail',dict(session_id=self.a_session,question_id=question['id'],lease=claim['lease'],error='Source unavailable'))
        self.assertEqual(self.bob.request('/api/state')['questions'][0]['job']['status'],'failed')
        with self.assertRaisesRegex(ValueError,'Only this session'):
            self.bob.action('job-retry',dict(session_id=self.a_session,question_id=question['id']))
        self.alice.action('job-retry',dict(session_id=self.a_session,question_id=question['id']))
        self.assertIsNotNone(self.alice.action('claim',dict(session_id=self.a_session))['job'])

    def test_auto_context_dedupes_and_preserves_provenance(self):
        fid=self.bind()
        data=dict(session_id=self.a_session,source_cursor='turn-1',title='Auth',summary='Verified account scoping',commit_sha='123',dirty=True)
        self.alice.action('auto-context',data)
        self.assertTrue(self.alice.action('auto-context',data)['duplicate'])
        history=self.alice.request('/api/history/'+fid)
        self.assertEqual(len(history),2)
        self.assertEqual(history[0]['checkpoint']['origin'],'agent-derived')
        self.assertEqual(history[0]['checkpoint']['source_cursor'],'turn-1')
        self.assertTrue(history[0]['checkpoint']['dirty'])
        self.alice.action('transfer',dict(feature_id=fid,session_id=self.b_session))
        data['source_cursor']='turn-2'
        with self.assertRaisesRegex(ValueError,'transferred'):
            self.alice.action('auto-context',data)

    def test_automatic_worker_handoff_from_source_events(self):
        fid=self.bind();repo=self.repo();path=self.directory/'config.json'
        atomic_json(path,dict(url=self.url,token=self.token,session_id=self.a_session,project_id=self.project,repo=str(repo),provider='codex',source_id='source-auth',share_session=True,summary_interval=0))
        facts={'cursor':'turn-1','text':'Cache keys include organisation_id to prevent cross-tenant reads.'}
        calls=[]
        class FakeAgent:
            def __init__(self,config):pass
            def snapshot(self):return {'cursor':facts['cursor'],'source_ref':'source-auth/'+facts['cursor'],'events':[event(facts['cursor'],'assistant',facts['text'],'source-auth/'+facts['cursor'])]}
            def explain(self,prompt,schema,snapshot):
                calls.append(prompt)
                if schema==SUMMARY_SCHEMA:
                    data={k:'' for k in schema['required']};data.update(title='Organisation auth',summary=facts['text'],constraints=facts['text'],evidence='auth.py:1')
                else:data=dict(answer=facts['text'],evidence='auth.py:1',uncertainties='')
                return dict(data=data,response_session='separate-fork',source_ref=snapshot['source_ref'])
            def close(self):pass
        worker=Worker(path,FakeAgent)
        worker.observe_once();worker.work_once()
        shared=self.bob.request('/api/state')
        self.assertEqual(len(shared['observations']),1)
        self.assertIn('cross-tenant',shared['features'][0]['checkpoint']['summary'])
        worker.observe_once();worker.work_once()
        self.assertEqual(len(calls),1)  # Same source revision does not trigger another model call.
        question=self.bob.action('question',dict(feature_id=fid,body='Why organisation_id?'))
        worker.work_once()
        answered=self.bob.request('/api/state')['questions'][0]
        self.assertEqual(answered['id'],question['id']);self.assertIn('cross-tenant',answered['answer'])
        self.assertEqual(answered['job']['response_session'],'separate-fork')
        worker.work_once()  # Clarification is incorporated into a new context version.
        self.assertEqual(len(self.alice.request('/api/history/'+fid)),3)
        facts.update(cursor='turn-2',text='The cache also varies by permission version.')
        worker.observe_once();worker.work_once()
        self.assertIn('permission version',self.bob.request('/api/state')['features'][0]['checkpoint']['summary'])
        for index in range(10):
            recent=self.bob.action('question',dict(feature_id=fid,body=f'Clarification number {index}'))
            self.alice.action('answer',dict(session_id=self.a_session,question_id=recent['id'],answer=f'Recorded answer {index}'))
        worker.work_once()
        self.assertIn('Clarification number 9',calls[-1])
        self.assertNotIn('Clarification number 0',calls[-1])

    def test_event_outbox_survives_failed_upload(self):
        self.bind();repo=self.repo();path=self.directory/'config.json'
        atomic_json(path,dict(url=self.url,token=self.token,session_id=self.a_session,project_id=self.project,repo=str(repo),provider='codex',source_id='source-auth',share_session=True))
        class Source:
            def __init__(self,config):pass
            def snapshot(self):return {'cursor':'','events':[event('a','user','Build auth','source/a')]}
            def close(self):pass
        worker=Worker(path,Source);original=worker.client.action
        def fail(name,data):
            if name=='ingest':raise ValueError('offline')
            return original(name,data)
        worker.client.action=fail
        with self.assertRaisesRegex(ValueError,'offline'):worker.observe_once()
        self.assertEqual(len(json.loads(worker.path.read_text())['pending']),1)
        restored=Worker(path,Source);restored.observe_once()
        self.assertEqual(len(self.bob.request('/api/state')['observations']),1)
        self.assertEqual(restored.data['pending'],[])

    def test_sse_notifies_on_new_activity(self):
        self.bind()
        request=Request(self.url+'/api/stream',headers={'Authorization':'Bearer '+self.token})
        with urlopen(request,timeout=5) as response:
            self.assertEqual(response.headers['Content-Type'],'text/event-stream')
            self.assertEqual(response.readline().strip(),b'event: changed')
            response.readline();response.readline()
            self.alice.action('ingest',dict(session_id=self.a_session,events=[event('b','turn','Completed','source/b')]))
            lines=[response.readline() for _ in range(3)]
            self.assertTrue(any(b'event: changed' in line for line in lines))


class AdapterTests(unittest.TestCase):
    def test_redacts_credentials_and_excludes_thinking(self):
        text=redact('API_KEY=abc123secret Bearer abcdefghijklmnopqrst sk-proj-abcdefghijklmnopqrstuvwxyz')
        self.assertNotIn('abc123secret',text);self.assertNotIn('abcdefghijklmnopqrst',text)

    def test_claude_transcript_partial_record_and_scope(self):
        import tempfile
        with tempfile.TemporaryDirectory() as directory:
            path=Path(directory)/'source.jsonl'
            rows=[dict(type='user',uuid='u1',sessionId='sid',cwd=directory,message={'content':'Build organisation auth'}),
                  dict(type='assistant',uuid='a1',sessionId='sid',cwd=directory,message={'content':[{'type':'thinking','thinking':'PRIVATE CHAIN'},{'type':'text','text':'Use scoped cache keys.'}], 'stop_reason':'end_turn'})]
            path.write_text(''.join(json.dumps(r)+'\n' for r in rows)+'{"partial":',encoding='utf-8')
            adapter=ClaudeAdapter(dict(repo=directory,source_id='sid',source_file=str(path),executable='claude'))
            snapshot=adapter.snapshot()
            self.assertEqual(snapshot['cursor'],'a1');self.assertNotIn('PRIVATE CHAIN',json.dumps(snapshot))
            self.assertEqual(len(snapshot['events']),3)
            adapter.repo=str(Path(directory)/'other')
            with self.assertRaisesRegex(ValueError,'different repository'):adapter.snapshot()

    def test_claude_explanation_forks_with_no_tools_and_frozen_prefix(self):
        import tempfile
        with tempfile.TemporaryDirectory() as directory:
            path=Path(directory)/'source.jsonl'
            rows=[dict(type='assistant',uuid='a1',sessionId='sid',cwd=directory,message={'content':[{'type':'text','text':'Earlier context'}],'stop_reason':'end_turn'}),
                  dict(type='user',uuid='later',sessionId='sid',cwd=directory,message={'content':'Later ongoing work'})]
            path.write_text(''.join(json.dumps(r)+'\n' for r in rows),encoding='utf-8')
            adapter=ClaudeAdapter(dict(repo=directory,source_id='sid',source_file=str(path),executable='claude'))
            def run(command,**kwargs):
                frozen=Path(command[command.index('--resume')+1]).read_text()
                self.assertNotIn('Later ongoing work',frozen)
                self.assertIn('--fork-session',command)
                self.assertEqual(command[command.index('--tools')+1],'')
                self.assertIn('mcp__*',command)
                class Result:
                    returncode=0;stderr='';stdout=json.dumps({'session_id':'fork','structured_output':{'answer':'Earlier context','evidence':'source/a1','uncertainties':''}})
                return Result()
            with patch('relay.adapters.subprocess.run',run):
                result=adapter.explain('Why?',ANSWER_SCHEMA,adapter.snapshot())
            self.assertEqual(result['response_session'],'fork')
            self.assertIn('Later ongoing work',path.read_text())

    def test_worker_single_instance_lock(self):
        import tempfile
        with tempfile.TemporaryDirectory() as directory:
            path=Path(directory)/'config.json'
            with instance_lock(path):
                with self.assertRaisesRegex(ValueError,'already running'):
                    with instance_lock(path):pass


if __name__=='__main__':unittest.main()
