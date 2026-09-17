"""Developer consent and verification actions, deliberately not model tools."""
import hashlib
import json
import re

from .managed_tools import safe_file
from .onboarding import choose


def is_shell_command(value):
    return bool(re.match(r'^(?:relay-workspace\b|(?:python(?:3|\.exe)?|py)\s+.*(?:launch\.py|\-m\s+relay)\b|(?:claude|codex)\s+--|--(?:agent|goal|url|repo)\b|brew\s+(?:install|upgrade|tap|update)\b)', value.strip(), re.I))


def show_status(runtime):
    state = runtime.client.action('team-state', dict(session_id=runtime.config['session_id'], instance=runtime.config['live_instance']))
    goal = state['goals'][0]
    runtime.output(goal['title'] + ' — ' + goal['status'])
    if not state['tasks']:
        runtime.output('Waiting for planning. Both developers must join this goal for independent review.')
    for task in state['tasks']:
        runtime.output(task['id'] + '  ' + task['status'] + '  ' + task['title'])
    for receipt in state.get('integrations', []):
        runtime.output('Integration ' + receipt['task_id'] + ': ' + receipt['status'] + ' ' + receipt['receipt'].get('error', ''))
    for question in state.get('questions', []):
        if not question.get('response_request'):
            runtime.output('Your input needed: ' + question['body'] + '\nReply here in plain language.')


def select_goal(args, client, project, key):
    state = client.request('/api/state')
    if 'team' not in state:
        raise ValueError('Update the hub before starting automatic team mode')
    goals = [g for g in state['team']['goals'] if g['project_id'] == project['id'] and g['repository_key'] == key and g['status'] == 'active']
    if getattr(args, 'goal', None):
        goal = next((g for g in goals if args.goal in (g['id'], g['title'])), None)
        if not goal: raise ValueError('Active shared goal not found in this repository')
    elif goals:
        goal = choose('Work together on', [None] + goals, lambda g: g['title'] if g else 'A new shared goal')
    else:
        goal = None
    if goal:
        print('Shared goal: ' + goal['objective'])
        prompt = 'Anything to add to this goal? (Enter to join without changing the plan): '
    else:
        prompt = 'What should the team build? '
    while True:
        task = input(prompt).strip()
        if not is_shell_command(task):
            break
        print('That looks like a shell command. Enter the desired outcome here, not an install/join command. Nothing was added.')
    if goal:
        return goal, task
    if not task: raise ValueError('No goal entered; nothing started')
    return None, task


def command(runtime, value):
    """Returns True if this was a team-only developer command."""
    if not runtime.config.get('team_goal_id'):
        return False
    if value.startswith('/retry '):
        if not runtime.automation or not runtime.automation.settings.get('test_argv'):
            raise ValueError('Only the goal owner with automatic integration can retry checks')
        if runtime.automation.thread and runtime.automation.thread.is_alive():
            raise ValueError('Checks are still running; pause first')
        task_id = value.split(maxsplit=1)[1]
        state = runtime.automation.state()
        task = next((t for t in state['tasks'] if t['id'] == task_id), None)
        if not task: raise ValueError('Task not found')
        runtime.automation.action('retry', task_id=task_id, attempt=task['attempt'], revision=state['goals'][0]['revision'])
        runtime.output('Approved one new integration attempt. Existing candidate checkouts are preserved.')
        return True
    if value.startswith('/export '):
        from .worker import atomic_json
        import secrets
        task_id = value.split(maxsplit=1)[1]
        bundle = runtime.client.action('team-artifacts', dict(task_id=task_id, session_id=runtime.config['session_id'], instance=runtime.config['live_instance']))
        target = runtime.path.parent / ('reviewed-artifacts-' + secrets.token_hex(6) + '.json')
        atomic_json(target, bundle)
        runtime.output('Artifact bundle saved privately: ' + str(target) + '. Contains file contents, expected base hashes and result hashes; no checkout files changed.')
        return True
    if value.startswith('/accept ') or value.startswith('/recover '):
        operation, task_id = value.split(maxsplit=1)
        state = runtime.client.action('team-state', dict(session_id=runtime.config['session_id'], instance=runtime.config['live_instance']))
        task = next((t for t in state['tasks'] if t['id'] == task_id), None)
        if not task: raise ValueError('Task not found in this goal')
        payload = dict(goal_id=runtime.config['team_goal_id'], task_id=task_id)
        if operation == '/accept':
            from pathlib import Path
            root = Path(runtime.config['repo']).resolve()
            hashes = {}
            for item in task['artifacts']:
                digest = hashlib.sha256(safe_file(root, item['path']).read_bytes()).hexdigest()
                if digest != item['sha256']: raise ValueError('Integrate the reviewed artifact first: ' + item['path'])
                hashes[item['path']] = digest
            payload['verified_files'] = hashes
            question = 'What integration checks/tests passed (or why are tests not applicable)? '
        else:
            question = 'Confirm unfinished changes are reconciled. What happened to them? '
        # Main CLI input is read by a background reader; never call input here.
        runtime.output(question + 'Then enter /confirm ' + task_id + ' followed by your verification note. No action yet.')
        runtime.pending_confirmation = (operation, payload)
        return True
    if value.startswith('/confirm '):
        parts = value.split(maxsplit=2)
        pending = getattr(runtime, 'pending_confirmation', None)
        if not pending or len(parts) != 3 or parts[1] != pending[1]['task_id']:
            raise ValueError('Use /accept or /recover first, then /confirm TASK_ID your note')
        operation, payload = pending
        # Recheck accepted bytes at the actual confirmation boundary.
        if operation == '/accept':
            from pathlib import Path
            root = Path(runtime.config['repo']).resolve()
            for path, digest in payload['verified_files'].items():
                if hashlib.sha256(safe_file(root, path).read_bytes()).hexdigest() != digest:
                    raise ValueError('Integration files changed; repeat /accept')
        runtime.client.action('team-' + ('accept' if operation == '/accept' else 'recover'), dict(payload, note=parts[2]))
        runtime.pending_confirmation = None
        runtime.output('Recorded developer verification/reconciliation. No files were changed by this command.')
        return True
    return False
