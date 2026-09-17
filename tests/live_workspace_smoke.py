"""Real cross-provider hub/worker round trip using isolated smoke sessions.

Only pass evidence files created by tests/live_smoke.py. Model usage is required.
"""
import argparse
import json
from pathlib import Path
import subprocess
import sys
import threading
import uuid

sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
from relay.client import Client
from relay.mcp import Connector
from relay.server import Hub
from relay.store import Store
from relay.worker import Worker, atomic_json


def main():
    parser=argparse.ArgumentParser()
    parser.add_argument('--codex-evidence',required=True)
    parser.add_argument('--claude-evidence',required=True)
    parser.add_argument('--live',required=True,action='store_true')
    args=parser.parse_args()
    root=Path(__file__).resolve().parents[1]/'.relay'/'integration'/str(uuid.uuid4())
    store=Store(root/'hub');hub=Hub(('127.0.0.1',0),store)
    thread=threading.Thread(target=hub.serve_forever,daemon=True);thread.start()
    url=f'http://127.0.0.1:{hub.server_address[1]}'
    owner=Client(url,(root/'hub'/'owner-token').read_text())
    owner.action('profile',{'name':'QA / Codex developer'})
    friend=owner.action('invite',{'name':'QA / Claude developer'})
    second=Client(url,friend['token']);project=owner.action('project',{'name':'Live adapter verification'})['id']
    workers=[];configs=[];features=[]
    try:
        for provider,evidence_file,client,token in [('codex',args.codex_evidence,owner,owner.token),('claude',args.claude_evidence,second,friend['token'])]:
            evidence_path=Path(evidence_file).resolve()
            smoke_root=Path(__file__).resolve().parents[1]/'.relay'/'smoke'
            if not evidence_path.is_relative_to(smoke_root):raise ValueError('Use an isolated smoke evidence file under .relay/smoke')
            evidence=json.loads(evidence_path.read_text(encoding='utf-8'))
            config=evidence['config'];repo=Path(config['repo'])
            if not repo.is_relative_to(smoke_root):raise ValueError('Smoke repository must remain under .relay/smoke')
            if not (repo/'.git').exists():
                subprocess.run(['git','-C',str(repo),'init'],check=True,capture_output=True)
                subprocess.run(['git','-C',str(repo),'-c','user.name=Relay QA','-c','user.email=qa@example.test','commit','--allow-empty','-m','Isolated Relay verification'],check=True,capture_output=True)
            session=client.action('session',{'project_id':project,'name':f'QA / {provider} source','machine':'Local integration test'})['id']
            feature=client.action('bind',{'session_id':session,'provider':provider,'source_id':config['source_id'],'title':f'{provider} source context'})['id']
            config.update(provider=provider,share_session=True,url=url,token=token,session_id=session,project_id=project,summary_interval=0)
            config_path=root/(provider+'.json');atomic_json(config_path,config)
            worker=Worker(config_path);workers.append(worker);configs.append(config);features.append(feature)
            worker.observe_once();worker.work_once()
            current=client.request('/api/state')
            feature_data=next(f for f in current['features'] if f['id']==feature)
            if feature_data['checkpoint']['origin']!='agent-derived':raise RuntimeError(f'{provider} automatic context failed: '+worker.error)
            print(json.dumps({'provider':provider,'stage':'automatic_context_published'}),flush=True)
        question=Connector(configs[1],second).call('relay_ask',{'feature_id':features[0],'question':'Why must the Atlas cache include organisation_id? Explain the original decision.'})
        workers[0].work_once()
        answer=next(q for q in second.request('/api/state')['questions'] if q['id']==question['id'])
        if not answer['answer'] or not answer['job']['response_session']:raise RuntimeError('Codex automatic answer failed: '+str(answer['job']))
        print(json.dumps({'stage':'claude_to_codex_clarification','result':'answered'}),flush=True)
        question2=Connector(configs[0],owner).call('relay_ask',{'feature_id':features[1],'question':'What can go wrong if the cache is global per user rather than per organisation?'})
        workers[1].work_once()
        answer2=next(q for q in owner.request('/api/state')['questions'] if q['id']==question2['id'])
        if not answer2['answer'] or not answer2['job']['response_session']:raise RuntimeError('Claude automatic answer failed: '+str(answer2['job']))
        print(json.dumps({'stage':'codex_to_claude_clarification','result':'answered'}),flush=True)
        workers[0].work_once();workers[1].work_once()
        state=owner.request('/api/state')
        if any(f['version']<3 or f['checkpoint']['origin']!='agent-derived' for f in state['features']):
            raise RuntimeError('Clarifications were not incorporated into updated context')
        report=dict(result='passed',observations=len(state['observations']),answers=len([q for q in state['questions'] if q['answer']]),
            features=[{'title':f['title'],'version':f['version'],'origin':f['checkpoint']['origin']} for f in state['features']],
            same_machine=True,hub_data=str(root/'hub'))
        atomic_json(root/'verification.json',report)
        print(json.dumps(dict(report,evidence=str(root/'verification.json'))),flush=True)
    finally:
        for worker in workers:
            if worker.observer:worker.observer.close()
            worker.status('offline')
        hub.shutdown();hub.server_close();thread.join()


if __name__=='__main__':main()
