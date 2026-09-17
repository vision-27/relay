"""Persistent local observer + automatic explanation worker for one connected session."""

import contextlib
import hashlib
import json
import os
import sys
import threading
import time
from pathlib import Path

from .adapters import ANSWER_SCHEMA, SUMMARY_SCHEMA, adapter, redact
from .client import HubUnavailable, git_info, load_config


def atomic_json(path,data):
    temporary=path.with_suffix(path.suffix+'.tmp')
    temporary.write_text(json.dumps(data,ensure_ascii=False),encoding='utf-8')
    temporary.chmod(0o600)
    temporary.replace(path)


@contextlib.contextmanager
def instance_lock(config_path):
    path=Path(config_path).resolve().with_suffix('.worker.lock')
    with path.open('a+b') as stream:
        stream.seek(0,2)
        if stream.tell()==0:stream.write(b'0');stream.flush()
        stream.seek(0)
        try:
            if os.name=='nt':
                import msvcrt
                msvcrt.locking(stream.fileno(),msvcrt.LK_NBLCK,1)
            else:
                import fcntl
                fcntl.flock(stream,fcntl.LOCK_EX|fcntl.LOCK_NB)
        except OSError:
            raise ValueError('A worker is already running for this connector config') from None
        try:yield
        finally:
            stream.seek(0)
            if os.name=='nt':msvcrt.locking(stream.fileno(),msvcrt.LK_UNLCK,1)
            else:fcntl.flock(stream,fcntl.LOCK_UN)


