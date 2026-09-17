"""Explicit, local-only registration of this connection's agent tools."""
import json
from pathlib import Path
import shutil
import subprocess

from .onboarding import integration_command
from .processes import background_options
from .worker import atomic_json


def register(path, config):
    marker = Path(path).with_suffix('.tools.json')
    if marker.exists():
        return {'configured': True, 'message': 'Already registered by Relay. Reconnect your coding client to load its tools.'}
    command = integration_command(path, config)
    executable = shutil.which(command[0])
    if not executable:
        raise ValueError('Install ' + command[0] + ' on this computer first, then reopen Relay.')
    command[0] = executable
    name = 'relay-' + config['session_id'][:8]
    # Codex add can replace an existing name. Inspect that exact entry first;
    # never replace an unrelated server or change any approval settings.
    if config['provider'] == 'codex':
        existing = subprocess.run([executable, 'mcp', 'get', name, '--json'], cwd=config['repo'],
            stdin=subprocess.DEVNULL, capture_output=True, text=True, encoding='utf-8', timeout=15, **background_options())
        if existing.returncode == 0:
            saved = json.loads(existing.stdout).get('transport', {})
            expected = command[command.index('--')+1:]
            if saved.get('command') != expected[0] or saved.get('args') != expected[1:]:
                raise ValueError('An existing agent tool uses this name. Nothing was replaced; review your agent settings.')
            atomic_json(marker, {'name': name, 'provider': config['provider']})
            return {'configured': True, 'message': 'Matching tools already registered. Reconnect your coding client.'}
        message = (existing.stderr + existing.stdout).lower()
        if 'not found' not in message and ("no mcp server named '" + name + "' found.") not in message:
            raise ValueError('Could not safely inspect agent settings. Nothing was changed; check the coding client.')
    result = subprocess.run(command, cwd=config['repo'], stdin=subprocess.DEVNULL,
        capture_output=True, text=True, encoding='utf-8', timeout=20, **background_options())
    if result.returncode:
        # Do not return CLI output: it can include unrelated settings or secrets.
        raise ValueError('Agent tools could not be registered. An existing entry or client configuration may need attention; nothing was removed.')
    atomic_json(marker, {'name': name, 'provider': config['provider']})
    return {'configured': True, 'message': 'Tools registered. Reconnect your coding client, then check /mcp. Normal tool approvals still apply.'}
