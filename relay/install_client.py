"""Private-hub bootstrap. Served with a fixed hub URL and source allowlist."""
import hashlib
import io
import os
from pathlib import Path
import runpy
import stat
import sys
import tempfile
from urllib.error import HTTPError, URLError
from urllib.parse import urlsplit
from urllib.request import HTTPRedirectHandler, Request, build_opener
from zipfile import BadZipFile, ZipFile

HUB_URL = None
EXPECTED_FILES = ()
MAX_ARCHIVE = 4 * 1024 * 1024
MAX_EXPANDED = 12 * 1024 * 1024


class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        return None


def validate_hub(url):
    parsed = urlsplit(url)
    if (parsed.scheme != 'https' and not
            (parsed.scheme == 'http' and parsed.hostname in {'localhost', '127.0.0.1', '::1'})):
        raise ValueError('Relay installation requires HTTPS (or loopback for local testing).')
    if not parsed.hostname or parsed.username or parsed.password or parsed.query or parsed.fragment or parsed.path not in {'', '/'}:
        raise ValueError('Use an exact workspace origin without credentials or a path.')
    return url.rstrip('/')


def unpack_verified(payload, expected_files, destination):
    expected = {'relay-workspace/relay/' + name for name in expected_files}
    expected.add('relay-workspace/START_HERE.txt')
    try:
        opened = ZipFile(io.BytesIO(payload))
    except BadZipFile:
        raise ValueError('Invalid Relay ZIP download.') from None
    with opened as archive:
        infos = archive.infolist()
        if len(infos) != len(expected) or {item.filename for item in infos} != expected:
            raise ValueError('Unexpected files in Relay download; installation stopped.')
        if sum(item.file_size for item in infos) > MAX_EXPANDED:
            raise ValueError('Relay download expands beyond its size limit.')
        if any(stat.S_ISLNK(item.external_attr >> 16) for item in infos):
            raise ValueError('Symlinks are not permitted in Relay downloads.')
        # Read all entries (including CRC validation) before writing any source.
        contents = [(item.filename, archive.read(item)) for item in infos]
    for name, content in contents:
        target = destination / name
        target.resolve().relative_to(destination.resolve())
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(content)


def user_directory(hub):
    if os.name == 'nt':
        base = Path(os.environ.get('LOCALAPPDATA', str(Path.home() / 'AppData/Local')))
    elif sys.platform == 'darwin':
        base = Path.home() / 'Library/Application Support'
    else:
        base = Path(os.environ.get('XDG_DATA_HOME', str(Path.home() / '.local/share')))
    return base / 'Relay/workspaces' / hashlib.sha256(hub.encode()).hexdigest()[:16]


def install(hub, token, expected_files, directory=None):
    hub = validate_hub(hub)
    if token and ('\r' in token or '\n' in token):
        raise ValueError('Enter a valid workspace token.')
    request = Request(hub + ('/api/download/relay-client.zip' if token else '/client.zip'),
                      headers={'Authorization': 'Bearer ' + token} if token else {})
    try:
        with build_opener(NoRedirect).open(request, timeout=30) as response:
            if response.headers.get_content_type() != 'application/zip':
                raise ValueError('The workspace did not return a Relay package.')
            expected_hash = response.headers.get('X-Relay-Archive-SHA256', '')
            payload = response.read(MAX_ARCHIVE + 1)
    except HTTPError as error:
        if error.code in {401, 403}:
            raise ValueError('Workspace rejected the token. Use your current personal Relay token.') from None
        raise ValueError(f'Workspace download failed (HTTP {error.code}); no redirect was followed.') from None
    except URLError:
        raise ValueError('Cannot reach Relay. Check Tailscale and that the host PC is running.') from None
    if len(payload) > MAX_ARCHIVE:
        raise ValueError('Relay download exceeds its size limit.')
    digest = hashlib.sha256(payload).hexdigest()
    if digest != expected_hash:
        raise ValueError('Relay download checksum mismatch; installation stopped.')
    directory = Path(directory) if directory is not None else user_directory(hub)
    if any(p.is_symlink() for p in (directory, *directory.parents)):
        raise ValueError('Refusing to install through a symlink.')
    directory.mkdir(parents=True, exist_ok=True)
    releases = directory / 'releases'
    if releases.is_symlink():
        raise ValueError('Refusing a symlinked releases directory.')
    releases.mkdir(exist_ok=True)
    # A new immutable release per install preserves earlier installs and all state.
    release = Path(tempfile.mkdtemp(prefix=digest[:12] + '-', dir=releases))
    unpack_verified(payload, expected_files, release)
    package_root = release / 'relay-workspace'
    launcher = directory / 'start.py'
    if launcher.exists() or launcher.is_symlink():
        if launcher.is_symlink() or not launcher.read_text(encoding='utf-8').startswith('# Relay managed launcher\n'):
            raise ValueError('Existing start.py is not a Relay launcher; refusing to overwrite it.')
    source = f'''# Relay managed launcher
import os
from pathlib import Path
import sys
from types import SimpleNamespace

def main(token=None):
    os.chdir(Path(__file__).resolve().parent)
    sys.path.insert(0, {str(package_root)!r})
    from relay.companion import launch
    launch(SimpleNamespace(url={hub!r}, data=None))

if __name__ == '__main__':
    try:
        main()
    except (KeyboardInterrupt, EOFError):
        print('Stopped. Run this launcher again to reconnect.')
    except (ValueError, OSError) as error:
        print('Relay: ' + str(error), file=sys.stderr)
        raise SystemExit(1)
'''
    pending = release / 'start.py.pending'
    pending.write_text(source, encoding='utf-8')
    pending.replace(launcher)
    return launcher


def main():
    if sys.version_info < (3, 11):
        raise ValueError('Install Python 3.11 or newer, then run this command again.')
    hub = validate_hub(HUB_URL)
    print('Relay - install your local connector\nWorkspace: ' + hub)
    print('This installs Relay for your user only. No pip packages or agent settings are changed.')
    launcher = install(hub, None, EXPECTED_FILES)
    print('Installed. Next time, run:')
    # Double quotes work in PowerShell, cmd, and POSIX shells for ordinary paths.
    if os.name == 'nt':
        print('& ' + "'" + sys.executable.replace("'", "''") + "' '" + str(launcher).replace("'", "''") + "'")
    else:
        import shlex
        print(shlex.join([sys.executable, str(launcher)]))
    runpy.run_path(str(launcher))['main']()


if __name__ == '__main__':
    try:
        main()
    except (KeyboardInterrupt, EOFError):
        print('\nStopped. Run the install command again when ready.')
    except (ValueError, OSError) as error:
        print('Relay: ' + str(error), file=sys.stderr)
        raise SystemExit(1)
