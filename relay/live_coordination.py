"""Durable delivery to opted-in working sessions, separate from explanation jobs.

All mutations run inside Store's immediate transaction. Delivery is not an
acknowledgement, acknowledgement is not peer approval, and neither permits edits.
"""
import re

from .store import Problem, field

ONLINE_SECONDS = 30


def migrate(db):
    db.executescript('''
    CREATE TABLE IF NOT EXISTS live_runtimes (
      session_id TEXT PRIMARY KEY REFERENCES sessions(id), repository_key TEXT NOT NULL,
      instance TEXT NOT NULL, state TEXT NOT NULL, seen REAL NOT NULL);
    CREATE TABLE IF NOT EXISTS live_deliveries (
      message_id INTEGER REFERENCES work_messages(id), session_id TEXT REFERENCES sessions(id),
      delivered REAL NOT NULL DEFAULT 0, acknowledged REAL NOT NULL DEFAULT 0,
      note TEXT NOT NULL DEFAULT '', PRIMARY KEY(message_id,session_id));
    CREATE INDEX IF NOT EXISTS pending_live_deliveries
      ON live_deliveries(session_id,acknowledged,message_id);
    CREATE TABLE IF NOT EXISTS live_activity (
      id INTEGER PRIMARY KEY AUTOINCREMENT,session_id TEXT REFERENCES sessions(id),
      kind TEXT NOT NULL,body TEXT NOT NULL,created REAL NOT NULL);
    ''')


def participants(db, project_id):
    return [dict(r) for r in db.execute('''SELECT l.*,s.project_id,m.revoked FROM live_runtimes l
      JOIN sessions s ON s.id=l.session_id JOIN members m ON m.id=s.member_id
      WHERE s.project_id=?''', (project_id,))]


def broadcast(db, project_id, sender, message_id):
    # Only explicit live participants receive work, never explanation forks.
    cohort = db.execute('SELECT goal_id FROM team_workers WHERE session_id=?', (sender,)).fetchone()
    for peer in participants(db, project_id):
        target = db.execute('SELECT goal_id FROM team_workers WHERE session_id=?', (peer['session_id'],)).fetchone()
        same_goal = (cohort['goal_id'] if cohort else None) == (target['goal_id'] if target else None)
        if peer['session_id'] != sender and not peer['revoked'] and peer['state'] != 'left' and same_goal:
            db.execute('INSERT OR IGNORE INTO live_deliveries(message_id,session_id) VALUES(?,?)',
                       (message_id, peer['session_id']))


def pending(db, sid):
    return [dict(r) for r in db.execute('''SELECT d.*,w.work_id,w.session_id AS author_session,
      w.kind,w.body,w.created,m.name AS author FROM live_deliveries d
      JOIN work_messages w ON w.id=d.message_id JOIN sessions s ON s.id=w.session_id
      JOIN members m ON m.id=s.member_id
      LEFT JOIN team_workers recipient ON recipient.session_id=d.session_id
      LEFT JOIN team_workers sender ON sender.session_id=w.session_id
      WHERE d.session_id=? AND d.acknowledged=0
        AND (recipient.goal_id=sender.goal_id OR (recipient.goal_id IS NULL AND sender.goal_id IS NULL))
      ORDER BY d.message_id LIMIT 100''', (sid,))]


def blockers(db, work, now):
    own = db.execute('SELECT * FROM live_runtimes WHERE session_id=?', (work['session_id'],)).fetchone()
    if own is None:
        return []
    result = []
    if own['state'] != 'active' or now - own['seen'] > ONLINE_SECONDS:
        result.append(dict(kind='live_session_paused_or_offline'))
    if pending(db, work['session_id']):
        result.append(dict(kind='unacknowledged_messages', note='Read and acknowledge incoming work before editing'))
    for peer in participants(db, work['project_id']):
        if peer['session_id'] == work['session_id']:
            continue
        # Explicit leave retains outstanding reservations in coordination.py.
        if peer['state'] == 'left':
            continue
        if peer['repository_key'] != own['repository_key']:
            result.append(dict(kind='different_repository', session_id=peer['session_id']))
        if peer['revoked'] or peer['state'] != 'active' or now - peer['seen'] > ONLINE_SECONDS:
            result.append(dict(kind='peer_unavailable', session_id=peer['session_id']))
        if not db.execute("SELECT 1 FROM work_plans WHERE session_id=? AND status!='released'",
                          (peer['session_id'],)).fetchone() and not db.execute('SELECT 1 FROM team_workers WHERE session_id=?', (peer['session_id'],)).fetchone():
            result.append(dict(kind='peer_needs_plan', session_id=peer['session_id']))
    return result


def state(db, now):
    sessions = [dict(r) for r in db.execute('''SELECT l.session_id,l.state,l.seen,s.project_id,
      s.name,m.name AS owner FROM live_runtimes l JOIN sessions s ON s.id=l.session_id
      JOIN members m ON m.id=s.member_id WHERE m.revoked=0''')]
    for row in sessions:
        row['online'] = row['state'] == 'active' and now - row['seen'] <= ONLINE_SECONDS
    activity = [dict(r) for r in db.execute('''SELECT a.*,s.project_id,m.name AS author
      FROM live_activity a JOIN sessions s ON s.id=a.session_id JOIN members m ON m.id=s.member_id
      ORDER BY a.id DESC LIMIT 200''')]
    deliveries = [dict(r) for r in db.execute('''SELECT d.message_id,d.session_id,d.delivered,d.acknowledged,
      s.project_id FROM live_deliveries d JOIN sessions s ON s.id=d.session_id
      ORDER BY d.message_id DESC LIMIT 200''')]
    return dict(live_sessions=sessions, live_activity=activity, deliveries=deliveries)


