"""One guided connection flow. Never edits agent settings or runs a remote shell."""
import getpass
import copy
import hashlib
from datetime import datetime
import json
import os
from pathlib import Path
import secrets
import shlex
import shutil
import sys
from types import SimpleNamespace
from urllib.parse import urlsplit

from . import client, worker
from .discovery import git_root, same_repository


def session_directory(repo):
    """Private per-checkout CLI state, not a global working-root preference."""
    from .companion import data_directory
    key = hashlib.sha256(os.path.normcase(str(Path(repo).resolve())).encode()).hexdigest()[:24]
    return data_directory().parent / 'cli' / key


def confirm_repository(candidate):
    while True:
        root = git_root(candidate)
        if root:
            try:
                info = client.git_info(root)
            except (ValueError, OSError) as exc:
                print(str(exc))
            else:
                print('\nRepository root for this shared session:\n  ' + root)
                print('Branch: ' + info['branch'])
                reply = input('Is this the right folder root? [Y/n/q]: ').strip().lower()
                if reply in {'', 'y', 'yes'}: return root
                if reply in {'q', 'quit'}: return None
                if reply not in {'n', 'no'}:
                    print('Enter y to confirm, n to choose another folder, or q to cancel.')
                    continue
        else:
            print('This folder is not an existing Git checkout: ' + str(candidate))
        value = input('Folder to use for this session (q to cancel): ').strip().strip('"').strip("'")
        if value.lower() in {'q', 'quit'}: return None
        if not value:
            print('Enter a folder path. No root has been selected.')
            continue
        candidate = Path(value).expanduser().resolve()


def choose(title, items, label):
    print('\n' + title)
    for index, item in enumerate(items, 1):
        print(f'  {index}. {label(item)}')
    while True:
        value=input('Choose a number: ').strip()
        if value.isdigit() and 1 <= int(value) <= len(items):
            return items[int(value)-1]
        print(f'Enter a number from 1 to {len(items)}. Ctrl+C cancels.')


def shell_command(parts, windows=None):
    windows=os.name=='nt' if windows is None else windows
    if windows:
        return '& ' + ' '.join("'" + str(part).replace("'", "''") + "'" for part in parts)
    return shlex.join([str(part) for part in parts])


def integration_command(config_path, config):
    name='relay-'+config['session_id'][:8]
    command=[sys.executable,str(Path(__file__).with_name('launch.py')),'mcp','--config',str(config_path)]
    if config['provider']=='claude':
        return ['claude','mcp','add','--transport','stdio','--scope','local',name,'--',*command]
    return ['codex','mcp','add',name,'--',*command]


def source_label(source):
    name=source.get('name') or 'Conversation '+source['id'][:12]
    timestamp=source.get('updated') or source.get('modified')
    if timestamp:
        try:name+=' - '+datetime.fromtimestamp(float(timestamp)).strftime('%d %b, %H:%M')
        except (ValueError,TypeError,OSError,OverflowError):pass
    return name


def show_next_steps(path, config):
    print('\nONE-TIME: let your coding agent ask teammates questions')
    print('In a second terminal, from your coding repository, run:')
    print(shell_command(integration_command(path,config)))
    print('This registers Relay tools in your agent client. Relay has NOT run it for you.')
    print('Codex uses user settings; Claude uses settings local to that repository.')
    print('Reconnect the client, check /mcp, and allow Relay tools under your normal approval policy.')
    print('Tell your agent: Use relay_search before changing shared features; use relay_clarify when context is missing.')
    launcher=Path.cwd()/'start.py'
    if launcher.is_file() and launcher.read_text(encoding='utf-8').startswith('# Relay managed launcher\n'):
        print('\nNEXT TIME: '+shell_command([sys.executable,str(launcher.resolve())]))
    else:
        print('\nNEXT TIME: run python -m relay start and choose this saved connection.')
    print('A sharing worker must be running for activity and automatic answers. Ctrl+C stops a worker started in this terminal.')


def workspace_defaults(args, state_directory=None, fallback_directories=()):
    """An explicit destination always wins; never carry a project to a different hub."""
    saved={}
    choices = [Path(state_directory or '.relay') / 'workspace.json',
               *(Path(folder) / 'workspace.json' for folder in fallback_directories)]
    path = next((p for p in choices if p.is_file()), choices[0])
    if path.exists():
        try:
            saved=json.loads(path.read_text(encoding='utf-8'))
            if not isinstance(saved,dict):raise ValueError()
        except (ValueError,OSError):
            if not args.url:raise ValueError('Saved workspace settings are unreadable. Run start with --url to choose the workspace again.') from None
    url=(args.url or saved.get('url') or 'http://localhost:7331').rstrip('/')
    client.Client(url,'')  # Validate the destination before prompting for credentials.
    scoped = path.parent.resolve() in {Path(state_directory or '.relay').resolve(), Path('.relay').resolve()}
    project=args.project or (saved.get('project_id') if saved.get('url')==url and scoped else None)
    return url,project


def remember_workspace(config, state_directory=None):
    path=Path(state_directory or '.relay') / 'workspace.json'
    path.parent.mkdir(parents=True,exist_ok=True)
    worker.atomic_json(path,{'url':config['url'],'project_id':config['project_id']})


