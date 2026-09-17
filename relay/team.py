"""Durable, opt-in team scheduler. All changes hold Store's immediate transaction.

Models propose bounded task graphs; deterministic ownership and verification gates
decide what can execute. Offline work is never silently reassigned or released.
"""
import hashlib
import json
import re

from .adapters import redact
from .coordination import scopes
from .store import Problem, field, identity

HELD = ('assigned', 'working', 'review', 'integration', 'blocked')


def migrate(db):
    from .team_integration import migrate as integration_migrate
    integration_migrate(db)
    db.executescript('''
    CREATE TABLE IF NOT EXISTS team_goals (
      id TEXT PRIMARY KEY, project_id TEXT REFERENCES projects(id), repository_key TEXT NOT NULL,
      member_id TEXT REFERENCES members(id), title TEXT NOT NULL, objective TEXT NOT NULL,
      status TEXT NOT NULL, revision INTEGER NOT NULL, planned_revision INTEGER NOT NULL DEFAULT 0,
      planner TEXT, parallelism INTEGER NOT NULL, created REAL NOT NULL);
    CREATE TABLE IF NOT EXISTS team_requests (
      id TEXT PRIMARY KEY, goal_id TEXT REFERENCES team_goals(id), member_id TEXT REFERENCES members(id),
      body TEXT NOT NULL, created REAL NOT NULL);
    CREATE TABLE IF NOT EXISTS team_workers (
      session_id TEXT PRIMARY KEY REFERENCES sessions(id), goal_id TEXT REFERENCES team_goals(id),
      joined REAL NOT NULL);
    CREATE TABLE IF NOT EXISTS team_tasks (
      id TEXT PRIMARY KEY, goal_id TEXT REFERENCES team_goals(id), task_key TEXT NOT NULL,
      title TEXT NOT NULL, instructions TEXT NOT NULL, acceptance TEXT NOT NULL,
      paths TEXT NOT NULL, contracts TEXT NOT NULL, dependencies TEXT NOT NULL,
      status TEXT NOT NULL, assignee TEXT, reviewer TEXT, base_commit TEXT NOT NULL DEFAULT '',
      result TEXT NOT NULL DEFAULT '', evidence TEXT NOT NULL DEFAULT '', review_note TEXT NOT NULL DEFAULT '',
      artifacts TEXT NOT NULL DEFAULT '[]', attempt INTEGER NOT NULL DEFAULT 1, created REAL NOT NULL, updated REAL NOT NULL,
      UNIQUE(goal_id,task_key));
    CREATE INDEX IF NOT EXISTS team_ready ON team_tasks(goal_id,status,created);
    CREATE TABLE IF NOT EXISTS team_plan_reviews (
      goal_id TEXT REFERENCES team_goals(id), revision INTEGER, author TEXT, reviewer TEXT,
      decision TEXT NOT NULL DEFAULT 'pending', note TEXT NOT NULL DEFAULT '', PRIMARY KEY(goal_id,revision));
    CREATE TABLE IF NOT EXISTS team_questions (
      id TEXT PRIMARY KEY, goal_id TEXT REFERENCES team_goals(id), session_id TEXT REFERENCES sessions(id),
      body TEXT NOT NULL, response_request TEXT, created REAL NOT NULL);
    ''')
    # Support local development databases created before attempt fencing.
    if 'attempt' not in {r['name'] for r in db.execute('PRAGMA table_info(team_tasks)')}:
        db.execute('ALTER TABLE team_tasks ADD COLUMN attempt INTEGER NOT NULL DEFAULT 1')


def clean(data, key, limit=4000, required=True):
    return redact(field(data, key, limit, required))


def row(db, table, value):
    if table not in {'team_goals', 'team_tasks'}:
        raise RuntimeError('Invalid team table')
    result = db.execute('SELECT * FROM ' + table + ' WHERE id=?', (value,)).fetchone()
    if result is None:
        raise Problem('Team item not found', 404)
    return dict(result)


def task_data(task, artifacts=False):
    task = dict(task)
    for key in ('paths', 'contracts', 'dependencies', 'artifacts'):
        task[key] = json.loads(task[key])
    if not artifacts:
        task['artifacts'] = [{k: v for k, v in item.items() if k != 'content'} for item in task['artifacts']]
    return task


