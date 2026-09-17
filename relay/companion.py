"""Loopback-only desktop companion. Browser UI; no inbound peer connections."""
import json
import os
from pathlib import Path
import secrets
import socket
import subprocess
import sys
import threading
import time
from types import SimpleNamespace
from urllib.parse import parse_qs, urlsplit
from urllib.request import Request
import webbrowser

from .client import Client, connect, discover_sessions, load_config
from .discovery import git_root, repositories
from .install_client import user_directory, validate_hub
from .server import Handler, Hub
from .store import Problem, field
from .worker import Worker, atomic_json, instance_lock
from .processes import background_options


def data_directory():
    return user_directory('companion').parents[1] / 'companion'


class Companion:
    def __init__(self, directory, default_url='', current=None):
        self.directory = Path(directory)
        self.directory.mkdir(parents=True, exist_ok=True)
        self.directory.chmod(0o700)
        self.connections = self.directory / 'connections'
        self.connections.mkdir(exist_ok=True)
        self.default_url = default_url or ''
        self.current = current
        self.client = None
        self.pairing = None
        self.selection = None
        self.workers = {}
        self.errors = {}
        self.lock = threading.RLock()
        self.stopped = threading.Event()
        auth = self.directory / 'workspace.json'
        if auth.exists():
            saved = json.loads(auth.read_text(encoding='utf-8'))
            self.client = Client(validate_hub(saved['url']), saved['token'])
        for path in self.connections.glob('*.json'):
            if path.stem.endswith(('.worker', '.tools')):
                continue
            try:
                config, _ = load_config(path)
                if config.get('share_session'):
                    self.start_worker(path)
            except (ValueError, OSError, KeyError):
                self.errors[path.stem] = 'Could not reopen this connection.'

    def start_worker(self, path):
        existing = self.workers.get(path.stem)
        if existing and existing[1].is_alive():
            return
        worker = Worker(path)
        def run():
            nonlocal worker
            attempts = 0
            while not self.stopped.is_set():
                try:
                    if attempts:
                        worker = Worker(path)
                        self.workers[path.stem] = (worker, thread)
                    with instance_lock(path):
                        self.errors.pop(path.stem, None)
                        worker.run()
                    if worker.stop.is_set(): return
                except Exception:
                    attempts += 1
                    self.errors[path.stem] = 'Sharing worker stopped. Relay will retry automatically.'
                if self.stopped.wait(min(60, 2 ** min(attempts, 6))): return
        thread = threading.Thread(target=run, daemon=True)
        self.workers[path.stem] = (worker, thread)
        thread.start()

    def stop(self):
        self.stopped.set()
        for worker, _ in self.workers.values():
            worker.stop.set()

    def state(self):
        from .lifecycle import startup_status, running
        from .reliability import release_info
        result = dict(workspace=self.client.url if self.client else self.default_url,
                      member=None, saved_workspace=self.client is not None, projects=[], connections=[], network_error='',
                      release=release_info(), startup_enabled=startup_status(self.directory),
                      supervised=running(self.directory, 'desktop'))
        cache = {}
        if self.client:
            try:
                remote = self.client.request('/api/state')
                cache[self.client.url + self.client.token] = remote
                result.update(member=remote['me']['name'], projects=[{'id': p['id'], 'name': p['name']} for p in remote['projects']])
            except ValueError as exc:
                result['network_error'] = str(exc)
        for path in self.connections.glob('*.json'):
            if path.stem.endswith(('.worker', '.tools')):
                continue
            try:
                config, client = load_config(path)
                key = client.url + client.token
                if key not in cache:
                    cache[key] = client.request('/api/state')
                remote = cache[key]
                binding = next((b for b in remote['bindings'] if b['session_id'] == config['session_id']), None)
                session = next((s for s in remote['sessions'] if s['id'] == config['session_id']), {})
                item = dict(id=path.stem, name=session.get('name', Path(config['repo']).name),
                            tools_configured=path.with_suffix('.tools.json').exists(),
                            agent_online=bool(session.get('agent_online')),
                            agent_tool_used=bool(session.get('agent_tool_used')),
                            provider=config['provider'], repo=config['repo'], enabled=bool(binding and binding['enabled']),
                            reachable=True, worker_online=bool(binding and binding['worker_online']),
                            status='paused' if binding and not binding['enabled'] else binding['status'] if binding else 'offline',
                            error=self.errors.get(path.stem, '') or (binding['error'] if binding else 'Connection no longer available.'))
            except (ValueError, OSError, KeyError):
                item = dict(id=path.stem, name='Saved connection', provider='', repo='',
                            enabled=False, reachable=False, status='offline', error='Workspace unreachable. Check Tailscale and the host PC.')
            result['connections'].append(item)
        return result

    def action(self, name, data):
        with self.lock:
            if name == 'startup':
                if data.get('consent') is not True:
                    raise ValueError('Approve changing login startup first.')
                from .lifecycle import configure_startup, ensure
                result = configure_startup(self.directory, data.get('enabled'))
                ensure(self.directory)
                return result
            if name == 'team-check':
                if not self.client: raise ValueError('Connect your workspace first.')
                from .reliability import team_check
                return team_check(self.client.request('/api/state'), field(data, 'project_id', 64))
            if name in {'team', 'ask'}:
                if not self.client:
                    raise ValueError('Connect your workspace first.')
                if name == 'team':
                    state = self.client.request('/api/state')
                    import shlex
                    command = ['relay-workspace', 'team']
                    if os.name == 'nt':
                        python = Path(sys.executable).with_name('python.exe')
                        command = [str(python), str(Path(__file__).absolute().with_name('launch.py')), 'team']
                    command += ['--url', state.get('workspace_url', self.client.url)]
                    team_command = subprocess.list2cmdline(command) if os.name == 'nt' else shlex.join(command)
                    return {**{key: state[key] for key in ('projects', 'features', 'sessions', 'bindings', 'questions', 'observations')},
                            'team_command': team_command,
                            'coordination': state.get('coordination', {'mode': 'unavailable', 'edit_gate': False, 'plans': [], 'messages': []}),
                            'team': state.get('team')}
                return self.client.action('question', {'feature_id': field(data, 'feature_id', 64),
                                                       'body': field(data, 'question', 6000)})
            if name == 'enable-tools':
                if data.get('consent') is not True:
                    raise ValueError('Approve adding Relay tools to your coding client first.')
                path = self.connection_path(data)
                config, _ = load_config(path)
                from .integrations import register
                return register(path, config)
            if name == 'pair':
                value = field(data, 'url', 2048)
                parsed = urlsplit(value)
                hub = validate_hub(parsed._replace(fragment='').geturl())
                invite = parse_qs(parsed.fragment).get('invite', [''])[0]
                client = Client(hub, '')
                pairing = client.request('/api/pair/start', {'machine': socket.gethostname()})
                self.pairing = (client, pairing['device_secret'])
                url = hub + '/#pair=' + pairing['code']
                if invite:
                    from urllib.parse import quote
                    url += '&invite=' + quote(invite, safe='')
                webbrowser.open(url)
                return {'code': pairing['code'], 'url': url}
            if name == 'poll':
                if not self.pairing:
                    raise ValueError('Click Connect workspace first.')
                client, secret = self.pairing
                response = client.request('/api/pair/poll', {'device_secret': secret})
                if response['status'] == 'approved':
                    self.client = Client(client.url, response['token'])
                    atomic_json(self.directory / 'workspace.json', {'url': client.url, 'token': response['token']})
                    self.pairing = None
                    return {'status': 'approved'}
                return {'status': 'pending'}
            if name == 'repositories':
                return repositories(self.current)
            if name == 'choose-folder':
                return {'path': choose_folder()}
            if name == 'sessions':
                provider = field(data, 'provider', 20)
                if provider not in {'claude', 'codex'}:
                    raise ValueError('Choose Claude Code or Codex.')
                repo = git_root(field(data, 'repo', 2048))
                if not repo:
                    raise ValueError('Choose an existing Git checkout on this computer.')
                sessions = discover_sessions(provider, repo)
                self.selection = dict(repo=repo, provider=provider, sessions=sessions)
                return [{'id': s['id'], 'name': s.get('name') or 'Untitled Codex conversation',
                         'updated': s.get('modified', s.get('updated')), 'compatible': s.get('compatible', True),
                         'reason': s.get('reason', '')} for s in sessions]
            if name == 'connect':
                if data.get('consent') is not True:
                    raise ValueError('Confirm sharing this conversation first.')
                if not self.client or not self.selection:
                    raise ValueError('Connect your workspace and choose a conversation first.')
                selected = self.selection
                source = next((s for s in selected['sessions'] if s['id'] == data.get('source_id')), None)
                if not source or not source.get('compatible', True):
                    raise ValueError('Choose a conversation from this checkout.')
                for path in self.connections.glob('*.json'):
                    if path.stem.endswith(('.worker', '.tools')):
                        continue
                    config, _ = load_config(path)
                    if (config.get('source_id') == source['id'] and config.get('provider') == selected['provider']
                            and config.get('url') == self.client.url):
                        raise ValueError('This conversation is already connected. Use Resume on its card.')
                path = self.connections / (secrets.token_hex(12) + '.json')
                args = SimpleNamespace(url=self.client.url, project=field(data, 'project', 160),
                    name=field(data, 'name', 160, False) or Path(selected['repo']).name,
                    repo=selected['repo'], agent=selected['provider'], config=str(path), token_file=None,
                    source_session=source['id'], source_file=source.get('source_file'), share_session=True,
                    max_calls_per_hour=12, quiet=True)
                # Full transcript identity check happens inside connect before any hub mutation.
                connect(args, token=self.client.token)
                self.start_worker(path)
                return {'ok': True}
            if name == 'toggle':
                path = self.connection_path(data)
                if not isinstance(data.get('enabled'), bool):
                    raise ValueError('Choose Pause or Resume.')
                config, client = load_config(path)
                client.action('session-toggle', {'session_id': config['session_id'], 'enabled': data['enabled']})
                if data['enabled']:
                    self.start_worker(path)
                return {'ok': True}
            raise Problem('Not found', 404)

    def connection_path(self, data):
        key = field(data, 'id', 24)
        if len(key) != 24 or any(c not in '0123456789abcdef' for c in key):
            raise ValueError('Unknown connection.')
        path = self.connections / (key + '.json')
        if path.is_symlink() or not path.is_file():
            raise ValueError('Unknown connection.')
        return path


