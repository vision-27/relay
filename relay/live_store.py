"""Live session metadata, idempotent event ingestion, and leased clarification jobs."""

import json
import secrets
import time

from .store import Problem, field, identity


def migrate(db):
    db.executescript("""
    CREATE TABLE IF NOT EXISTS bindings (
      session_id TEXT PRIMARY KEY REFERENCES sessions(id),
      provider TEXT NOT NULL, source_id TEXT NOT NULL,
      feature_id TEXT NOT NULL REFERENCES features(id),
      enabled INTEGER NOT NULL DEFAULT 1, auto_answer INTEGER NOT NULL DEFAULT 1,
      status TEXT NOT NULL DEFAULT 'connecting', error TEXT NOT NULL DEFAULT '',
      cursor TEXT NOT NULL DEFAULT '', updated REAL NOT NULL,
      worker_seen REAL NOT NULL DEFAULT 0);
    CREATE TABLE IF NOT EXISTS observations (
      id INTEGER PRIMARY KEY AUTOINCREMENT, project_id TEXT REFERENCES projects(id),
      session_id TEXT REFERENCES sessions(id), event_key TEXT NOT NULL,
      kind TEXT NOT NULL, body TEXT NOT NULL, source_ref TEXT NOT NULL,
      revision TEXT NOT NULL, created REAL NOT NULL,
      UNIQUE(session_id,event_key));
    CREATE TABLE IF NOT EXISTS jobs (
      question_id TEXT PRIMARY KEY REFERENCES questions(id),
      status TEXT NOT NULL DEFAULT 'queued', lease TEXT NOT NULL DEFAULT '',
      lease_until REAL NOT NULL DEFAULT 0, attempts INTEGER NOT NULL DEFAULT 0,
      error TEXT NOT NULL DEFAULT '', source_ref TEXT NOT NULL DEFAULT '',
      response_session TEXT NOT NULL DEFAULT '', updated REAL NOT NULL);
    CREATE INDEX IF NOT EXISTS observations_project ON observations(project_id,id);
    """)


def state(db):
    bindings = [dict(r) for r in db.execute("SELECT b.*,s.project_id FROM bindings b JOIN sessions s ON s.id=b.session_id")]
    for binding in bindings:
        binding['worker_online'] = time.time() - binding['worker_seen'] < 65
    observations = [dict(r) for r in db.execute("""SELECT o.*,s.name AS session_name,m.name AS author,b.provider
        FROM observations o JOIN sessions s ON s.id=o.session_id JOIN members m ON m.id=s.member_id
        LEFT JOIN bindings b ON b.session_id=s.id ORDER BY o.id DESC LIMIT 250""")]
    jobs = {r['question_id']: dict(r) for r in db.execute("""SELECT question_id,status,attempts,error,
        source_ref,response_session,updated FROM jobs""")}
    return bindings, observations, jobs


