"""Opt-in per-user login startup and a quiet, bounded-retry process supervisor.

No system service, elevated account, arbitrary command, or remote execution.
Quit stops recovery until the next explicit launch/login; pause stays on the hub.
"""
import hashlib
import json
import os
from pathlib import Path
import plistlib
import subprocess
import sys
import time

from .worker import atomic_json, instance_lock
from .processes import background_options


def command():
    python = Path(sys.executable)
    entry = Path(__file__).absolute().with_name('launch.py')
    # Keep Homebrew login registrations independent of a particular Cellar revision.
    if 'Cellar' in entry.parts:
        prefix = Path(*entry.parts[:entry.parts.index('Cellar')])
        stable = prefix / 'opt/relay-workspace/libexec/relay/launch.py'
        stable_python = prefix / 'opt/python@3.13/bin/python3.13'
        if stable.is_file() and stable_python.is_file():
            entry, python = stable, stable_python
    if os.name == 'nt' and python.with_name('pythonw.exe').is_file():
        python = python.with_name('pythonw.exe')
    return [str(python), str(entry)]


def identity(directory, kind):
    if kind not in {'desktop', 'hub'}:
        raise ValueError('Unknown background service')
    return 'relay-workspace-' + kind + '-' + hashlib.sha256(str(Path(directory).resolve()).encode()).hexdigest()[:12]


def startup_spec(directory, kind='desktop', platform=None, home=None):
    platform, home = platform or sys.platform, Path(home or Path.home())
    directory = Path(directory).resolve()
    label = identity(directory, kind)
    args = command() + ['background', '--kind', kind, '--data', str(directory)]
    if any(any(ord(c) < 32 for c in arg) for arg in args):
        raise ValueError('Login paths cannot contain control characters')
    if platform == 'win32':
        value = subprocess.list2cmdline(args)
        if len(value) > 260:
            raise ValueError('Login command is too long. Install Relay in a shorter permanent path.')
        return dict(kind='registry', name=label, value=value)
    if platform == 'darwin':
        payload = plistlib.dumps(dict(Label=label, ProgramArguments=args, RunAtLoad=True,
            KeepAlive=False, ProcessType='Background'))
        return dict(kind='file', path=str(home / 'Library/LaunchAgents' / (label + '.plist')), value=payload.decode())
    if platform.startswith('linux'):
        def quote(arg):
            # Desktop Entry escaping, followed by Exec argument quoting (no shell).
            arg = arg.replace('%', '%%')
            arg = ''.join('\\' + c if c in '\\"`$' else c for c in arg)
            return '"' + arg.replace('\\', '\\\\') + '"'
        config = Path(os.environ.get('XDG_CONFIG_HOME', str(home / '.config')))
        if not config.is_absolute():
            raise ValueError('XDG_CONFIG_HOME must be absolute')
        value = '[Desktop Entry]\nType=Application\nName=Relay workspace\nTerminal=false\nExec=' + ' '.join(map(quote, args)) + '\n'
        return dict(kind='file', path=str(config / 'autostart' / (label + '.desktop')), value=value)
    raise ValueError('Login startup is supported on Windows, macOS and Linux desktops')


def read_registration(spec):
    if spec['kind'] == 'file':
        path = Path(spec['path'])
        if any(p.is_symlink() for p in (path, *path.parents)):
            raise ValueError('Refusing a redirected login entry')
        return path.read_text(encoding='utf-8') if path.exists() else None
    import winreg
    try:
        with winreg.OpenKey(winreg.HKEY_CURRENT_USER, r'Software\Microsoft\Windows\CurrentVersion\Run') as key:
            return winreg.QueryValueEx(key, spec['name'])[0]
    except FileNotFoundError:
        return None


def write_registration(spec, enabled):
    if spec['kind'] == 'file':
        path = Path(spec['path'])
        if enabled:
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(spec['value'], encoding='utf-8')
            path.chmod(0o600)
        else:
            path.unlink(missing_ok=True)
    else:
        import winreg
        with winreg.CreateKey(winreg.HKEY_CURRENT_USER, r'Software\Microsoft\Windows\CurrentVersion\Run') as key:
            if enabled:
                winreg.SetValueEx(key, spec['name'], 0, winreg.REG_SZ, spec['value'])
            else:
                try: winreg.DeleteValue(key, spec['name'])
                except FileNotFoundError: pass


def startup_status(directory, kind='desktop'):
    receipt = Path(directory) / (kind + '-startup.json')
    if not receipt.exists(): return False
    try:
        saved = json.loads(receipt.read_text(encoding='utf-8'))
        return bool(saved['enabled'] and read_registration(saved['spec']) == saved['spec']['value'])
    except (ValueError, KeyError, OSError):
        return False