def choose_folder():
    if sys.platform == 'darwin':
        result = subprocess.run(['osascript', '-e', 'POSIX path of (choose folder with prompt "Choose your coding repository")'],
                                capture_output=True, text=True, timeout=120)
        return result.stdout.strip() if result.returncode == 0 else ''
    # Tk is not bundled with every Python distribution; typed path remains available.
    script = 'import tkinter as t;from tkinter.filedialog import askdirectory;r=t.Tk();r.withdraw();print(askdirectory(title="Choose your coding repository"));r.destroy()'
    result = subprocess.run([sys.executable, '-c', script], capture_output=True, text=True, timeout=120, **background_options())
    if result.returncode:
        raise ValueError('Folder picker is unavailable. Paste your folder path in the field instead.')
    return result.stdout.strip()


class CompanionHandler(Handler):
    def dispatch(self):
        try:
            self.validate_origin()
            path = urlsplit(self.path).path
            if self.command == 'GET' and path in {'/', '/companion.js', '/companion.css', '/favicon.svg'}:
                filename = 'companion.html' if path == '/' else path[1:]
                kind = {'html': 'text/html', 'js': 'text/javascript', 'css': 'text/css', 'svg': 'image/svg+xml'}[filename.rsplit('.', 1)[1]]
                return self.send(200, (Path(__file__).parent / 'web' / filename).read_bytes(), kind + '; charset=utf-8')
            if not secrets.compare_digest(self.token(), self.server.capability):
                raise Problem('Open Relay from its app launcher to reconnect this browser.', 401)
            if path == '/api/health' and self.command == 'GET':
                return self.send(200, {'ok': True})
            if path == '/api/state' and self.command == 'GET':
                return self.send(200, self.server.companion.state())
            if path.startswith('/api/') and self.command == 'POST':
                data = self.body()
                if path == '/api/quit':
                    from .lifecycle import stop
                    stop(self.server.companion.directory)
                    self.server.companion.stop()
                    threading.Thread(target=self.server.shutdown, daemon=True).start()
                    return self.send(200, {'ok': True})
                return self.send(200, self.server.companion.action(path[5:], data))
            raise Problem('Not found', 404)
        except Problem as exc:
            self.send(exc.status, {'error': str(exc)})
        except (BrokenPipeError, ConnectionResetError, ConnectionAbortedError):
            pass  # Browser navigation can close a request before its response.
        except (ValueError, OSError, subprocess.TimeoutExpired) as exc:
            self.send(400, {'error': str(exc) if not isinstance(exc, subprocess.TimeoutExpired) else 'This took too long. Try again.'})
        except Exception:
            self.send(500, {'error': 'Could not complete this step. Nothing else was selected; please retry.'})