def state(db, goal_id=None):
    from .team_integration import state as integration_state
    goals = [dict(g) for g in db.execute('SELECT * FROM team_goals WHERE (? IS NULL OR id=?) ORDER BY created DESC LIMIT 100', (goal_id, goal_id))]
    tasks = [task_data(t) for t in db.execute('SELECT * FROM team_tasks WHERE (? IS NULL OR goal_id=?) ORDER BY created LIMIT 3200', (goal_id, goal_id))]
    workers = [dict(w) for w in db.execute('''SELECT w.*,s.name,m.name AS owner,l.state,l.seen FROM team_workers w
      JOIN sessions s ON s.id=w.session_id JOIN members m ON m.id=s.member_id
      JOIN live_runtimes l ON l.session_id=w.session_id WHERE (? IS NULL OR w.goal_id=?)''', (goal_id, goal_id))]
    reviews = [dict(r) for r in db.execute('SELECT * FROM team_plan_reviews WHERE (? IS NULL OR goal_id=?)', (goal_id, goal_id))]
    questions = [dict(r) for r in db.execute('SELECT * FROM team_questions WHERE (? IS NULL OR goal_id=?) ORDER BY created DESC LIMIT 100', (goal_id, goal_id))]
    return dict(goals=goals, tasks=tasks, workers=workers, plan_reviews=reviews, questions=questions,
                **integration_state(db, goal_id),
                notice='Approved automation tests and merges reviewed work on a separate Relay branch. Conflicts and failed checks stop integration.')


def workers(db, goal_id, now):
    return [dict(w) for w in db.execute('''SELECT w.*,s.member_id,s.commit_sha FROM team_workers w
      JOIN sessions s ON s.id=w.session_id JOIN members m ON m.id=s.member_id
      JOIN live_runtimes l ON l.session_id=w.session_id
      LEFT JOIN bindings b ON b.session_id=s.id
      WHERE w.goal_id=? AND l.state='active' AND l.seen>? AND m.revoked=0 AND (b.enabled IS NULL OR b.enabled=1)
      ORDER BY w.joined,w.session_id''', (goal_id, now - 30))]


def overlaps(a, b):
    return any(x == '.' or y == '.' or x == y or x.startswith(y + '/') or y.startswith(x + '/')
               for x in a for y in b)


def conflicts(db, task):
    goal = row(db, 'team_goals', task['goal_id'])
    for other in db.execute('''SELECT t.* FROM team_tasks t JOIN team_goals g ON g.id=t.goal_id
      WHERE g.project_id=? AND g.repository_key=? AND t.id!=? AND t.status IN ('assigned','working','review','integration','blocked')''',
                           (goal['project_id'], goal['repository_key'], task['id'])):
        if overlaps(json.loads(task['paths']), json.loads(other['paths'])) or set(json.loads(task['contracts'])) & set(json.loads(other['contracts'])):
            return True
    # Team mode cannot bypass reservations held by an ordinary live session.
    for other in db.execute("SELECT * FROM work_plans WHERE project_id=? AND status IN ('working','paused','review','finished')", (goal['project_id'],)):
        if overlaps(json.loads(task['paths']), json.loads(other['paths'])) or set(json.loads(task['contracts'])) & set(json.loads(other['contracts'])):
            return True
    return False