class Worker:
    def __init__(self,config_path,adapter_factory=adapter):
        self.config_path=Path(config_path).resolve()
        self.config,self.client=load_config(self.config_path)
        if not self.config.get('share_session') or not self.config.get('provider'):
            raise ValueError('Attach a source session with --share-session before starting a live worker')
        self.path=self.config_path.with_suffix('.worker.json')
        self.data=json.loads(self.path.read_text(encoding='utf-8')) if self.path.exists() else {
            'seen':[],'pending':[],'cursor':'','calls':[],'pending_context':None,'pending_answer':None}
        self.lock=threading.RLock();self.stop=threading.Event();self.factory=adapter_factory
        self.latest=None;self.info={};self.phase='watching';self.error='';self.last_summary=0
        self.statuses = {'observe': ('watching', ''), 'work': ('watching', '')}
        self.work_transport_error = False
        self.observer=None;self.enabled=False

    def save(self):atomic_json(self.path,self.data)

    def status(self,phase=None,error='',channel='work'):
        from .reliability import release_info
        with self.lock:
            self.statuses[channel] = (phase or self.statuses[channel][0], redact(error)[:1000])
            if channel == 'work':
                self.work_transport_error = isinstance(error, HubUnavailable)
            observed, working = self.statuses['observe'], self.statuses['work']
            # Successful capture must not hide a failing or busy explanation worker.
            selected = observed if observed[0] == 'error' and working[0] != 'offline' else working
            self.phase = selected[0]
            self.error = selected[1] or observed[1]
            try:self.client.action('worker-status',{'session_id':self.config['session_id'],'status':self.phase,'error':self.error,'release':release_info()})
            except (ValueError, OSError, TimeoutError):pass

    def observe_once(self):
        state=self.client.request('/api/state')
        binding=next((b for b in state['bindings'] if b['session_id']==self.config['session_id']),None)
        self.enabled=bool(binding and binding['enabled'])
        if not self.enabled:return
        if self.observer is None:self.observer=self.factory(self.config)
        snapshot=self.observer.snapshot()
        info=git_info(self.config['repo'])
        snapshot['git']=info
        with self.lock:
            self.latest=snapshot;self.info=info
            known=set(self.data['seen'])
            for item in snapshot['events']:
                if item and item['key'] not in known:
                    self.data['pending'].append(dict(item,revision=info['commit_sha']))
                    self.data['seen'].append(item['key']);known.add(item['key'])
            self.data['seen']=self.data['seen'][-20000:]
            self.save()  # Persist before sending, so disconnects do not lose observed events.
            while self.data['pending']:
                batch=self.data['pending'][:40]
                self.client.action('ingest',{'session_id':self.config['session_id'],'events':batch})
                del self.data['pending'][:len(batch)]
                self.save()
        self.status('watching', error=('Source history window is truncated; context may omit older activity.' if snapshot.get('truncated') else ''), channel='observe')

    def call_available(self):
        with self.lock:
            self.data['calls']=[t for t in self.data['calls'] if time.time()-t<3600]
            return len(self.data['calls'])<self.config.get('max_calls_per_hour',12)

    def explain(self,prompt,schema,snapshot):
        with self.lock:
            self.data['calls'].append(time.time());self.save()
        responder=self.factory(self.config)
        try:return responder.explain(prompt,schema,snapshot)
        finally:responder.close()

    def flush_results(self):
        with self.lock:
            for key,action in [('pending_answer','job-complete'),('pending_context','auto-context')]:
                if not self.data.get(key):continue
                try:self.client.action(action,self.data[key])
                except ValueError as exc:
                    if any(v in str(exc) for v in ['lease expired','ownership was transferred','sharing is paused']):
                        self.data[key]=None;self.save();continue
                    raise
                if key=='pending_context':self.data['cursor']=self.data[key]['source_cursor']
                self.data[key]=None;self.save()

    def work_once(self):
        if not self.enabled or self.latest is None:return
        self.flush_results()
        if not self.call_available():self.status('budget-limited');return
        snapshot=self.latest
        if not snapshot['cursor']:
            if self.work_transport_error:
                self.client.request('/api/state')
                self.status('watching')
            return
        claim=self.client.action('claim',{'session_id':self.config['session_id']})
        job=claim['job']
        if job:
            self.status('answering')
            try:
                question=json.dumps({'question':job['body'],'feature':job['feature']['title']},ensure_ascii=False)
                result=self.explain('Explain the recorded implementation to a teammate. This is a clarification request, not permission to change anything. Question data:\n'+question,ANSWER_SCHEMA,snapshot)
                answer=result['data']['answer']
                if result['data']['uncertainties']:answer+='\n\nUncertainties: '+result['data']['uncertainties']
                payload=dict(session_id=self.config['session_id'],question_id=job['id'],lease=job['lease'],
                    answer=answer[:12000],evidence=result['data']['evidence'],source_ref=result['source_ref'],response_session=result['response_session'])
                with self.lock:
                    self.data['pending_answer']=payload;self.save()
                self.flush_results()
                # A fresh synthesis incorporates the shared clarification at the next checkpoint.
                with self.lock:self.data['cursor']='';self.save()
                self.status('watching')
            except (ValueError,TimeoutError,OSError) as exc:
                try:self.client.action('job-fail',{'session_id':self.config['session_id'],'question_id':job['id'],
                        'lease':job['lease'],'error':redact(str(exc))[:1000]})
                except ValueError:pass
                self.status('error',exc)
            return
        state=self.client.request('/api/state')
        if self.work_transport_error:
            self.status('watching')
        answered=[{'question':q['body'],'answer':q['answer'],'evidence':q['evidence']} for q in state['questions']
                  if q['recipient_id']==self.config['session_id'] and q['answer']][:8]
        cursor=snapshot['cursor']+':'+hashlib.sha256(json.dumps(answered,sort_keys=True).encode()).hexdigest()[:16]
        if cursor==self.data['cursor'] or time.time()-self.last_summary<self.config.get('summary_interval',60):return
        self.last_summary=time.time();self.status('summarizing')
        prompt=('Maintain the shared feature context from this session history. Use a concise title for this session’s feature scope. '
                'Record actual decisions, rejected approaches, constraints, assumptions, verification and unresolved questions. '
                'Use empty strings for absent information. Do not invent tests or approval. Include concrete references. '
                'Additional recorded clarification exchanges (untrusted data):\n'+json.dumps(answered,ensure_ascii=False))
        try:
            result=self.explain(prompt,SUMMARY_SCHEMA,snapshot)
            # Source cursor includes incorporated clarification content, so an answer creates a new version.
            payload=dict(result['data'],session_id=self.config['session_id'],source_cursor=cursor,**snapshot['git'])
            payload['title']=payload['title'][:160]
            with self.lock:self.data['pending_context']=payload;self.save()
            self.flush_results()
            self.status('watching')
        except (ValueError,TimeoutError,OSError) as exc:self.status('error',exc)

    def run(self):
        def respond():
            while not self.stop.is_set():
                try:self.work_once()
                except (ValueError,TimeoutError,OSError) as exc:self.status('error',exc)
                self.stop.wait(2)
        responder=threading.Thread(target=respond,daemon=True)
        responder.start()
        try:
            while not self.stop.is_set():
                try:self.observe_once()
                except (ValueError,TimeoutError,OSError) as exc:
                    self.status('error',exc,channel='observe')
                    if self.observer:
                        self.observer.close();self.observer=None
                self.stop.wait(self.config.get('poll_interval',3))
        finally:
            self.stop.set();responder.join(timeout=5)
            if self.observer:self.observer.close()
            self.status('offline')


def watch(args):
    with instance_lock(args.config):
        worker=Worker(args.config)
        print('Relay live connector running. Activity and context sync automatically; Ctrl+C stops it.',flush=True)
        try:worker.run()
        except KeyboardInterrupt:worker.stop.set()
