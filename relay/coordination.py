"""Advisory work protocol. Reservations are atomic; local edits are NOT gated.

Caller holds Store's BEGIN IMMEDIATE transaction for every mutation. Offline or
finished work keeps its reservation until an explicit, attributed release.
"""
import json
import re
import time
import unicodedata

from .store import Problem, field, identity

LEASE_SECONDS = 120


def migrate(db):
    db.executescript('''
    CREATE TABLE IF NOT EXISTS work_plans (
      id TEXT PRIMARY KEY, project_id TEXT REFERENCES projects(id),
      session_id TEXT REFERENCES sessions(id), title TEXT NOT NULL,
      plan TEXT NOT NULL, paths TEXT NOT NULL, contracts TEXT NOT NULL,
      base_commit TEXT NOT NULL, revision INTEGER NOT NULL,
      status TEXT NOT NULL, lease_until REAL NOT NULL DEFAULT 0,
      result TEXT NOT NULL DEFAULT '', created REAL NOT NULL, updated REAL NOT NULL);
    CREATE UNIQUE INDEX IF NOT EXISTS one_open_work_per_session
      ON work_plans(session_id) WHERE status != 'released';
    CREATE TABLE IF NOT EXISTS work_reviews (
      work_id TEXT REFERENCES work_plans(id), revision INTEGER NOT NULL,
      reviewer_work_id TEXT REFERENCES work_plans(id), reviewer_revision INTEGER NOT NULL,
      decision TEXT NOT NULL, note TEXT NOT NULL, created REAL NOT NULL,
      PRIMARY KEY(work_id, revision, reviewer_work_id, reviewer_revision));
    CREATE TABLE IF NOT EXISTS work_messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT, project_id TEXT REFERENCES projects(id),
      work_id TEXT REFERENCES work_plans(id), session_id TEXT REFERENCES sessions(id),
      kind TEXT NOT NULL, body TEXT NOT NULL, created REAL NOT NULL);
    ''')


def scopes(data, key):
    values = data.get(key, [])
    if not isinstance(values, list) or len(values) > 100:
        raise Problem(f'{key} must be a list of at most 100 names')
    result = []
    for value in values:
        if not isinstance(value, str) or not value.strip() or len(value) > 500:
            raise Problem(f'Invalid {key} name')
        value = unicodedata.normalize('NFC', value.strip()).casefold()
        if any(ord(c) < 32 for c in value):
            raise Problem(f'Invalid {key} name')
        if key == 'paths':
            value = value.replace('\\', '/').rstrip('/')
            if (not value or value.startswith('/') or any(c in value for c in ':*?[]')
                    or (value != '.' and any(p in {'', '.', '..'} for p in value.split('/')))):
                raise Problem('Use repository-relative paths without globs or traversal; . reserves the whole repository')
        result.append(value)
    if key == 'paths' and not result:
        raise Problem('Declare affected paths; use . if the scope is not yet known')
    return sorted(set(result))


def decode(row):
    result = dict(row)
    for key in ('paths', 'contracts'):
        result[key] = json.loads(result[key])
    return result


def get(db, work_id):
    row = db.execute('SELECT * FROM work_plans WHERE id=?', (work_id,)).fetchone()
    if row is None:
        raise Problem('Work plan not found', 404)
    return decode(row)


def overlaps(a, b):
    paths = sorted({x for x in a['paths'] for y in b['paths']
                    if x == '.' or y == '.' or x == y or x.startswith(y + '/') or y.startswith(x + '/')})
    contracts = sorted(set(a['contracts']) & set(b['contracts']))
    return dict(paths=paths, contracts=contracts)


def peers(db, work):
    return [decode(r) for r in db.execute(
        "SELECT * FROM work_plans WHERE project_id=? AND id!=? AND status!='released' ORDER BY created,id",
        (work['project_id'], work['id']))]


def readiness(db, work, now):
    from .live_coordination import blockers as live_blockers
    blockers = live_blockers(db, work, now)
    for task in db.execute('''SELECT t.id,t.paths,t.contracts FROM team_tasks t JOIN team_goals g ON g.id=t.goal_id
      WHERE g.project_id=? AND t.status IN ('assigned','working','review','integration','blocked')''', (work['project_id'],)):
        overlap = overlaps(work, {'paths': json.loads(task['paths']), 'contracts': json.loads(task['contracts'])})
        if any(overlap.values()):
            blockers.append(dict(kind='team_task_reserved', task_id=task['id'], **overlap))
    for peer in peers(db, work):
        overlap = overlaps(work, peer)
        if peer['status'] in {'working', 'paused', 'review'} and any(overlap.values()):
            blockers.append(dict(work_id=peer['id'], kind='reserved', **overlap))
        review = db.execute('''SELECT decision,note FROM work_reviews WHERE work_id=? AND revision=?
            AND reviewer_work_id=? AND reviewer_revision=?''',
            (work['id'], work['revision'], peer['id'], peer['revision'])).fetchone()
        if not review or review['decision'] != 'agree':
            blockers.append(dict(work_id=peer['id'], kind='needs_peer_review',
                                 note=review['note'] if review else 'Waiting for the working agent to review this plan'))
    return blockers