def schedule(db, goal_id, now):
    goal = row(db, 'team_goals', goal_id)
    if goal['status'] != 'active':
        return
    available = workers(db, goal_id, now)
    tasks = [dict(t) for t in db.execute('SELECT * FROM team_tasks WHERE goal_id=? ORDER BY created,id', (goal_id,))]
    busy = {t['assignee'] for t in tasks if t['status'] in ('assigned', 'working', 'blocked')}
    busy.update(t['reviewer'] for t in tasks if t['status'] == 'review' and t['reviewer'])
    idle = [w for w in available if w['session_id'] not in busy]
    if goal['planned_revision'] < goal['revision']:
        # Fail over only the planning role; no code or reservation belongs to it.
        planner = goal['planner'] if any(w['session_id'] == goal['planner'] for w in idle) else None
        # A new developer request freezes edits until its graph is reviewed.
        # If every worker holds work, allow a planning role at a safe turn
        # boundary instead of deadlocking on those retained reservations.
        candidates = idle or available
        planner = planner or (candidates[0]['session_id'] if candidates else None)
        db.execute('UPDATE team_goals SET planner=? WHERE id=?', (planner, goal_id))
        idle = [w for w in idle if w['session_id'] != planner]
        return
    review = db.execute('SELECT * FROM team_plan_reviews WHERE goal_id=? AND revision=?', (goal_id, goal['revision'])).fetchone()
    if not review or review['decision'] != 'accept':
        if review:
            author = db.execute('SELECT member_id FROM sessions WHERE id=?', (review['author'],)).fetchone()
            reviewer = next((w for w in (idle or available) if w['member_id'] != author['member_id']), None)
            if not reviewer:
                reviewer = next((w for w in available if w['member_id'] != author['member_id']), None)
            if reviewer:
                db.execute('UPDATE team_plan_reviews SET reviewer=? WHERE goal_id=? AND revision=?', (reviewer['session_id'], goal_id, goal['revision']))
        return
    db.execute('UPDATE team_goals SET planner=NULL WHERE id=?', (goal_id,))
    for task in tasks:
        if task['status'] != 'review':
            continue
        # Review ownership can move if its reader leaves; it never grants writes.
        if task['reviewer'] and any(w['session_id'] == task['reviewer'] for w in available):
            continue
        owner = db.execute('SELECT member_id FROM sessions WHERE id=?', (task['assignee'],)).fetchone()
        reviewer = next((w for w in idle if w['member_id'] != owner['member_id']), None)
        if reviewer:
            db.execute('UPDATE team_tasks SET reviewer=?,updated=? WHERE id=?', (reviewer['session_id'], now, task['id']))
            idle.remove(reviewer)
    count = sum(t['status'] in ('assigned', 'working', 'blocked') for t in tasks)
    for task in tasks:
        if task['status'] != 'queued' or not idle or count >= goal['parallelism']:
            continue
        dependencies = json.loads(task['dependencies'])
        if any(next(t for t in tasks if t['task_key'] == dep)['status'] != 'complete' for dep in dependencies):
            continue
        if conflicts(db, task):
            continue
        worker = idle.pop(0)
        db.execute("UPDATE team_tasks SET status='assigned',assignee=?,base_commit=?,updated=? WHERE id=?",
                   (worker['session_id'], worker['commit_sha'], now, task['id']))
        count += 1


def assignment(db, goal_id, sid):
    goal = row(db, 'team_goals', goal_id)
    if goal['status'] != 'active':
        return None
    if goal['planner'] == sid and goal['planned_revision'] < goal['revision']:
        return dict(key=f"plan:{goal_id}:{goal['revision']}", kind='plan', goal=goal,
                    requests=[dict(r) for r in db.execute('SELECT id,member_id,body FROM team_requests WHERE goal_id=? ORDER BY created', (goal_id,))],
                    tasks=state(db, goal_id)['tasks'])
    review = db.execute("SELECT * FROM team_plan_reviews WHERE goal_id=? AND revision=? AND decision='pending' AND reviewer=?", (goal_id, goal['revision'], sid)).fetchone()
    if review:
        return dict(key=f"plan-review:{goal_id}:{goal['revision']}", kind='plan_review', goal=goal,
                    tasks=state(db, goal_id)['tasks'],
                    requests=[dict(r) for r in db.execute('SELECT member_id,body FROM team_requests WHERE goal_id=? ORDER BY created', (goal_id,))])
    if goal['planned_revision'] != goal['revision'] or not db.execute("SELECT 1 FROM team_plan_reviews WHERE goal_id=? AND revision=? AND decision='accept'", (goal_id, goal['revision'])).fetchone():
        return None
    task = db.execute("SELECT * FROM team_tasks WHERE goal_id=? AND assignee=? AND status IN ('assigned','working','blocked') ORDER BY created LIMIT 1", (goal_id, sid)).fetchone()
    if task:
        if task['status'] == 'blocked':
            return None
        return dict(key='task:' + task['id'] + ':' + str(task['attempt']) + ':' + str(goal['revision']), kind='implement', goal=goal, task=task_data(task))
    task = db.execute("SELECT * FROM team_tasks WHERE goal_id=? AND reviewer=? AND status='review' LIMIT 1", (goal_id, sid)).fetchone()
    if task:
        return dict(key='review:' + task['id'] + ':' + str(task['attempt']), kind='review', goal=goal, task=task_data(task, True))
    return None


