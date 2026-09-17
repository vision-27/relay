"""The only write surface supplied to Relay-managed working agents.

No shell, deletion, git mutations, settings edits or external tools. These guards
protect cooperating managed agents, not against another local process/user.
"""
import hashlib
import json
import os
from pathlib import Path
import re
import stat
import sys
import tempfile
import time
import unicodedata

from .client import git_info, load_config
from .discovery import git_root, same_repository
from .mcp import Connector, TOOLS, TEXT, tool
from .worker import instance_lock

FILE_TOOLS = [
    tool('relay_files', 'List non-secret repository files. Does not follow links or enter nested checkouts.',
         {'folder': TEXT}, [], True),
    tool('relay_read_file', 'Read one UTF-8 file and its sha256, or report missing. Paths are relative to this confirmed repository.',
         {'path': TEXT}, ['path'], True),
    tool('relay_write_file', 'Create/replace one UTF-8 file only after a started peer-reviewed plan and a fresh live coordination check. Supply the sha256 from read_file, or missing for a new file. Preserves a private backup. No deletion or settings edits.',
         {'path': TEXT, 'content': TEXT, 'expected_sha256': TEXT}, ['path', 'content', 'expected_sha256'])]
MANAGED_TOOLS = [{**t, **({'description': 'Send an attributed message or implementation question about a work plan. Enrolled live peers receive it automatically in their working session; ordinary connectors still poll. A message is not permission to expand a task.'}
                        if t['name'] == 'relay_work_message' else {})} for t in TOOLS] + FILE_TOOLS
PROTECTED = {'.git', '.codex', '.claude', '.relay', '.agents', '.ssh', '.aws', '.azure', '.venv', 'node_modules', '__pycache__'}


def tools_for_config(config):
    from .team_tools import config_tools
    return config_tools(config, MANAGED_TOOLS, FILE_TOOLS)


def linked(path):
    if not path.exists() and not path.is_symlink():
        return False
    info = path.lstat()
    return stat.S_ISLNK(info.st_mode) or bool(getattr(info, 'st_file_attributes', 0) & 0x400)


def safe_file(root, value, folder=False):
    if not isinstance(value, str) or len(value) > 500:
        raise ValueError('Use a repository-relative path')
    parts = value.replace('\\', '/').split('/')
    if value == '.' and folder:
        return root
    if any(p in {'', '.', '..'} or p.rstrip(' .') != p or ':' in p or any(ord(c) < 32 for c in p) for p in parts):
        raise ValueError('Unsafe repository-relative path')
    for p in parts:
        low = p.casefold()
        if (low in PROTECTED or low.startswith('.env') or low in {'.netrc', '.npmrc', '.pypirc', 'id_rsa', 'id_ed25519', 'credentials.json', 'secrets.json'}
                or re.search(r'\.(?:pem|key|p12|pfx)$', low)):
            raise ValueError('Secrets, agent settings and internal directories are unavailable in managed mode')
    target = root
    for part in parts:
        target = target / part
        if linked(target) or (target.is_dir() and (target / '.git').exists()):
            raise ValueError('Links and nested repositories are not allowed')
    target.resolve().relative_to(root)
    if target.exists() and not folder and (not target.is_file() or target.stat().st_nlink != 1):
        raise ValueError('Only regular non-linked files are supported')
    return target