def start(args, access_token=None):
    print('Relay setup - connect a working session, then keep coding.\n')
    original = Path.cwd()
    repo = confirm_repository(getattr(args, 'repo', None) or original)
    if repo is None:
        print('Cancelled. No shared session was started or changed.')
        return None
    args = copy.copy(args)
    if args.token_file: args.token_file = str(Path(args.token_file).expanduser().resolve())
    print('Using this root for Relay only; no global working folder is saved.')
    print('To move your terminal too: ' + shell_command(['Set-Location', '-LiteralPath', repo] if os.name == 'nt' else ['cd', '--', repo]))
    print('An already-running coding agent keeps its own working directory.')
    try:
        os.chdir(repo)
        return start_in_repository(args, access_token, repo, original)
    finally:
        os.chdir(original)


def start_in_repository(args, access_token, repo, original):
    private = session_directory(repo)
    legacy = [Path(repo) / '.relay', original / '.relay']
    url,project_choice=workspace_defaults(args, private, legacy)
    print('Workspace: '+url)
    saved=[]
    candidates = []
    for folder in [private, *legacy]:
        candidates.extend((folder / 'connections').glob('*.json'))
        if (folder / 'connector.json').is_file(): candidates.append(folder / 'connector.json')
    # Existing GUI connections can be selected too, but only for this checkout.
    from .companion import data_directory
    candidates.extend((data_directory() / 'connections').glob('*.json'))
    seen = set()
    for path in candidates:
        try:
            config=json.loads(path.read_text(encoding='utf-8'))
            if (config.get('share_session') and config.get('url','').rstrip('/')==url
                    and (not project_choice or config.get('project_id')==project_choice)
                    and same_repository(config.get('repo'), repo) and config.get('session_id') not in seen):
                saved.append((path.resolve(),config))
                seen.add(config['session_id'])
        except (ValueError,OSError):continue
    if saved:
        selection=choose('Resume a saved connection, or add one:',[*saved,None],
            lambda item: f"{item[1].get('provider')} / {item[1].get('repo')} / {item[1]['session_id'][:8]}" if item else 'Connect another session')
        if selection:
            path,config=selection
            _,hub=client.load_config(path)
            state=hub.request('/api/state')
            binding=next((b for b in state['bindings'] if b['session_id']==config['session_id']),None)
            if not binding or not binding['enabled']:
                raise ValueError('This connection is paused or unavailable. Resume it in the Agents screen first.')
            remember_workspace(config, private)
            show_next_steps(path,config)
            if not args.setup_only:
                if binding.get('worker_online'):
                    print('This session already has an online sharing worker; no second worker was started.')
                else:
                    worker.watch(SimpleNamespace(config=str(path)))
            return path
    token=access_token or os.environ.get('RELAY_TOKEN','')
    if args.token_file:token=Path(args.token_file).read_text(encoding='utf-8').strip()
    if not token:
        local_owner=original / '.relay/hub/owner-token'
        parsed=urlsplit(url)
        if parsed.hostname in {'localhost','127.0.0.1'} and parsed.port==7331 and local_owner.is_file():
            if input('Use this local workspace as its owner? [y/N]: ').strip().lower()=='y':
                token=local_owner.read_text(encoding='utf-8').strip()
        if not token:token=getpass.getpass('Paste your workspace access token (hidden): ')
    hub=client.Client(url,token)
    state=hub.request('/api/state')
    projects=state['projects']
    if project_choice:
        project=next((p for p in projects if project_choice in {p['id'],p['name']}),None)
        if not project:raise ValueError('Project not found. Check the workspace URL and project.')
    elif len(projects)==1:project=projects[0]
    elif projects:project=choose('Which shared project?',projects,lambda p:p['name'])
    else:raise ValueError('Create a project in the browser, then run this command again.')
    print('Workspace project: '+project['name'])
    provider=choose('Which agent are you using?',['codex','claude'],lambda p:'Codex' if p=='codex' else 'Claude Code')
    if not shutil.which(provider):raise ValueError(f'{provider} is not installed or not on PATH. Install and sign in to your coding client first.')
    print('Looking for sessions in this repository only...')
    sources=client.discover_sessions(provider,repo)
    if not sources:
        raise ValueError('No sessions found in that repository. Start a coding session there, complete one turn, then try again. Advanced connect options are in README.md.')
    source=choose('Which conversation should Relay share?',sources,source_label)
    name=input('Feature name (Enter to use the repository name): ').strip() or Path(repo).name
    print('\nShare ONLY this selected conversation with all invited workspace members.')
    print('Visible messages and activity will be uploaded; known secrets are redacted, but detection is not guaranteed.')
    print('Relay creates explanation forks using your existing login: up to 12 model calls/hour. No code editing.')
    print('You can pause sharing in Agents. No other conversations or client settings are connected.')
    if input('Start sharing this conversation? [y/N]: ').strip().lower()!='y':
        print('Cancelled. No connection created and no conversation uploaded.')
        return None
    path=private / 'connections' / (secrets.token_hex(12)+'.json')
    connect_args=SimpleNamespace(url=url,project=project['id'],name=name,repo=repo,config=str(path),token_file=None,
        agent=provider,source_session=source['id'],source_file=source.get('source_file'),share_session=True,max_calls_per_hour=12)
    path=client.connect(connect_args,token=token)
    config,_=client.load_config(path)
    remember_workspace(config, private)
    show_next_steps(path,config)
    if not args.setup_only:worker.watch(SimpleNamespace(config=str(path)))
    return path
