"""Build identity and evidence-based two-person connection checks (no model calls)."""
from functools import lru_cache
import hashlib
from io import BytesIO
from pathlib import Path
import platform
import re
import time
from zipfile import ZipFile

from . import __version__


@lru_cache(maxsize=1)
def release_info():
    from .distribution import client_archive
    # Homebrew's stable opt path is a symlink to its versioned Cellar install.
    # Resolve the installation root; client_archive still rejects redirected
    # files inside that root and only bundles its explicit source allowlist.
    package = Path(__file__).resolve().parent
    return dict(version=__version__, build=build_identity(client_archive(package)), platform=platform.system())


def build_identity(payload):
    # Hash source bytes, not compressed bytes: Python/zlib versions may differ
    # across PCs even when the exact same release has been installed.
    digest = hashlib.sha256()
    with ZipFile(BytesIO(payload)) as archive:
        for name in sorted(archive.namelist()):
            data = archive.read(name)
            digest.update(name.encode('utf-8') + b'\0' + len(data).to_bytes(8, 'big') + data)
    return digest.hexdigest()


def report_client(db, sid, role, data, now):
    release = data.get('release', {})
    if not isinstance(release, dict): release = {}
    build = release.get('build', '')
    if not isinstance(build, str) or not re.fullmatch('[0-9a-f]{64}', build): build = ''
    version = release.get('version', '')
    if not isinstance(version, str) or not re.fullmatch(r'[0-9]+\.[0-9]+\.[0-9]+', version): version = ''
    system = release.get('platform', '')
    if system not in {'Windows', 'Darwin', 'Linux'}: system = ''
    db.execute('INSERT OR REPLACE INTO client_status(session_id,role,version,build,platform,seen) VALUES(?,?,?,?,?,?)',
               (sid, role, version, build, system, now))


def team_check(state, project_id, local_release=None):
    local_release = local_release or release_info()
    now = state.get('server_time', time.time())
    clients = {(c['session_id'], c['role']): c for c in state.get('clients', [])}
    rows = []
    for binding in state.get('bindings', []):
        if binding['project_id'] != project_id: continue
        session = next((s for s in state['sessions'] if s['id'] == binding['session_id']), None)
        if not session: continue  # Revoked developers are not ready participants.
        worker = clients.get((session['id'], 'worker'), {})
        agent = clients.get((session['id'], 'agent'), {})
        feature = next((f for f in state['features'] if f['id'] == binding['feature_id']), {})
        problems = []
        if not binding['enabled']: problems.append('Sharing is paused')
        if not binding['worker_online']: problems.append('Sharing worker is offline')
        if binding.get('error'): problems.append('Sharing worker needs attention')
        if worker.get('build') != local_release['build']: problems.append('Update/reopen Relay on this computer')
        if not session.get('agent_online'): problems.append('Coding agent is not connected')
        if not session.get('agent_tool_used'): problems.append('Ask the coding agent to read Relay team context')
        if agent.get('build') != local_release['build']: problems.append('Reconnect coding-client Relay tools after updating')
        if feature.get('checkpoint', {}).get('origin') != 'agent-derived': problems.append('Waiting for the first context summary')
        rows.append(dict(session_id=session['id'], member_id=session['member_id'], owner=session['owner'],
            name=session['name'], provider=binding['provider'], feature_id=binding['feature_id'],
            worker_version=worker.get('version') or 'unknown', agent_version=agent.get('version') or 'unknown',
            build_matches=worker.get('build') == local_release['build'], problems=problems,
            context_updated=feature.get('updated'), worker_seen=binding['worker_seen'],
            ready=not problems))
    ready_members = {row['member_id'] for row in rows if row['ready']}
    hub_matches = state.get('release', {}).get('build') == local_release['build']
    return dict(ready=len(ready_members) >= 2 and hub_matches, participants=rows, checked_at=now,
        release=local_release, hub_matches=hub_matches,
        scope='Connection readiness only. This does not verify matching repositories, context accuracy, or completed two-PC acceptance.',
        next_step='Both developers must use the same project, then test a clarification in each direction.')