def state(db, now=None):
    now = time.time() if now is None else now
    plans = [decode(r) for r in db.execute('''SELECT w.*,s.name AS session_name,m.name AS owner,m.revoked
        FROM work_plans w JOIN sessions s ON s.id=w.session_id JOIN members m ON m.id=s.member_id
        WHERE w.status!='released' OR w.id IN (SELECT id FROM work_plans WHERE status='released' ORDER BY updated DESC LIMIT 50)
        ORDER BY w.created DESC''')]
    for work in plans:
        work['stale'] = work['status'] == 'working' and work['lease_until'] <= now
        work['blockers'] = readiness(db, work, now) if work['status'] in {'planning', 'working', 'paused'} else []
    messages = [dict(r) for r in db.execute('''SELECT w.*,s.name AS session_name,m.name AS author
        FROM work_messages w JOIN sessions s ON s.id=w.session_id JOIN members m ON m.id=s.member_id
        ORDER BY w.id DESC LIMIT 200''')]
    from .live_coordination import state as live_state
    return dict(mode='advisory', edit_gate=False, plans=plans, messages=messages, **live_state(db, now),
                unplanned_sessions=unplanned(db),
                notice='Only sessions with open plans participate. Local edits are not blocked. No automatic merging or conflict-resolution guarantee.')


def unplanned(db):
    return [dict(r) for r in db.execute('''SELECT s.id,s.project_id,s.name,m.name AS owner FROM sessions s
        JOIN members m ON m.id=s.member_id WHERE m.revoked=0 AND NOT EXISTS
        (SELECT 1 FROM team_workers tw WHERE tw.session_id=s.id) AND NOT EXISTS
        (SELECT 1 FROM work_plans w WHERE w.session_id=s.id AND w.status!='released')''')]