def binding(store, db, member, data, now):
    session = store.own_session(db, member, field(data, 'session_id'))
    live = db.execute('SELECT * FROM live_runtimes WHERE session_id=?', (session['id'],)).fetchone()
    if not live or live['instance'] != field(data, 'instance') or live['state'] != 'active' or now - live['seen'] > 30:
        raise Problem('An active owned live controller is required', 409)
    share = db.execute('SELECT enabled FROM bindings WHERE session_id=?', (session['id'],)).fetchone()
    if share and not share['enabled']:
        raise Problem('Sharing is paused', 409)
    return session, live


def poll_state(db, goal_id, sid, now):
    schedule(db, goal_id, now)
    goal = row(db, 'team_goals', goal_id)
    tasks = [dict(r) for r in db.execute('SELECT id,title,status FROM team_tasks WHERE goal_id=? ORDER BY created,id', (goal_id,))]
    return {'assignment': assignment(db, goal_id, sid),
            'summary': dict(id=goal_id, status=goal['status'], revision=goal['revision'], tasks=tasks)}


def gate(db, sid, path, commit, now):
    enrollment = db.execute('SELECT * FROM team_workers WHERE session_id=?', (sid,)).fetchone()
    if not enrollment:
        return None
    goal = row(db, 'team_goals', enrollment['goal_id'])
    task = db.execute("SELECT * FROM team_tasks WHERE assignee=? AND status='working'", (sid,)).fetchone()
    blockers = []
    if goal['status'] != 'active': blockers.append({'kind': 'team_goal_paused'})
    review = db.execute("SELECT 1 FROM team_plan_reviews WHERE goal_id=? AND revision=? AND decision='accept'", (goal['id'], goal['revision'])).fetchone()
    if goal['planned_revision'] != goal['revision'] or not review: blockers.append({'kind': 'team_plan_needs_review'})
    if not task: blockers.append({'kind': 'no_started_team_task'})
    else:
        if not any(p == '.' or path == p or path.startswith(p + '/') for p in json.loads(task['paths'])):
            blockers.append({'kind': 'outside_assigned_scope'})
        if task['base_commit'] != commit: blockers.append({'kind': 'base_changed'})
        if conflicts(db, task): blockers.append({'kind': 'scope_conflict'})
    from .live_coordination import pending
    if pending(db, sid): blockers.append({'kind': 'unacknowledged_messages'})
    return dict(proceed=not blockers, blockers=blockers, task_id=task['id'] if task else None)