def mutate(store, db, action, data, member, now):
    if not action.startswith('live-'):
        return None
    session = store.own_session(db, member, field(data, 'session_id'))
    sid = session['id']
    binding = db.execute('SELECT enabled FROM bindings WHERE session_id=?', (sid,)).fetchone()
    if binding and not binding['enabled'] and action not in {'live-pause', 'live-leave'}:
        raise Problem('Sharing is paused; live work is blocked', 409)
    instance = field(data, 'instance', 80)
    own = db.execute('SELECT * FROM live_runtimes WHERE session_id=?', (sid,)).fetchone()
    if action == 'live-join':
        key = field(data, 'repository_key', 64)
        if not re.fullmatch('[0-9a-f]{64}', key):
            raise Problem('A repository identity hash is required')
        if own and own['repository_key'] != key:
            raise Problem('Cannot retarget a working session to another repository', 409)
        if own and own['instance'] != instance and now - own['seen'] <= ONLINE_SECONDS and own['state'] != 'left':
            raise Problem('This working session already has a live controller', 409)
        if any(p['repository_key'] != key and p['state'] != 'left'
               for p in participants(db, session['project_id'])):
            raise Problem('Live teammates selected a different repository; choose the same Git project', 409)
        db.execute('INSERT OR REPLACE INTO live_runtimes VALUES(?,?,?,?,?)', (sid, key, instance, 'active', now))
        # A new/reconnecting controller gets durable outstanding work, not a
        # lossy cursor over the last 200 UI messages. Join does not acknowledge.
        db.execute('''INSERT OR IGNORE INTO live_deliveries(message_id,session_id)
          SELECT m.id,? FROM work_messages m JOIN work_plans w ON w.id=m.work_id
          WHERE m.project_id=? AND m.session_id!=? AND w.status!='released' ''',
                   (sid, session['project_id'], sid))
        if not own or own['state'] != 'active' or own['instance'] != instance:
            msg = db.execute('''INSERT INTO work_messages(project_id,work_id,session_id,kind,body,created)
              VALUES(?,NULL,?,'participant joined','A live working agent joined. Check its plan before further edits.',?)''',
                             (session['project_id'], sid, now))
            broadcast(db, session['project_id'], sid, msg.lastrowid)
        return {'ok': True, 'state': 'active'}
    if not own or own['instance'] != instance:
        raise Problem('Live controller is not current; explicitly reconnect', 409)
    if action in {'live-pause', 'live-leave'}:
        state = 'paused' if action == 'live-pause' else 'left'
        db.execute('UPDATE live_runtimes SET state=?,seen=? WHERE session_id=?', (state, now, sid))
        return {'ok': True, 'state': state, 'reservations_released': False}
    if own['state'] != 'active':
        raise Problem('Live session is paused or stopped; explicitly reconnect', 409)
    if action == 'live-record':
        from .adapters import redact
        kind = field(data, 'kind', 30)
        if kind not in {'user', 'assistant', 'tool', 'status'}:
            raise Problem('Invalid live activity kind')
        body = redact(field(data, 'body', 2400))
        db.execute('INSERT INTO live_activity(session_id,kind,body,created) VALUES(?,?,?,?)', (sid, kind, body, now))
        return {'ok': True}
    if action == 'live-gate':
        from .coordination import scopes, mutate as coordinate
        path = scopes({'paths': [field(data, 'path', 500)]}, 'paths')[0]
        from .team import gate as team_gate
        guarded = team_gate(db, sid, path, field(data, 'base_commit', 64), now)
        if guarded is not None:
            return guarded
        row = db.execute("SELECT id,revision,paths FROM work_plans WHERE session_id=? AND status='working'", (sid,)).fetchone()
        if not row:
            return {'proceed': False, 'blockers': [{'kind': 'no_started_plan'}]}
        import json
        if not any(p == '.' or path == p or path.startswith(p + '/') for p in json.loads(row['paths'])):
            return {'proceed': False, 'blockers': [{'kind': 'outside_agreed_scope'}]}
        return coordinate(store, db, 'work-check', dict(session_id=sid, work_id=row['id'], revision=row['revision'],
                          base_commit=field(data, 'base_commit', 64)), member, now)
    if action == 'live-poll':
        db.execute('UPDATE live_runtimes SET seen=? WHERE session_id=?', (now, sid))
        result = {'messages': pending(db, sid), 'participants': [
            {k: v for k, v in p.items() if k != 'instance'} for p in participants(db, session['project_id'])]}
        enrollment = db.execute('SELECT goal_id FROM team_workers WHERE session_id=?', (sid,)).fetchone()
        if enrollment:
            from .team import poll_state
            result['team'] = poll_state(db, enrollment['goal_id'], sid, now)
        return result
    if action in {'live-delivered', 'live-ack'}:
        mid = data.get('message_id')
        if type(mid) is not int or mid <= 0:
            raise Problem('message_id must be a positive integer')
        row = db.execute('SELECT * FROM live_deliveries WHERE message_id=? AND session_id=?', (mid, sid)).fetchone()
        if not row:
            raise Problem('Message is not addressed to this working session', 403)
        if action == 'live-delivered':
            db.execute('UPDATE live_deliveries SET delivered=CASE WHEN delivered=0 THEN ? ELSE delivered END WHERE message_id=? AND session_id=?',
                       (now, mid, sid))
        else:
            if not row['delivered']:
                raise Problem('Message has not been delivered to this working agent', 409)
            note = field(data, 'note', 2000)
            if not row['acknowledged']:
                db.execute('UPDATE live_deliveries SET acknowledged=?,note=? WHERE message_id=? AND session_id=?',
                           (now, note, mid, sid))
        return {'ok': True}
    raise Problem('Unknown live action', 404)