def mutate(store, db, action, data, member, now):
    if action not in {'bind', 'ingest', 'worker-status', 'session-toggle', 'auto-context', 'claim', 'job-complete', 'job-fail', 'job-retry'}:
        return None
    sid = field(data, 'session_id', 64)
    session = store.own_session(db, member, sid)
    binding = db.execute('SELECT * FROM bindings WHERE session_id=?', (sid,)).fetchone()
    if action == 'bind':
        provider = field(data, 'provider', 20)
        if provider not in {'codex', 'claude'}:
            raise Problem('Supported agents: codex and claude')
        source = field(data, 'source_id', 160)
        if binding:
            if binding['provider'] != provider or binding['source_id'] != source:
                raise Problem('This Relay session is already attached to a different source. Create a new connection.', 409)
            return {'id': binding['feature_id']}
        title = field(data, 'title', 160)
        fid = identity()
        db.execute('INSERT INTO features VALUES(?,?,?,?,?)', (fid, session['project_id'], sid, title, now))
        cp = dict(title=title, summary='Connected session. Waiting for the first automatic context update.',
                  **{k: '' for k in ('decisions','rejected','constraints','assumptions','tests','questions','evidence')},
                  branch=session['branch'], commit_sha=session['commit_sha'], dirty=bool(session['dirty']),
                  author=member['name'], author_id=member['id'], session_id=sid,
                  origin='pending', source_id=source, source_cursor='')
        db.execute('INSERT INTO checkpoints VALUES(?,?,?,?,?)', (identity(),fid,1,json.dumps(cp),now))
        db.execute('INSERT INTO bindings(session_id,provider,source_id,feature_id,updated) VALUES(?,?,?,?,?)',
                   (sid,provider,source,fid,now))
        store.event(db,session['project_id'],member,'connected',f'Connected {provider}: {title}')
        return {'id':fid}
    if not binding:
        raise Problem('Connect a source agent session first', 409)
    if action == 'session-toggle':
        enabled = bool(data.get('enabled'))
        db.execute('UPDATE bindings SET enabled=?,status=?,updated=? WHERE session_id=?',
                   (int(enabled),'connecting' if enabled else 'paused',now,sid))
        # Cancels leases so a response finishing after pause cannot be published.
        if not enabled:
            db.execute("UPDATE jobs SET status='queued',lease='',lease_until=0 WHERE question_id IN (SELECT id FROM questions WHERE recipient_id=?) AND status='running'",(sid,))
        store.event(db,session['project_id'],member,'session',('Resumed ' if enabled else 'Paused ') + session['name'])
        return {'ok':True}
    if not binding['enabled']:
        raise Problem('Session sharing is paused', 409)
    if action == 'worker-status':
        status = field(data,'status',40)
        if status not in {'watching','summarizing','answering','error','budget-limited','offline'}:
            raise Problem('Unknown worker status')
        db.execute('UPDATE bindings SET status=?,error=?,updated=?,worker_seen=? WHERE session_id=?',
                   (status,field(data,'error',1000,False),now,0 if status=='offline' else now,sid))
        db.execute('UPDATE sessions SET last_seen=? WHERE id=?',(0 if status=='offline' else now,sid))
        from .reliability import report_client
        report_client(db, sid, 'worker', data, now)
        return {'ok':True}
    if action == 'ingest':
        events=data.get('events',[])
        if not isinstance(events,list) or len(events)>40:
            raise Problem('Send at most 40 events per batch')
        inserted=0
        for event in events:
            if not isinstance(event,dict):
                raise Problem('Events must be objects')
            kind=field(event,'kind',40)
            if kind not in {'user','assistant','tool','file','turn','clarification'}:
                raise Problem('Unsupported event kind')
            cursor=db.execute('INSERT OR IGNORE INTO observations(project_id,session_id,event_key,kind,body,source_ref,revision,created) VALUES(?,?,?,?,?,?,?,?)',
                (session['project_id'],sid,field(event,'key',160),kind,field(event,'body',2400),
                 field(event,'source_ref',240,False),field(event,'revision',64,False),now))
            inserted+=cursor.rowcount
        return {'inserted':inserted}
    if action == 'auto-context':
        fid=binding['feature_id']
        feature=store.require(db,'features',fid)
        if feature['session_id']!=sid:
            raise Problem('Feature ownership was transferred; automatic updates stopped.',409)
        source_cursor=field(data,'source_cursor',200)
        if binding['cursor']==source_cursor:
            return {'id':fid,'duplicate':True}
        cp={k:field(data,k,12000,k=='summary') for k in ('summary','decisions','rejected','constraints','assumptions','tests','questions','evidence')}
        title=field(data,'title',160)
        cp.update(title=title,branch=field(data,'branch',200,False),commit_sha=field(data,'commit_sha',64,False),
                  dirty=bool(data.get('dirty')),author=member['name'],author_id=member['id'],session_id=sid,
                  origin='agent-derived',source_id=binding['source_id'],source_cursor=source_cursor)
        cp['revision_basis']='Local checkout at observation; source history may describe an earlier revision.'
        version=db.execute('SELECT MAX(version) FROM checkpoints WHERE feature_id=?',(fid,)).fetchone()[0]+1
        db.execute('INSERT INTO checkpoints VALUES(?,?,?,?,?)',(identity(),fid,version,json.dumps(cp),now))
        db.execute('UPDATE features SET title=? WHERE id=?',(title,fid))
        db.execute('UPDATE sessions SET branch=?,commit_sha=?,dirty=? WHERE id=?',(cp['branch'],cp['commit_sha'],int(cp['dirty']),sid))
        db.execute('UPDATE bindings SET cursor=?,updated=? WHERE session_id=?',(source_cursor,now,sid))
        store.event(db,session['project_id'],member,'context',f'Context updated: {title} · v{version}')
        return {'id':fid,'version':version}
    if action == 'claim':
        if not binding['auto_answer']:
            return {'job':None}
        db.execute("""UPDATE jobs SET status='failed',error='Worker lease expired after three attempts',lease='',updated=?
            WHERE status='running' AND attempts>=3 AND lease_until<?
            AND question_id IN (SELECT id FROM questions WHERE recipient_id=?)""",(now,now,sid))
        row=db.execute("""SELECT q.*,j.attempts FROM questions q JOIN jobs j ON j.question_id=q.id
             WHERE q.recipient_id=? AND q.answer='' AND j.attempts<3
             AND (j.status='queued' OR (j.status='running' AND j.lease_until<?))
             ORDER BY q.created LIMIT 1""",(sid,now)).fetchone()
        if not row:
            return {'job':None}
        lease=secrets.token_urlsafe(24)
        db.execute("UPDATE jobs SET status='running',lease=?,lease_until=?,attempts=attempts+1,updated=?,error='' WHERE question_id=?",
                   (lease,now+180,now,row['id']))
        job=dict(row)
        job.update(lease=lease,feature=store.require(db,'features',row['feature_id']))
        return {'job':job}
    q=store.require(db,'questions',field(data,'question_id',64))
    if q['recipient_id']!=sid:
        raise Problem('Question belongs to another session',403)
    job=db.execute('SELECT * FROM jobs WHERE question_id=?',(q['id'],)).fetchone()
    if not job:
        raise Problem('No automatic job exists for this question',404)
    if action=='job-retry':
        if q['answer'] or job['status']=='running':
            raise Problem('Only failed or queued unanswered jobs can be retried',409)
        db.execute("UPDATE jobs SET status='queued',attempts=0,error='',lease='',updated=? WHERE question_id=?",(now,q['id']))
        return {'ok':True}
    if q['answer'] or job['status']!='running' or not secrets.compare_digest(job['lease'],field(data,'lease',100)) or job['lease_until']<now:
        raise Problem('Clarification lease expired or was replaced',409)
    if action=='job-fail':
        db.execute("UPDATE jobs SET status='failed',error=?,lease='',updated=? WHERE question_id=?",
                   (field(data,'error',1000),now,q['id']))
        store.event(db,session['project_id'],member,'error','Clarification needs attention')
        return {'ok':True}
    answer=field(data,'answer',12000)
    evidence=field(data,'evidence',12000,False)
    source_ref=field(data,'source_ref',240,False)
    response_session=field(data,'response_session',160,False)
    db.execute('UPDATE questions SET answer=?,evidence=?,answered_by=?,answered=? WHERE id=?',(answer,evidence,member['id'],now,q['id']))
    db.execute("UPDATE jobs SET status='answered',lease='',error='',source_ref=?,response_session=?,updated=? WHERE question_id=?",(source_ref,response_session,now,q['id']))
    store.event(db,session['project_id'],member,'answer',f"{binding['provider']} answered a clarification")
    return {'ok':True}