def mutate(store, db, action, data, member, now):
    if not action.startswith('team-'):
        return None
    if action.startswith('team-auto-'):
        from .team_integration import mutate as integration_mutate
        return integration_mutate(store, db, action, data, member, now)
    if action == 'team-create':
        project = store.require(db, 'projects', field(data, 'project_id'))
        key = field(data, 'repository_key', 64)
        if not re.fullmatch('[0-9a-f]{64}', key): raise Problem('Repository identity is required')
        goal_id = identity()
        objective = clean(data, 'objective')
        db.execute('INSERT INTO team_goals VALUES(?,?,?,?,?,?,?,1,0,NULL,2,?)',
                   (goal_id, project['id'], key, member['id'], objective[:120], objective, 'active', now))
        db.execute('INSERT INTO team_requests VALUES(?,?,?,?,?)', (identity(), goal_id, member['id'], objective, now))
        store.event(db, project['id'], member, 'team', 'Shared goal created: ' + objective[:120])
        return row(db, 'team_goals', goal_id)
    if action in {'team-accept', 'team-pause', 'team-recover'}:
        goal = row(db, 'team_goals', field(data, 'goal_id'))
        if member['id'] != goal['member_id']:
            raise Problem('Only the goal owner can accept, pause or recover this goal', 403)
        if action == 'team-pause':
            status = field(data, 'status')
            if status not in ('active', 'paused'): raise Problem('Use active or paused')
            if goal['status'] == 'complete': raise Problem('Completed goals cannot be resumed')
            db.execute('UPDATE team_goals SET status=? WHERE id=?', (status, goal['id']))
            return {'ok': True}
        task = row(db, 'team_tasks', field(data, 'task_id'))
        if task['goal_id'] != goal['id']: raise Problem('Task belongs to another goal', 403)
        note = clean(data, 'note')
        if action == 'team-recover':
            live = db.execute('SELECT * FROM live_runtimes WHERE session_id=?', (task['assignee'],)).fetchone()
            if live and live['state'] == 'active' and now - live['seen'] <= 30:
                raise Problem('Pause or stop its worker before recovery', 409)
            if task['status'] not in ('assigned', 'working', 'blocked'): raise Problem('This task is not recoverable')
            db.execute("UPDATE team_tasks SET status='queued',assignee=NULL,base_commit='',attempt=attempt+1,result=?,updated=? WHERE id=?", ('Developer reconciliation: ' + note, now, task['id']))
        else:
            if task['status'] != 'integration': raise Problem('Peer review must pass before integration acceptance', 409)
            expected = {a['path']: a['sha256'] for a in json.loads(task['artifacts'])}
            if data.get('verified_files') != expected: raise Problem('Integrated file hashes do not match submitted artifacts', 409)
            db.execute("UPDATE team_tasks SET status='complete',evidence=evidence||?,updated=? WHERE id=?", ('\nDeveloper integration/test acceptance: ' + note, now, task['id']))
            if goal['planned_revision'] == goal['revision'] and not db.execute("SELECT 1 FROM team_tasks WHERE goal_id=? AND status!='complete'", (goal['id'],)).fetchone():
                db.execute("UPDATE team_goals SET status='complete' WHERE id=?", (goal['id'],))
        store.event(db, goal['project_id'], member, 'team', action + ': ' + task['title'])
        return {'ok': True}
    session, live = binding(store, db, member, data, now)
    sid = session['id']
    if action == 'team-enroll':
        goal = row(db, 'team_goals', field(data, 'goal_id'))
        if goal['project_id'] != session['project_id'] or goal['repository_key'] != live['repository_key']:
            raise Problem('Shared goal belongs to a different project or repository', 409)
        if goal['status'] != 'active': raise Problem('Goal is not active', 409)
        old = db.execute('SELECT * FROM team_workers WHERE session_id=?', (sid,)).fetchone()
        if old and old['goal_id'] != goal['id']: raise Problem('Start a new session to join a different goal')
        db.execute('INSERT OR IGNORE INTO team_workers VALUES(?,?,?)', (sid, goal['id'], now))
        if not old:
            from .live_coordination import broadcast
            message = db.execute("SELECT id FROM work_messages WHERE session_id=? AND kind='participant joined' ORDER BY id DESC LIMIT 1", (sid,)).fetchone()
            if message:
                broadcast(db, session['project_id'], sid, message['id'])
        return {'ok': True}
    enrolled = db.execute('SELECT * FROM team_workers WHERE session_id=?', (sid,)).fetchone()
    if not enrolled: raise Problem('This agent is not opted into team assignments', 403)
    goal = row(db, 'team_goals', enrolled['goal_id'])
    if action == 'team-state': return state(db, goal['id'])
    if action == 'team-checkout':
        task = row(db, 'team_tasks', field(data, 'task_id'))
        if task['goal_id'] != goal['id'] or task['assignee'] != sid or task['status'] != 'assigned' or data.get('attempt') != task['attempt']:
            raise Problem('Only an assigned, not started task can refresh its checkout', 409)
        commit = field(data, 'base_commit')
        if not re.fullmatch('[0-9a-f]{40,64}', commit): raise Problem('Invalid checkout commit')
        db.execute('UPDATE sessions SET commit_sha=? WHERE id=?', (commit, sid))
        db.execute('UPDATE team_tasks SET base_commit=? WHERE id=?', (commit, task['id']))
        return {'ok': True}
    if action == 'team-poll':
        return poll_state(db, goal['id'], sid, now)
    if goal['status'] != 'active' and not (goal['status'] == 'paused' and action == 'team-request'):
        raise Problem('Goal is paused or complete', 409)
    if action == 'team-question':
        question = identity()
        db.execute('INSERT INTO team_questions VALUES(?,?,?,?,NULL,?)', (question, goal['id'], sid, clean(data, 'question'), now))
        db.execute("UPDATE team_goals SET status='paused' WHERE id=?", (goal['id'],))
        store.event(db, goal['project_id'], member, 'team', 'Developer decision needed: ' + goal['title'])
        return {'id': question, 'status': 'waiting_for_developer', 'ownership_retained': True}
    if action == 'team-plan-review':
        review = db.execute("SELECT * FROM team_plan_reviews WHERE goal_id=? AND revision=? AND reviewer=? AND decision='pending'", (goal['id'], data.get('revision'), sid)).fetchone()
        if not review or data.get('revision') != goal['revision']: raise Problem('Plan review assignment changed', 409)
        decision = data.get('decision')
        if decision not in ('accept', 'changes_requested'): raise Problem('Invalid plan review decision')
        db.execute('UPDATE team_plan_reviews SET decision=?,note=? WHERE goal_id=? AND revision=?', (decision, clean(data, 'note'), goal['id'], goal['revision']))
        if decision == 'changes_requested':
            db.execute("UPDATE team_goals SET status='paused' WHERE id=?", (goal['id'],))
        return {'decision': decision, 'edits_allowed': decision == 'accept'}
    if action == 'team-request':
        if db.execute('SELECT COUNT(*) FROM team_requests WHERE goal_id=?', (goal['id'],)).fetchone()[0] >= 40:
            raise Problem('Goal request limit reached; create another goal')
        request_id = identity()
        db.execute('INSERT INTO team_requests VALUES(?,?,?,?,?)', (request_id, goal['id'], member['id'], clean(data, 'body'), now))
        db.execute('UPDATE team_questions SET response_request=? WHERE goal_id=? AND response_request IS NULL', (request_id, goal['id']))
        db.execute("UPDATE team_goals SET revision=revision+1,status='active' WHERE id=?", (goal['id'],))
        return {'id': request_id}
    if action == 'team-plan':
        if goal['planner'] != sid or data.get('revision') != goal['revision'] or goal['planned_revision'] == goal['revision']:
            raise Problem('Planning ownership or goal revision changed; read current assignment', 409)
        tasks = data.get('tasks')
        if not isinstance(tasks, list) or not 1 <= len(tasks) <= 16: raise Problem('Propose 1 to 16 tasks')
        existing_rows = {t['task_key']: dict(t) for t in db.execute('SELECT * FROM team_tasks WHERE goal_id=?', (goal['id'],))}
        existing = {k: json.loads(t['dependencies']) for k, t in existing_rows.items()}
        graph, prepared, seen = dict(existing), [], set()
        for task in tasks:
            if not isinstance(task, dict): raise Problem('Task must be an object')
            key = field(task, 'key', 60)
            if not re.fullmatch('[a-z0-9_-]+', key) or key in seen: raise Problem('Use unique stable task keys')
            if key in existing_rows and existing_rows[key]['status'] != 'queued': raise Problem('Assigned tasks are immutable; append follow-up work instead')
            seen.add(key)
            deps = task.get('dependencies', [])
            if not isinstance(deps, list) or any(not isinstance(d, str) for d in deps): raise Problem('Dependencies must be task keys')
            graph[key] = deps
            prepared.append((existing_rows[key]['id'] if key in existing_rows else identity(), goal['id'], key, clean(task, 'title', 160), clean(task, 'instructions'), clean(task, 'acceptance'),
                             json.dumps(scopes(task, 'paths')), json.dumps(scopes(task, 'contracts')), json.dumps(deps)))
        if len(graph) > 32: raise Problem('Goal task limit reached')
        visiting, visited = set(), set()
        def visit(key):
            if key not in graph or key in visiting: raise Problem('Task dependencies are missing or cyclic')
            if key in visited: return
            visiting.add(key)
            for dep in graph[key]: visit(dep)
            visiting.remove(key); visited.add(key)
        for key in graph: visit(key)
        for item in prepared:
            if item[2] in existing_rows:
                db.execute('UPDATE team_tasks SET title=?,instructions=?,acceptance=?,paths=?,contracts=?,dependencies=?,updated=? WHERE id=?', (*item[3:], now, item[0]))
            else:
                db.execute("INSERT INTO team_tasks(id,goal_id,task_key,title,instructions,acceptance,paths,contracts,dependencies,status,created,updated) VALUES(?,?,?,?,?,?,?,?,?,'queued',?,?)", (*item, now, now))
        db.execute('UPDATE team_goals SET planned_revision=revision,planner=NULL WHERE id=?', (goal['id'],))
        db.execute('INSERT INTO team_plan_reviews(goal_id,revision,author) VALUES(?,?,?)', (goal['id'], goal['revision'], sid))
        store.event(db, goal['project_id'], member, 'team', 'Task graph proposed: ' + goal['title'])
        return state(db, goal['id'])
    task = row(db, 'team_tasks', field(data, 'task_id'))
    if task['goal_id'] != goal['id']: raise Problem('Task belongs to another goal', 403)
    if action == 'team-artifacts':
        return {'task_id': task['id'], 'status': task['status'], 'artifacts': json.loads(task['artifacts'])}
    if action == 'team-artifact':
        artifact = next((a for a in json.loads(task['artifacts']) if a['path'] == field(data, 'path')), None)
        if not artifact: raise Problem('File is not in this task artifact bundle', 404)
        return dict(artifact, task_id=task['id'], attempt=task['attempt'], provenance='Submitted bytes from the assigned peer checkout, not the reviewer filesystem; integration is not yet verified')
    if action == 'team-message':
        body = clean(data, 'note')
        cursor = db.execute("INSERT INTO work_messages(project_id,work_id,session_id,kind,body,created) VALUES(?,NULL,?,'team message',?,?)",
                            (goal['project_id'], sid, 'Task ' + task['id'] + ': ' + body, now))
        db.execute('''INSERT INTO live_deliveries(message_id,session_id) SELECT ?,session_id FROM team_workers
          WHERE goal_id=? AND session_id!=?''', (cursor.lastrowid, goal['id'], sid))
        return {'message_id': cursor.lastrowid}
    if action == 'team-review':
        if data.get('attempt') != task['attempt']: raise Problem('Task attempt changed; read your current assignment', 409)
        if task['status'] != 'review' or task['reviewer'] != sid: raise Problem('Only the assigned independent reviewer may review', 403)
        if data.get('decision') not in ('accept', 'changes_requested'): raise Problem('Invalid review decision')
        note = clean(data, 'note')
        status = 'integration' if data['decision'] == 'accept' else ('assigned' if task['attempt'] < 3 else 'blocked')
        attempt = task['attempt'] + (1 if status == 'assigned' else 0)
        db.execute('UPDATE team_tasks SET status=?,attempt=?,reviewer=NULL,review_note=?,updated=? WHERE id=?', (status, attempt, note, now, task['id']))
        return {'status': status, 'verified': False}
    if task['assignee'] != sid: raise Problem('This task belongs to another worker', 403)
    if data.get('attempt') != task['attempt']: raise Problem('Task attempt changed; read your current assignment', 409)
    if action == 'team-start':
        if task['status'] not in ('assigned', 'working'): raise Problem('Task cannot start in its current state', 409)
        if conflicts(db, task): raise Problem('Overlapping work must finish integration first', 409)
        if field(data, 'base_commit') != task['base_commit']: raise Problem('Checkout changed since assignment', 409)
        db.execute("UPDATE team_tasks SET status='working',updated=? WHERE id=?", (now, task['id']))
        return {'ok': True}
    if action == 'team-block':
        if task['status'] not in ('assigned', 'working'): raise Problem('Task is not active')
        db.execute("UPDATE team_tasks SET status='blocked',result=?,updated=? WHERE id=?", (clean(data, 'note'), now, task['id']))
        return {'ok': True, 'ownership_retained': True}
    if action == 'team-submit':
        if task['status'] != 'working': raise Problem('Start the assigned task before submitting', 409)
        artifacts = data.get('artifacts', [])
        if not isinstance(artifacts, list) or len(artifacts) > 32: raise Problem('Invalid artifact bundle')
        total, paths = 0, set()
        for artifact in artifacts:
            if not isinstance(artifact, dict): raise Problem('Artifact must be an object')
            path = scopes({'paths': [artifact.get('path')]}, 'paths')[0]
            if path in paths or not any(p == '.' or path == p or path.startswith(p + '/') for p in json.loads(task['paths'])):
                raise Problem('Artifact is duplicate or outside task scope')
            paths.add(path)
            content = artifact.get('content')
            if not isinstance(content, str): raise Problem('Artifact content must be UTF-8 text')
            total += len(content.encode('utf-8'))
            if total > 120000 or redact(content) != content: raise Problem('Artifact too large or contains a detected secret')
            if hashlib.sha256(content.encode('utf-8')).hexdigest() != artifact.get('sha256'): raise Problem('Artifact hash mismatch')
        db.execute("UPDATE team_tasks SET status='review',result=?,evidence=?,artifacts=?,updated=? WHERE id=?",
                   (clean(data, 'summary'), clean(data, 'evidence'), json.dumps(artifacts), now, task['id']))
        return {'status': 'review', 'complete': False}
    raise Problem('Unknown team action')