def mutate(store, db, action, data, member, now):
    if not action.startswith('work-'):
        return None
    session = store.own_session(db, member, field(data, 'session_id'))
    binding = db.execute('SELECT enabled FROM bindings WHERE session_id=?', (session['id'],)).fetchone()
    if binding is not None and not binding['enabled']:
        raise Problem('Sharing is paused for this session. Resume before sending coordination updates', 409)
    def message(work_id, kind, body):
        cursor = db.execute('INSERT INTO work_messages(project_id,work_id,session_id,kind,body,created) VALUES(?,?,?,?,?,?)',
                   (session['project_id'], work_id, session['id'], kind, body, now))
        from .live_coordination import broadcast
        broadcast(db, session['project_id'], session['id'], cursor.lastrowid)
        store.event(db, session['project_id'], member, 'coordination', kind + ': ' + body[:160])
    def reply(work):
        return dict(work=work, peers=peers(db, work), blockers=readiness(db, work, now), mode='advisory', edit_gate=False,
                    unplanned_sessions=[s for s in unplanned(db) if s['project_id']==work['project_id']],
                    notice='Unplanned sessions are not participating. A reservation is not proof that all connected agents coordinated.')
    if action == 'work-plan':
        title, plan = field(data, 'title', 160), field(data, 'plan', 6000)
        paths, contracts = scopes(data, 'paths'), scopes(data, 'contracts')
        commit = field(data, 'base_commit', 64)
        if not re.fullmatch('[0-9a-fA-F]{40}|[0-9a-fA-F]{64}', commit):
            raise Problem('A full Git commit SHA is required')
        current = db.execute("SELECT id FROM work_plans WHERE session_id=? AND status!='released'", (session['id'],)).fetchone()
        if current:
            work = get(db, current['id'])
            if work['status'] not in {'planning', 'paused'}:
                raise Problem('Finish and explicitly release existing work before changing its scope', 409)
            if work['status'] == 'paused' and (not set(work['paths']).issubset(paths) or not set(work['contracts']).issubset(contracts)):
                raise Problem('Paused replans must retain reserved paths and interfaces until explicit integration/release', 409)
            if type(data.get('revision')) is not int or data['revision'] != work['revision']:
                raise Problem('Plan changed. Read the latest revision before replanning', 409)
            wid = work['id']
            db.execute('''UPDATE work_plans SET title=?,plan=?,paths=?,contracts=?,base_commit=?,revision=revision+1,updated=? WHERE id=?''',
                       (title, plan, json.dumps(paths), json.dumps(contracts), commit.lower(), now, wid))
        else:
            if 'revision' in data:
                raise Problem('The previous plan was released. Read coordination state before creating new work', 409)
            wid = identity()
            db.execute('''INSERT INTO work_plans(id,project_id,session_id,title,plan,paths,contracts,base_commit,revision,status,created,updated)
                VALUES(?,?,?,?,?,?,?,?,1,'planning',?,?)''',
                (wid, session['project_id'], session['id'], title, plan, json.dumps(paths), json.dumps(contracts), commit.lower(), now, now))
        message(wid, 'plan', title + ': ' + plan)
        return reply(get(db, wid))
    work = get(db, field(data, 'work_id', 64))
    if work['project_id'] != session['project_id']:
        raise Problem('Work is not in this session project', 403)
    if action == 'work-message':
        message(work['id'], 'message', field(data, 'note', 6000))
        return {'ok': True}
    if action == 'work-review':
        if work['session_id'] == session['id']:
            raise Problem('A peer must review this plan')
        reviewer = db.execute("SELECT id,revision FROM work_plans WHERE session_id=? AND status!='released'", (session['id'],)).fetchone()
        if not reviewer:
            raise Problem('Publish your own work plan before reviewing a peer')
        if (type(data.get('revision')) is not int or data['revision'] != work['revision']
                or type(data.get('reviewer_revision')) is not int or data['reviewer_revision'] != reviewer['revision']):
            raise Problem('Plan changed. Read both latest plans before reviewing', 409)
        if work['status'] == 'released':
            raise Problem('Work has already been released', 409)
        decision, note = field(data, 'decision', 20), field(data, 'note', 6000)
        if decision not in {'agree', 'changes_requested'}:
            raise Problem('Choose agree or changes_requested')
        db.execute('INSERT OR REPLACE INTO work_reviews VALUES(?,?,?,?,?,?,?)',
                   (work['id'], work['revision'], reviewer['id'], reviewer['revision'], decision, note, now))
        message(work['id'], decision, note)
        return reply(work)
    if work['session_id'] != session['id']:
        raise Problem('Only this work session can change its plan', 403)
    if type(data.get('revision')) is not int or data['revision'] != work['revision']:
        raise Problem('Plan changed. Read the latest revision', 409)
    if action == 'work-pause':
        if work['status'] not in {'working', 'paused'}:
            raise Problem('Only working plans can pause with a reservation', 409)
        note = field(data, 'note', 6000)
        db.execute("UPDATE work_plans SET status='paused',lease_until=0,updated=? WHERE id=?", (now, work['id']))
        message(work['id'], 'paused for replanning', note)
        return reply(get(db, work['id']))
    if action in {'work-start', 'work-check'}:
        if work['status'] not in {'planning', 'working', 'paused'}:
            raise Problem('This work is no longer editable', 409)
        blockers = readiness(db, work, now)
        if field(data, 'base_commit', 64).lower() != work['base_commit']:
            blockers.append({'kind': 'base_changed', 'note': 'HEAD changed since this plan; reconcile the plan before further edits'})
        if action == 'work-check' and work['status'] != 'working':
            blockers.append({'kind': 'not_started'})
        if blockers:
            return dict(work=work, blockers=blockers, proceed=False, mode='advisory', edit_gate=False)
        # Reclaiming a stale reservation still checks peers. It was never freed.
        db.execute("UPDATE work_plans SET status='working',lease_until=?,updated=? WHERE id=?",
                   (now + LEASE_SECONDS, now, work['id']))
        if action == 'work-start' and work['status'] != 'working':
            message(work['id'], 'working', work['title'])
        return dict(reply(get(db, work['id'])), proceed=True)
    if action == 'work-finish':
        if work['status'] != 'working':
            raise Problem('Only working plans can be marked ready for integration', 409)
        note = field(data, 'note', 6000)
        db.execute("UPDATE work_plans SET status='review',result=?,lease_until=0,updated=? WHERE id=?", (note, now, work['id']))
        message(work['id'], 'ready for integration (agent-reported)', note)
        return reply(get(db, work['id']))
    if action == 'work-release':
        if work['status'] == 'released':
            raise Problem('Work has already been released', 409)
        note = field(data, 'note', 6000)
        db.execute("UPDATE work_plans SET status='released',result=?,lease_until=0,updated=? WHERE id=?", (note, now, work['id']))
        message(work['id'], 'reservation released (agent-reported)', note)
        return reply(get(db, work['id']))
    raise Problem('Unknown work action', 404)
