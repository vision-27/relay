"""Isolated browser UX smoke. Fake transcript/model; no user sessions or identities."""
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import tempfile
import threading
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from relay.client import Client, load_config
from relay.mcp import Connector
from relay.companion import Companion, CompanionServer
from relay.server import Hub
from relay.store import Store
from relay.worker import atomic_json
from relay.processes import background_options
from playwright.sync_api import sync_playwright, expect


def main():
    sys.stdout.reconfigure(encoding='utf-8')
    evidence = Path('.relay/companion-qa')
    evidence.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory() as directory:
        root = Path(directory)
        store = Store(root / 'hub')
        hub = Hub(('127.0.0.1', 0), store)
        url = 'http://127.0.0.1:' + str(hub.server_address[1])
        owner = Client(url, (store.directory / 'owner-token').read_text())
        store.mutate('project', {'name': 'Browser QA'}, store.authenticate(owner.token))
        repo = root / 'demo-repo'
        subprocess.run(['git', 'init', str(repo)], check=True, capture_output=True, **background_options())
        subprocess.run(['git', '-C', str(repo), '-c', 'user.name=QA', '-c', 'user.email=qa@example.invalid',
                        'commit', '--allow-empty', '-m', 'QA fixture'], check=True, capture_output=True, **background_options())
        claude = root / 'claude'
        folder = claude / 'projects' / re.sub(r'[^a-zA-Z0-9]', '-', str(repo.resolve()))
        folder.mkdir(parents=True)
        sid = 'test-conversation'
        (folder / (sid + '.jsonl')).write_text(json.dumps({'sessionId': sid, 'cwd': str(repo),
            'uuid': 'first', 'type': 'user', 'message': {'content': 'Build the shared onboarding screen'}}) + '\n')
        for index in range(6):
            (folder / ('other-' + str(index) + '.jsonl')).write_text(json.dumps({'sessionId': 'other-'+str(index),
                'cwd': str(repo), 'uuid': 'first', 'type': 'user', 'message': {'content': 'Another feature '+str(index)}})+'\n')
        with patch.dict(os.environ, {'CLAUDE_CONFIG_DIR': str(claude)}), patch('relay.companion.webbrowser.open'), patch('relay.companion.Companion.start_worker'):
            companion = Companion(root / 'companion', url, str(repo))
            local = CompanionServer(companion)
            # Join in-flight HTTP handlers before removing the temporary fixtures.
            # Daemon handlers can otherwise still hold a file open on Windows.
            hub.daemon_threads = local.daemon_threads = False
            threads = [threading.Thread(target=s.serve_forever, daemon=True) for s in (hub, local)]
            for thread in threads:
                thread.start()
            try:
                invite = owner.action('invite-link', {'name': 'Test teammate'})['url']
                with sync_playwright() as pw:
                    browser = pw.chromium.launch(headless=True)
                    context = browser.new_context(viewport={'width': 1150, 'height': 1000})
                    page = context.new_page()
                    errors = []
                    page.on('pageerror', lambda e: errors.append(str(e)))
                    page.goto(local.origin + '/#key=' + local.capability)
                    page.screenshot(path=str(evidence / 'ux-join.png'), full_page=True)
                    page.get_by_label('Invite link or workspace address').fill(invite)
                    page.get_by_role('button', name='Connect workspace', exact=True).click()
                    approval_url = page.get_by_role('link', name='Open approval page').get_attribute('href')
                    approval = context.new_page()
                    approval.on('pageerror', lambda e: errors.append(str(e)))
                    approval.goto(approval_url)
                    approval.wait_for_timeout(800)
                    approval.screenshot(path=str(evidence / 'approval.png'), full_page=True)
                    approval.get_by_role('button', name='Join workspace', exact=True).click()
                    approval.get_by_role('button', name='Approve this computer', exact=True).click()
                    expect(approval.get_by_role('heading', name='Computer connected', exact=True)).to_be_visible()
                    expect(page.get_by_text('Connected as Test teammate.', exact=False)).to_be_visible(timeout=15000)
                    page.screenshot(path=str(evidence / 'ux-folder.png'), full_page=True)
                    with patch('relay.companion.discover_sessions', return_value=[]):
                        page.get_by_role('button', name='Find conversations', exact=True).click()
                        expect(page.get_by_role('alert')).to_contain_text('No conversations found')
                    page.get_by_role('button', name='Find conversations', exact=True).click()
                    expect(page.locator('#select-form')).to_be_hidden()
                    expect(page.get_by_label('Conversation to share')).to_contain_text('Build the shared onboarding screen')
                    page.get_by_label('Find a conversation', exact=True).fill('not-a-real-conversation')
                    expect(page.locator('#session-hint')).to_contain_text('No matching')
                    expect(page.get_by_role('button', name='Start sharing', exact=True)).to_be_disabled()
                    page.get_by_label('Find a conversation', exact=True).fill('onboarding')
                    page.get_by_role('checkbox').check()
                    page.get_by_role('button', name='Change folder or agent', exact=True).click()
                    expect(page.locator('#select-form')).to_be_visible()
                    page.get_by_role('button', name='Find conversations', exact=True).click()
                    page.get_by_label('Find a conversation', exact=True).fill('onboarding')
                    expect(page.get_by_role('checkbox')).not_to_be_checked()
                    page.get_by_role('button', name='Start sharing', exact=True).click()
                    expect(page.get_by_role('alert')).to_contain_text('sharing checkbox')
                    assert not owner.request('/api/state')['bindings']
                    page.screenshot(path=str(evidence / 'desktop-before-sharing.png'), full_page=True)
                    page.set_viewport_size({'width': 390, 'height': 844})
                    assert page.evaluate('document.documentElement.scrollWidth <= innerWidth')
                    page.screenshot(path=str(evidence / 'mobile-before-sharing.png'), full_page=True)
                    page.get_by_role('checkbox').check()
                    # Snapshot validation runs for real; worker is stubbed to avoid model calls.
                    with patch('relay.adapters.shutil.which', return_value='claude'):
                        page.get_by_role('button', name='Start sharing', exact=True).click()
                        expect(page.get_by_role('button', name='Pause sharing', exact=True)).to_be_visible(timeout=15000)
                    page.get_by_role('button', name='Pause sharing', exact=True).click()
                    expect(page.get_by_role('button', name='Resume sharing', exact=True)).to_be_visible(timeout=15000)
                    assert not owner.request('/api/state')['bindings'][0]['enabled']
                    page.screenshot(path=str(evidence / 'mobile-paused.png'), full_page=True)
                    page.reload()
                    expect(page.get_by_role('button', name='Resume sharing', exact=True)).to_be_visible(timeout=15000)
                    page.get_by_role('button', name='Connect another', exact=True).click()
                    expect(page.locator('#connections')).to_be_hidden()
                    page.locator('#cancel-connection').click()
                    expect(page.get_by_role('button', name='Resume sharing', exact=True)).to_be_visible()
                    offline = companion.state()
                    offline.update(member=None, projects=[], network_error='Hub unavailable. Check the private network.')
                    for connection in offline['connections']:
                        connection.update(reachable=False, status='offline', enabled=False)
                    page.route('**/api/state', lambda route: route.fulfill(json=offline))
                    page.reload()
                    expect(page.locator('#network-status')).to_be_visible()
                    expect(page.locator('#workspace')).to_be_hidden()
                    expect(page.get_by_role('button', name='Resume sharing', exact=True)).to_be_disabled()
                    expect(page.get_by_role('button', name='Connect another', exact=True)).to_be_disabled()
                    page.screenshot(path=str(evidence / 'ux-offline-mobile.png'), full_page=True)
                    page.unroute('**/api/state')
                    page.get_by_role('button', name='Retry connection', exact=True).click()
                    expect(page.locator('#network-status')).to_be_hidden()
                    expect(page.get_by_role('button', name='Resume sharing', exact=True)).to_be_enabled()
                    # Team context and questions now remain inside the same local tab.
                    page.get_by_role('button', name='Team workspace', exact=True).click()
                    expect(page.get_by_role('button', name='Read context / Ask')).to_be_visible()
                    page.get_by_role('button', name='Read context / Ask').click()
                    page.get_by_label('Ask the source agent').fill('What should another developer know about this feature?')
                    page.get_by_role('button', name='Send question', exact=True).click()
                    expect(page.get_by_role('heading', name='What should another developer know about this feature?')).to_be_visible()
                    expect(page.locator('#team-body')).to_contain_text('Sharing paused')
                    page.get_by_label('Search shared context').fill('not-matching')
                    expect(page.get_by_role('heading', name='No matching questions')).to_be_visible()
                    page.get_by_label('Search shared context').fill('')
                    page.reload()
                    expect(page.get_by_role('heading', name='What should another developer know about this feature?')).to_be_visible(timeout=15000)
                    assert len(owner.request('/api/state')['questions']) == 1
                    assert page.url.startswith(local.origin)
                    assert page.evaluate('document.documentElement.scrollWidth <= innerWidth')
                    page.screenshot(path=str(evidence / 'team-questions-mobile.png'), full_page=True)
                    page.set_viewport_size({'width': 1150, 'height': 900})
                    page.get_by_role('button', name='Shared context', exact=True).click()
                    project = owner.request('/api/state')['projects'][0]['id']
                    a = owner.action('session', {'project_id': project, 'name': 'QA backend agent'})['id']
                    b = owner.action('session', {'project_id': project, 'name': 'QA UI agent'})['id']
                    plan = owner.action('work-plan', dict(session_id=a, title='QA authentication API',
                        plan='Define the login response before changing it. <script>throw new Error("unsafe")</script>',
                        paths=['src/auth'], contracts=['login-api'], base_commit='a'*40))['work']
                    owner.action('work-start', dict(session_id=a, work_id=plan['id'], revision=1, base_commit='a'*40))
                    owner.action('work-plan', dict(session_id=b, title='QA login UI', plan='Agree on the login response',
                        paths=['ui/login'], contracts=['login-api'], base_commit='a'*40))
                    owner.action('work-message', dict(session_id=b, work_id=plan['id'], note='Can we keep the error field stable?'))
                    page.get_by_role('button', name='Team workspace', exact=True).click()
                    expect(page.get_by_role('heading', name='Working together', exact=True)).to_be_visible()
                    expect(page.get_by_role('region', name='Work coordination')).to_contain_text('Local edits are not blocked')
                    expect(page.get_by_role('region', name='Work coordination')).to_contain_text('Coordinating')
                    page.get_by_text('Plan and agent discussion', exact=True).first.click()
                    expect(page.get_by_role('region', name='Work coordination')).to_contain_text('Can we keep the error field stable?')
                    assert page.locator('#team-body script').count() == 0
                    owner.action('work-message', dict(session_id=b, work_id=plan['id'], note='Another update while reading'))
                    page.get_by_role('button', name='Team workspace', exact=True).click()
                    expect(page.locator('#team-body details').first).to_have_attribute('open', '')
                    page.screenshot(path=str(evidence / 'team-context-desktop.png'), full_page=True)
                    page.set_viewport_size({'width': 390, 'height': 844})
                    assert page.evaluate('document.documentElement.scrollWidth <= innerWidth')
                    page.screenshot(path=str(evidence / 'coordination-mobile.png'), full_page=True)
                    owner.action('live-join', dict(session_id=b, instance='browser-qa', repository_key='a'*64))
                    owner.action('live-record', dict(session_id=b, instance='browser-qa', kind='assistant', body='Managed fixture replied <script>not executable</script>'))
                    page.get_by_role('button', name='Team workspace', exact=True).click()
                    expect(page.get_by_role('heading', name='Live working sessions', exact=True)).to_be_visible()
                    page.get_by_text('Live agent activity', exact=True).click()
                    expect(page.get_by_role('region', name='Work coordination')).to_contain_text('Managed fixture replied')
                    assert page.locator('#team-body script').count() == 0
                    assert page.evaluate('document.documentElement.scrollWidth <= innerWidth')
                    page.screenshot(path=str(evidence / 'live-working-mobile.png'), full_page=True)
                    owner.action('live-leave', dict(session_id=b, instance='browser-qa'))
                    owner.action('team-create', dict(project_id=project, repository_key='a'*64,
                        objective='QA shared goal <script>not executable</script>'))
                    page.get_by_role('button', name='Team workspace', exact=True).click()
                    expect(page.get_by_role('region', name='Shared goals')).to_contain_text('0 / 0 tasks verified')
                    expect(page.get_by_role('region', name='Shared goals')).to_contain_text('relay-workspace team --goal')
                    page.get_by_text('Join this goal', exact=True).click()
                    expect(page.get_by_role('button', name='Copy join command', exact=True)).to_be_visible()
                    expect(page.get_by_role('region', name='Shared goals')).to_contain_text('--url')
                    with store.connect() as db:
                        goal_id = db.execute('SELECT id FROM team_goals ORDER BY created DESC LIMIT 1').fetchone()['id']
                        db.execute('INSERT INTO team_automation VALUES(?,?,?,?,?)', (goal_id, b, 'qa', json.dumps({'branch':'relay/qa', 'test_argv':['python','-m','unittest']}), 1))
                        db.execute("INSERT INTO team_tasks(id,goal_id,task_key,title,instructions,acceptance,paths,contracts,dependencies,status,created,updated) VALUES(?,?,?,?,?,?,?,?,?,'integration',1,1)", ('qa-ui-task',goal_id,'qa','UI-only test failure','Fixture only','Approved checks must pass','[]','[]','[]'))
                        db.execute('INSERT INTO team_integrations VALUES(?,?,?,?,?,?,?,?)', ('qa-ui-task',1,1,b,'qa','failed',json.dumps({'error':'Fixture failure <script>never execute</script>'}),1))
                    page.reload()
                    expect(page.get_by_role('region', name='Shared goals')).to_contain_text('Automatic tests and integration')
                    page.get_by_text('UI-only test failure', exact=False).click()
                    expect(page.get_by_role('region', name='Shared goals')).to_contain_text('/retry qa-ui-task')
                    expect(page.get_by_role('region', name='Shared goals')).to_contain_text('Fixture failure <script>never execute</script>')
                    assert page.locator('#team-body script').count() == 0
                    assert page.locator('#team-body script').count() == 0
                    assert page.evaluate('document.documentElement.scrollWidth <= innerWidth')
                    page.screenshot(path=str(evidence / 'shared-goals-mobile.png'), full_page=True)
                    with store.connect() as db:
                        db.execute("INSERT INTO team_workers VALUES(?,?,1)", (b, goal_id))
                        db.execute("UPDATE live_runtimes SET state='paused' WHERE session_id=?", (b,))
                    page.reload()
                    expect(page.get_by_role('region', name='Shared goals')).to_contain_text('do not start a duplicate session')
                    with store.connect() as db:
                        db.execute("UPDATE team_goals SET status='complete' WHERE id=?", (goal_id,))
                        db.execute("UPDATE team_tasks SET status='complete' WHERE id='qa-ui-task'")
                        db.execute("UPDATE team_integrations SET status='passed',receipt=? WHERE task_id='qa-ui-task'", (json.dumps({'commit':'a'*40, 'exit_code':0}),))
                    page.reload()
                    expect(page.get_by_role('region', name='Shared goals')).to_contain_text('Work complete.')
                    expect(page.get_by_role('region', name='Shared goals')).to_contain_text('1 / 1 tasks verified')
                    expect(page.get_by_role('button', name='Copy join command', exact=True)).to_have_count(0)
                    expect(page.get_by_role('region', name='Shared goals')).not_to_contain_text('Planning latest requirements')
                    page.get_by_text('Start a new goal', exact=True).click()
                    expect(page.get_by_role('button', name='Copy start command', exact=True)).to_be_visible()
                    page.get_by_text('Start a new goal', exact=True).click()
                    assert page.evaluate('document.documentElement.scrollWidth <= innerWidth')
                    page.screenshot(path=str(evidence / 'team-complete-mobile.png'), full_page=True)
                    page.set_viewport_size({'width': 1150, 'height': 900})
                    page.get_by_role('button', name='My agent', exact=True).click()
                    page.get_by_role('button', name='Enable agent tools', exact=True).click()
                    expect(page.get_by_role('dialog')).to_contain_text('normal approval rules')
                    def registration(path, config):
                        atomic_json(Path(path).with_suffix('.tools.json'), {'name': 'qa-tools', 'provider': 'claude'})
                        return {'configured':True,'message':'QA registration approved; no real client settings changed.'}
                    with patch('relay.integrations.register', side_effect=registration) as register:
                        page.get_by_role('dialog').get_by_role('button', name='Enable agent tools', exact=True).click()
                        expect(page.locator('#notice')).to_contain_text('QA registration approved')
                        assert register.call_count == 1
                    page.get_by_role('button', name='Finish agent connection', exact=True).click()
                    expect(page.get_by_role('dialog')).to_contain_text('Relay detects the connection automatically')
                    page.get_by_role('button', name='Close dialog', exact=True).click()
                    page.screenshot(path=str(evidence / 'my-agent-desktop.png'), full_page=True)
                    config_path = next(p for p in companion.connections.glob('*.json') if not p.stem.endswith(('.worker', '.tools')))
                    config, agent_client = load_config(config_path)
                    agent_client.action('heartbeat', {'session_id': config['session_id']})
                    page.reload()
                    expect(page.locator('#connections')).to_contain_text('Agent link connected')
                    expect(page.get_by_role('button', name='Finish agent connection', exact=True)).to_have_count(0)
                    Connector(config, agent_client).call('relay_project', {})
                    agent_client.action('session-toggle', {'session_id': config['session_id'], 'enabled': True})
                    agent_client.action('worker-status', {'session_id': config['session_id'], 'status': 'error', 'error': 'Hub unavailable fixture'})
                    page.reload()
                    expect(page.locator('#connections')).to_contain_text('Hub unavailable fixture')
                    agent_client.action('worker-status', {'session_id': config['session_id'], 'status': 'watching', 'error': ''})
                    page.reload()
                    expect(page.locator('#connections')).not_to_contain_text('Hub unavailable fixture')
                    expect(page.locator('#connections')).to_contain_text('successful tool use verified')
                    page.get_by_role('button', name='Agent connection', exact=True).click()
                    expect(page.get_by_role('dialog')).to_contain_text('received a successful tool call')
                    page.get_by_role('button', name='Close dialog', exact=True).click()
                    page.set_viewport_size({'width': 390, 'height': 844})
                    assert page.evaluate('document.documentElement.scrollWidth <= innerWidth')
                    page.screenshot(path=str(evidence / 'agent-connected-mobile.png'), full_page=True)
                    agent_client.action('offline', {'session_id': config['session_id']})
                    page.reload()
                    expect(page.locator('#connections')).to_contain_text('Agent currently offline')
                    page.get_by_role('button', name='Team workspace', exact=True).click()
                    page.get_by_role('button', name='Check team connection', exact=True).click()
                    expect(page.get_by_role('dialog')).to_contain_text('No model calls were made')
                    expect(page.get_by_role('dialog')).to_contain_text('Update/reopen Relay')
                    expect(page.get_by_role('dialog')).to_contain_text('does not verify matching repositories')
                    assert page.evaluate('document.documentElement.scrollWidth <= innerWidth')
                    page.screenshot(path=str(evidence / 'team-readiness-mobile.png'), full_page=True)
                    page.get_by_role('button', name='Close dialog', exact=True).click()
                    page.get_by_role('button', name='Settings', exact=True).click()
                    expect(page.get_by_role('dialog')).to_contain_text('paused conversations stay paused')
                    page.on('dialog', lambda dialog: dialog.accept())
                    with patch('relay.lifecycle.configure_startup', return_value={'enabled': True}) as startup, patch('relay.lifecycle.ensure'):
                        page.get_by_role('button', name='Start Relay when I sign in', exact=True).click()
                        page.wait_for_timeout(500)
                        assert startup.call_count == 1
                    page.get_by_role('button', name='Close dialog', exact=True).click()
                    approval.get_by_role('button', name='Close dialog', exact=True).click()
                    approval.get_by_role('button', name='Setup & help', exact=True).click()
                    expect(approval.get_by_role('dialog')).to_contain_text('Enable agent tools')
                    approval.get_by_role('dialog').get_by_role('button', name='Connect an agent', exact=True).click()
                    approval.get_by_text('I need to install Relay', exact=True).click()
                    approval.get_by_label('Computer', exact=True).select_option('mac')
                    install = approval.locator('#start-command').inner_text()
                    assert '\n' not in install and 'brew install relay/workspace/relay-workspace' in install
                    expect(approval.get_by_role('button', name='Copy install command', exact=True)).to_be_visible()
                    approval.screenshot(path=str(evidence / 'ux-hub-connect.png'), full_page=True)
                    assert not errors, errors
                    browser.close()
                report = {'passed': True, 'checks': ['invite join', 'browser device approval', 'readable local conversation',
                          'no sharing before consent', 'connect with full source identity check', 'pause', 'reload keeps sign-in',
                          '390px no horizontal overflow', 'no browser JavaScript errors', 'same-tab shared context and questions',
                          'explicit agent-tools approval', 'advisory coordination and peer discussion',
                          'coordination content escaped', 'coordination mobile layout', 'guided steps and back/cancel',
                          'empty conversations and filtered selection', 'consent resets on selection changes',
                          'offline reload preserves setup and retry recovers', 'paused question status',
                          'question search and remembered view', 'open discussions survive updates',
                          'configured agent has an actionable next step', 'hub help and single-line Homebrew install',
                          'worker recovery clears visible error', 'agent heartbeat is distinct from successful tool use',
                          'verified agent removes reconnect prompt', 'agent offline does not imply sharing offline',
                          'team readiness flags mixed builds', 'team check distinguishes readiness from acceptance', 'explicit login startup approval',
                          'managed live sessions and escaped activity', 'managed live mobile layout',
                          'shared goal visibility and escaped content', 'shared goals mobile layout',
                          'join command includes hub URL', 'automation branch and approved checks visible',
                          'failed checks show retry guidance', 'integration errors safely escaped',
                          'paused team worker has recovery guidance', 'completed goal retains verified result',
                          'completed goal cannot be joined', 'completed goal mobile layout',
                          'completed goal has no stale planning label', 'new goal start remains available after completion'],
                          'models': 'stubbed', 'real_user_sessions': False}
                (evidence / 'verification.json').write_text(json.dumps(report, indent=2))
                print(json.dumps(report))
            finally:
                companion.stop()
                for server in (local, hub):
                    server.shutdown()
                    server.server_close()
                for thread in threads:
                    thread.join()


if __name__ == '__main__':
    main()