def configure_startup(directory, enabled, kind='desktop'):
    if type(enabled) is not bool: raise ValueError('Choose whether to start at login')
    directory = Path(directory).resolve()
    if kind == 'hub' and not all((directory / name).is_file() for name in ('owner-token', 'relay.sqlite3')):
        raise ValueError('Choose an existing Relay hub data directory')
    directory.mkdir(parents=True, exist_ok=True)
    spec = startup_spec(directory, kind)
    receipt = directory / (kind + '-startup.json')
    previous = json.loads(receipt.read_text(encoding='utf-8')) if receipt.exists() else {}
    current = read_registration(spec)
    allowed = {None, spec['value'], previous.get('spec', {}).get('value')}
    if current not in allowed:
        raise ValueError('This login entry was changed outside Relay; nothing was overwritten')
    write_registration(spec, enabled)
    atomic_json(receipt, dict(enabled=enabled, spec=spec))
    return dict(enabled=startup_status(directory, kind), scope='current-user-login')


def detached_options():
    if os.name != 'nt':
        return dict(start_new_session=True)
    options = background_options()
    # DETACHED_PROCESS causes Windows to ignore CREATE_NO_WINDOW. Separate the
    # process group without discarding the quiet-launch contract instead.
    options['creationflags'] |= subprocess.CREATE_NEW_PROCESS_GROUP
    return options


def stop(directory, kind='desktop'):
    atomic_json(Path(directory) / (kind + '-control.json'), {'run': False})


def running(directory, kind):
    try:
        state = json.loads((Path(directory) / (kind + '-supervisor.json')).read_text())
        return time.time() - state['seen'] < 20
    except (OSError, ValueError, KeyError):
        return False


def ensure(directory, kind='desktop', url=None, current=None):
    directory = Path(directory).resolve()
    identity(directory, kind)
    if kind == 'hub' and not all((directory / name).is_file() for name in ('owner-token', 'relay.sqlite3')):
        raise ValueError('Choose an existing Relay hub data directory')
    directory.mkdir(parents=True, exist_ok=True)
    if kind == 'desktop' and (url is not None or current is not None):
        from .install_client import validate_hub
        atomic_json(directory / 'launch-options.json', dict(url=validate_hub(url) if url else None, current=current))
    atomic_json(directory / (kind + '-control.json'), {'run': True})
    if not running(directory, kind):
        with (directory / (kind + '-supervisor.log')).open('a', encoding='utf-8') as log:
            subprocess.Popen(command() + ['supervise', '--kind', kind, '--data', str(directory)],
                stdin=subprocess.DEVNULL, stdout=log, stderr=log, **detached_options())


def healthy(directory, kind):
    if kind == 'desktop':
        from .companion import runtime
        return bool(runtime(directory))
    from .client import Client
    try:
        # Authenticated check avoids treating an unrelated listener as our hub.
        token = (directory / 'owner-token').read_text().strip()
        state = Client('http://127.0.0.1:7331', token).request('/api/state')
        return state['me']['role'] == 'owner'
    except (ValueError, OSError, KeyError):
        return False


def supervise(args):
    directory, kind = Path(args.data).resolve(), args.kind
    identity(directory, kind)
    with instance_lock(directory / (kind + '-supervisor-lock.json')):
        child, retry_at, failures = None, 0, 0
        while True:
            try:
                if not json.loads((directory / (kind + '-control.json')).read_text()).get('run'):
                    atomic_json(directory / (kind + '-supervisor.json'), dict(seen=0, healthy=False, pid=os.getpid(), child_pid=None, retries=0))
                    return  # Quit is intentional, never a crash to auto-restart.
                ok = healthy(directory, kind)
                if ok:
                    failures, retry_at = 0, 0
                elif time.monotonic() >= retry_at and (child is None or child.poll() is not None):
                    flags = command() + ([kind, '--data', str(directory)] if kind == 'desktop' else ['hub', '--data', str(directory)])
                    if kind == 'desktop' and (directory / 'launch-options.json').exists():
                        settings = json.loads((directory / 'launch-options.json').read_text())
                        for name in ('url', 'current'):
                            if settings.get(name): flags += ['--' + name, str(settings[name])]
                    logfile = directory / (kind + '-background.log')
                    if logfile.exists() and logfile.stat().st_size > 2 * 1024 * 1024:
                        logfile.replace(logfile.with_suffix('.previous.log'))
                    with logfile.open('a', encoding='utf-8') as log:
                        child = subprocess.Popen(flags, stdin=subprocess.DEVNULL, stdout=log, stderr=log, **detached_options())
                    failures += 1
                    retry_at = time.monotonic() + min(60, 2 ** min(failures, 6))
                atomic_json(directory / (kind + '-supervisor.json'), dict(seen=time.time(), healthy=ok,
                    pid=os.getpid(), child_pid=child.pid if child else None, retries=failures))
            except (OSError, ValueError):
                # Disk/network unavailable on wake: retry without touching credentials.
                pass
            time.sleep(5)


def background(args):
    ensure(args.data, args.kind)


def startup(args):
    result = configure_startup(args.data, args.enable, args.kind)
    if args.enable: ensure(args.data, args.kind)
    print(json.dumps(result))
