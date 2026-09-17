"""Goal-owner integration receipts. These actions are never model tools."""
import hashlib
import json
import re

from .store import Problem, field


def migrate(db):
    db.executescript('''
    CREATE TABLE IF NOT EXISTS team_automation (
      goal_id TEXT PRIMARY KEY, session_id TEXT NOT NULL, instance TEXT NOT NULL,
      policy TEXT NOT NULL, created REAL NOT NULL);
    CREATE TABLE IF NOT EXISTS team_integrations (
      task_id TEXT PRIMARY KEY, attempt INTEGER NOT NULL, revision INTEGER NOT NULL,
      session_id TEXT NOT NULL, instance TEXT NOT NULL, status TEXT NOT NULL,
      receipt TEXT NOT NULL DEFAULT '{}', updated REAL NOT NULL);
    ''')


def state(db, goal_id=None):
    return dict(
        automation=[dict(r, policy=json.loads(r['policy'])) for r in db.execute(
            'SELECT goal_id,session_id,policy,created FROM team_automation WHERE (? IS NULL OR goal_id=?)', (goal_id, goal_id))],
        integrations=[dict(r, receipt=json.loads(r['receipt'])) for r in db.execute(
            '''SELECT i.task_id,i.attempt,i.revision,i.status,i.receipt,i.updated FROM team_integrations i
               JOIN team_tasks t ON t.id=i.task_id WHERE (? IS NULL OR t.goal_id=?)''', (goal_id, goal_id))])