class CompanionServer(Hub):
    def __init__(self, companion):
        # Deliberately bypass Hub's store/public network configuration.
        from http.server import ThreadingHTTPServer
        ThreadingHTTPServer.__init__(self, ('127.0.0.1', 0), CompanionHandler)
        self.stopping = threading.Event()
        self.companion = companion
        self.capability = secrets.token_urlsafe(32)
        self.public_origin = None
        self.origins = {self.origin}

    @property
    def origin(self):
        return 'http://127.0.0.1:' + str(self.server_address[1])


def desktop(args):
    directory = Path(args.data)
    directory.mkdir(parents=True, exist_ok=True)
    # Finder-launched applications often inherit a minimal PATH.
    if sys.platform == 'darwin':
        os.environ['PATH'] = os.pathsep.join(['/opt/homebrew/bin', '/usr/local/bin', str(Path.home() / '.local/bin'), os.environ.get('PATH', '')])
    with instance_lock(directory / 'desktop.json'):
        companion = Companion(directory, args.url, args.current)
        server = CompanionServer(companion)
        atomic_json(directory / 'runtime.json', {'origin': server.origin, 'capability': server.capability})
        try:
            server.serve_forever()
        finally:
            companion.stop()
            server.server_close()


def runtime(directory):
    try:
        value = json.loads((directory / 'runtime.json').read_text(encoding='utf-8'))
        parsed = urlsplit(value['origin'])
        if parsed.scheme != 'http' or parsed.hostname != '127.0.0.1' or parsed.path:
            return None
        request = Request(value['origin'] + '/api/health', headers={'Authorization': 'Bearer ' + value['capability']})
        from .client import NoRedirect
        from urllib.request import build_opener
        with build_opener(NoRedirect).open(request, timeout=1) as response:
            if json.load(response).get('ok'):
                return value
    except (OSError, ValueError, KeyError):
        return None


def launch(args):
    directory = Path(getattr(args, 'data', None) or data_directory())
    directory.mkdir(parents=True, exist_ok=True)
    directory.chmod(0o700)
    from .lifecycle import ensure
    ensure(directory, url=args.url, current=str(Path.cwd()))
    value = runtime(directory)
    for _ in range(60):
        if value: break
        time.sleep(0.2)
        value = runtime(directory)
    if not value:
        raise ValueError('Relay could not open. Check ' + str(directory / 'desktop.log'))
    webbrowser.open(value['origin'] + '/#key=' + value['capability'])
    print('Relay opened in your browser. You can close this terminal. Use Quit Relay in the app to stop syncing.')