class ManagedTools:
    def __init__(self, config_path):
        self.path = Path(config_path).resolve()
        self.config, self.client = load_config(self.path)
        if self.config.get('managed_live') is not True or not self.config.get('live_instance'):
            raise ValueError('Not a Relay-created managed working session')
        self.root = Path(self.config['repo']).resolve()
        self.connector = Connector(self.config, self.client)
        self.generation = None
        self.calls = 0

    def control(self):
        state = json.loads(self.path.with_name('control.json').read_text(encoding='utf-8'))
        if (state.get('instance') != self.config['live_instance'] or not state.get('active')
                or not state.get('network_ok') or time.time() - state.get('seen', 0) > 20):
            raise ValueError('Live work is paused, offline or no longer controlled. No operation was performed.')
        if not same_repository(git_root(self.root), self.root):
            raise ValueError('Repository root changed; stop and start a new live session')
        if state.get('generation') != self.generation:
            self.generation, self.calls = state.get('generation'), 0
        self.calls += 1
        if self.calls > 60:
            raise ValueError('Managed tool-call limit reached for this turn; ask the developer to continue')
        return state

    def call(self, name, args):
        self.control()
        spec = next((t for t in tools_for_config(self.config) if t['name'] == name), None)
        if not spec or not isinstance(args, dict):
            raise ValueError('Unknown managed tool')
        schema = spec['inputSchema']
        if set(args) - set(schema['properties']) or any(k not in args for k in schema['required']):
            raise ValueError('Invalid managed tool arguments')
        if name.startswith('relay_team_'):
            from .team_tools import call
            return call(self, name, args)
        if name not in {t['name'] for t in FILE_TOOLS}:
            return self.connector.call(name, args)
        if any(not isinstance(v, str) for v in args.values()):
            raise ValueError('File arguments must be text')
        if name == 'relay_files':
            directory = safe_file(self.root, args.get('folder', '.'), folder=True)
            entries = []
            for path in sorted(directory.iterdir()):
                try:
                    safe_file(self.root, path.relative_to(self.root).as_posix(), folder=path.is_dir())
                except (ValueError, OSError):
                    continue
                entries.append({'path': path.relative_to(self.root).as_posix(), 'directory': path.is_dir()})
                if len(entries) >= 500:
                    break
            return {'entries': entries, 'limit': 500}
        path = safe_file(self.root, args['path'])
        if path.exists() and path.stat().st_size > 256000:
            raise ValueError('Managed file size limit is 256 KB')
        original = path.read_bytes() if path.exists() else None
        digest = hashlib.sha256(original).hexdigest() if original is not None else 'missing'
        if name == 'relay_read_file':
            return {'path': args['path'], 'sha256': digest, 'content': original.decode('utf-8') if original is not None else None}
        content = args['content'].encode('utf-8')
        if len(content) > 256000:
            raise ValueError('Managed file size limit is 256 KB')
        # Serialize cooperating writers in this checkout; never hold an open
        # target descriptor across network authorization or atomic replacement.
        with instance_lock(self.path.parent.parent / (hashlib.sha256(str(self.root).encode()).hexdigest() + '.json')):
            self.control()
            path = safe_file(self.root, args['path'])
            current = path.read_bytes() if path.exists() else None
            current_digest = hashlib.sha256(current).hexdigest() if current is not None else 'missing'
            if current_digest != args['expected_sha256']:
                raise ValueError('File changed since it was read. Read it again; nothing was overwritten.')
            result = self.client.action('live-gate', dict(session_id=self.config['session_id'],
                instance=self.config['live_instance'], path=unicodedata.normalize('NFC', args['path']),
                base_commit=git_info(self.root)['commit_sha']))
            if not result.get('proceed'):
                raise ValueError('Edit paused for coordination: ' + json.dumps(result.get('blockers', [])))
            self.control()
            path = safe_file(self.root, args['path'])
            if (path.read_bytes() if path.exists() else None) != current:
                raise ValueError('File changed during the coordination check. Read it again.')
            if current is not None:
                backup = self.path.parent / 'backups'
                backup.mkdir(exist_ok=True)
                saved = backup / (str(time.time_ns()) + '-' + current_digest)
                saved.write_bytes(current)
                saved.chmod(0o600)
            path.parent.mkdir(parents=True, exist_ok=True)
            safe_file(self.root, args['path'])
            fd, temporary = tempfile.mkstemp(prefix='.relay-write-', dir=path.parent)
            try:
                with os.fdopen(fd, 'wb') as stream:
                    stream.write(content)
                    stream.flush()
                    os.fsync(stream.fileno())
                if path.exists():
                    os.chmod(temporary, stat.S_IMODE(path.stat().st_mode))
                os.replace(temporary, path)
                if result.get('task_id'):
                    from .team_tools import record_write
                    record_write(self, result['task_id'], args['path'], content, current)
            finally:
                if os.path.exists(temporary):
                    os.unlink(temporary)
        return {'written': args['path'], 'sha256': hashlib.sha256(content).hexdigest(), 'backup_saved': current is not None,
                'scope': 'One guarded write; external editors/processes are not intercepted.'}


def serve(args):
    managed = ManagedTools(args.config)
    for line in sys.stdin:
        request = None
        try:
            request = json.loads(line)
            if 'id' not in request:
                continue
            method = request.get('method')
            if method == 'initialize':
                result = {'protocolVersion': '2025-06-18', 'capabilities': {'tools': {}},
                          'serverInfo': {'name': 'relay-managed', 'version': '0.4.0'}}
            elif method == 'tools/list':
                result = {'tools': tools_for_config(managed.config)}
            elif method == 'ping':
                result = {}
            elif method == 'tools/call':
                try:
                    value = managed.call(request['params']['name'], request['params'].get('arguments', {}))
                    result = {'content': [{'type': 'text', 'text': json.dumps(value)}]}
                except (ValueError, OSError, TimeoutError) as exc:
                    result = {'isError': True, 'content': [{'type': 'text', 'text': str(exc)}]}
            else:
                raise ValueError('Unsupported MCP method')
            response = {'jsonrpc': '2.0', 'id': request['id'], 'result': result}
        except (ValueError, KeyError, TypeError):
            response = {'jsonrpc': '2.0', 'id': request.get('id') if isinstance(request, dict) else None,
                        'error': {'code': -32600, 'message': 'Invalid request'}}
        print(json.dumps(response), flush=True)