def mutate(store, db, action, data, member, now):
    from .team import binding, row
    session, live = binding(store, db, member, data, now)
    enrollment = db.execute('SELECT * FROM team_workers WHERE session_id=?', (session['id'],)).fetchone()
    if not enrollment:
        raise Problem('Join this goal before configuring automation', 403)
    goal = row(db, 'team_goals', enrollment['goal_id'])
    if member['id'] != goal['member_id']:
        raise Problem('Only the goal owner can run integration', 403)
    if action == 'team-auto-enable':
        policy = data.get('policy')
        from .adapters import redact
        if redact(json.dumps(policy)) != json.dumps(policy):
            raise Problem('Do not include secrets in shared automation commands')
        if not isinstance(policy, dict) or not isinstance(policy.get('test_argv'), list) or not policy['test_argv']:
            raise Problem('Approve a nonempty test command first')
        if len(policy['test_argv']) > 40 or any(not isinstance(a, str) or not a or len(a) > 1000 or '\x00' in a for a in policy['test_argv']):
            raise Problem('Invalid test command')
        if not re.fullmatch(r'relay/[a-z0-9-]+', policy.get('branch', '')):
            raise Problem('Use a dedicated Relay integration branch')
        old = db.execute('SELECT * FROM team_automation WHERE goal_id=?', (goal['id'],)).fetchone()
        if old and (old['session_id'] != session['id'] or old['instance'] != live['instance']):
            raise Problem('Another controller owns integration; do not start a duplicate', 409)
        setup = policy.get('setup_argv')
        if setup is not None and (not isinstance(setup, list) or not 1 <= len(setup) <= 40 or any(not isinstance(a, str) or not a or len(a) > 1000 or '\x00' in a for a in setup)):
            raise Problem('Invalid dependency setup command')
        policy = dict(test_argv=policy['test_argv'], setup_argv=setup, branch=policy['branch'], timeout=120)
        db.execute('INSERT OR IGNORE INTO team_automation VALUES(?,?,?,?,?)',
                   (goal['id'], session['id'], live['instance'], json.dumps(policy), now))
        db.execute('UPDATE team_goals SET parallelism=4 WHERE id=?', (goal['id'],))
        return {'ok': True, 'policy': policy}
    policy = db.execute('SELECT * FROM team_automation WHERE goal_id=?', (goal['id'],)).fetchone()
    if not policy or policy['session_id'] != session['id'] or policy['instance'] != live['instance']:
        raise Problem('This controller does not own integration', 403)
    task = row(db, 'team_tasks', field(data, 'task_id'))
    if task['goal_id'] != goal['id'] or task['attempt'] != data.get('attempt'):
        raise Problem('Integration task or attempt changed', 409)
    previous = db.execute('SELECT * FROM team_integrations WHERE task_id=?', (task['id'],)).fetchone()
    if action == 'team-auto-result' and previous and previous['status'] == 'passed' and task['status'] == 'complete':
        return {'status': 'complete', 'idempotent': True}
    review = db.execute("SELECT 1 FROM team_plan_reviews WHERE goal_id=? AND revision=? AND decision='accept'", (goal['id'], goal['revision'])).fetchone()
    if goal['status'] != 'active' or goal['revision'] != data.get('revision') or goal['planned_revision'] != goal['revision'] or not review:
        raise Problem('Goal changed or paused; integration must wait for current plan approval', 409)
    if task['status'] != 'integration':
        raise Problem('Independent artifact review must pass first', 409)
    if action == 'team-auto-claim':
        if previous and previous['attempt'] < task['attempt'] and previous['status'] == 'failed':
            db.execute('DELETE FROM team_integrations WHERE task_id=?', (task['id'],))
            previous = None
        if previous:
            raise Problem('Integration already attempted; inspect the receipt before retrying', 409)
        db.execute('INSERT INTO team_integrations VALUES(?,?,?,?,?,?,?,?)',
                   (task['id'], task['attempt'], goal['revision'], session['id'], live['instance'], 'running', '{}', now))
        return {'ok': True}
    if not previous or previous['session_id'] != session['id'] or previous['instance'] != live['instance']:
        raise Problem('No owned integration claim', 403)
    if action == 'team-auto-retry':
        if previous['status'] not in ('failed', 'blocked'):
            raise Problem('Only a stopped failed integration can be retried', 409)
        db.execute('DELETE FROM team_integrations WHERE task_id=?', (task['id'],))
        return {'ok': True}
    if action != 'team-auto-result' or previous['status'] != 'running' or previous['revision'] != goal['revision']:
        raise Problem('Integration claim changed', 409)
    receipt = data.get('receipt')
    if not isinstance(receipt, dict) or len(json.dumps(receipt).encode()) > 12000:
        raise Problem('Invalid integration receipt')
    from .adapters import redact
    receipt = json.loads(redact(json.dumps(receipt)))
    passed = receipt.get('status') == 'passed'
    if passed:
        expected = {a['path']: a['sha256'] for a in json.loads(task['artifacts'])}
        if receipt.get('files') != expected or receipt.get('test_argv') != json.loads(policy['policy'])['test_argv'] or receipt.get('exit_code') != 0:
            raise Problem('Test command, exit code or integrated hashes do not match', 409)
        setup = json.loads(policy['policy']).get('setup_argv')
        if setup and (receipt.get('setup', {}).get('test_argv') != setup or receipt.get('setup', {}).get('exit_code') != 0):
            raise Problem('Approved dependency setup did not pass', 409)
        if not re.fullmatch('[0-9a-f]{40,64}', receipt.get('commit', '')) or receipt.get('branch') != json.loads(policy['policy'])['branch']:
            raise Problem('Missing integration commit provenance')
    status = 'passed' if passed else 'failed'
    db.execute('UPDATE team_integrations SET status=?,receipt=?,updated=? WHERE task_id=?', (status, json.dumps(receipt), now, task['id']))
    if passed:
        db.execute("UPDATE team_tasks SET status='complete',evidence=evidence||?,updated=? WHERE id=?",
                   ('\nAutomatic integration: ' + receipt['commit'], now, task['id']))
        if not db.execute("SELECT 1 FROM team_tasks WHERE goal_id=? AND status!='complete'", (goal['id'],)).fetchone():
            db.execute("UPDATE team_goals SET status='complete' WHERE id=?", (goal['id'],))
    elif isinstance(receipt.get('exit_code'), int) and receipt['exit_code'] != 0:
        # Failed tests return bounded corrections to the same scoped worker.
        # Conflicts, cancellation and uncertain transport do NOT silently retry.
        status = 'assigned' if task['attempt'] < 3 else 'blocked'
        db.execute('UPDATE team_tasks SET status=?,attempt=attempt+?,review_note=?,updated=? WHERE id=?',
                   (status, 1 if status == 'assigned' else 0,
                    'Approved integration tests failed. Fix only your assigned scope.\n' + receipt.get('output', '')[:4000], now, task['id']))
    store.event(db, goal['project_id'], member, 'team', 'Integration ' + status + ': ' + task['title'])
    return {'status': 'complete' if passed else 'integration', 'tests_passed': passed}
