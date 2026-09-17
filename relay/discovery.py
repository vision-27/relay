"""Local-only project/session metadata and checkout identity checks."""
import json
import os
from pathlib import Path
import re
import subprocess
from .processes import background_options


def git_root(path):
    path = Path(path).expanduser()
    if not path.is_dir():
        return None
    try:
        result = subprocess.run(['git', '-C', str(path), 'rev-parse', '--show-toplevel'],
            capture_output=True, text=True, encoding='utf-8', errors='replace', timeout=8, **background_options())
        return str(Path(result.stdout.strip()).resolve()) if result.returncode == 0 else None
    except (OSError, subprocess.TimeoutExpired):
        return None


def same_directory(left, right):
    try:
        return os.path.samefile(left, right)
    except OSError:
        return os.path.normcase(str(Path(left).resolve())) == os.path.normcase(str(Path(right).resolve()))


def same_repository(recorded, selected):
    if not isinstance(recorded, str) or not Path(recorded).is_absolute():
        return False
    if same_directory(recorded, selected):
        return True
    left, right = git_root(recorded), git_root(selected)
    # Exact checkout roots: never equate separate worktrees or nested repositories.
    return bool(left and right and same_directory(left, right))


def claude_base():
    return Path(os.environ.get('CLAUDE_CONFIG_DIR', str(Path.home() / '.claude'))) / 'projects'


def metadata(path, title=False):
    """Bounded local preview; never returns raw transcript records."""
    result = {'id': path.stem, 'source_file': str(path), 'modified': path.stat().st_mtime,
              'name': '', 'cwd': ''}
    with path.open(encoding='utf-8') as stream:
        for _ in range(100):
            line = stream.readline(128 * 1024)
            if not line or not line.endswith('\n'):
                break
            try:
                row = json.loads(line)
            except ValueError:
                continue
            if not isinstance(row, dict) or row.get('sessionId') != path.stem:
                continue
            if isinstance(row.get('cwd'), str):
                result['cwd'] = row['cwd']
            if not title:
                if result['cwd']:
                    break
                continue
            from .adapters import redact
            if isinstance(row.get('customTitle'), str):
                result['name'] = redact(row['customTitle'])[:100]
                break
            if not result['name'] and row.get('type') == 'user':
                message = row.get('message')
                content = message.get('content', '') if isinstance(message, dict) else ''
                text = content if isinstance(content, str) else ' '.join(
                    block['text'] for block in content if isinstance(block, dict) and block.get('type') == 'text' and isinstance(block.get('text'), str)) if isinstance(content, list) else ''
                text = ' '.join(text.split())
                if text and not text.startswith(('<', '/')):
                    result['name'] = redact(text)[:100]
    return result


def repositories(current=None, base=None):
    """Discover cwd metadata only; session previews require a chosen repository."""
    found = {}
    root = git_root(current or Path.cwd())
    if root:
        found[root] = {'path': root, 'name': Path(root).name}
    base = Path(base) if base is not None else claude_base()
    if base.is_dir():
        folders = sorted((p for p in base.iterdir() if p.is_dir()), key=lambda p:p.stat().st_mtime, reverse=True)[:40]
        for folder in folders:
            paths = sorted(folder.glob('*.jsonl'), key=lambda p:p.stat().st_mtime, reverse=True)[:2]
            for path in paths:
                try:
                    cwd = metadata(path).get('cwd')
                    root = git_root(cwd) if cwd else None
                    if root:
                        found[root] = {'path': root, 'name': Path(root).name}
                except (OSError, ValueError):
                    continue
    return list(found.values())


def claude_sessions(repo):
    folder = claude_base() / re.sub(r'[^a-zA-Z0-9]', '-', str(Path(repo).resolve()))
    if not folder.is_dir():
        return []
    result = []
    for path in sorted(folder.glob('*.jsonl'), key=lambda p:p.stat().st_mtime, reverse=True)[:50]:
        try:
            item = metadata(path, title=True)
            item['name'] = item['name'] or 'Untitled Claude conversation'
            item['compatible'] = not item['cwd'] or same_repository(item['cwd'], repo)
            item['reason'] = '' if item['compatible'] else 'Recorded in another checkout: ' + item['cwd']
            result.append(item)
        except (OSError, ValueError):
            continue
    return result
