"""Build a source-only teammate download; never walk the workspace directory."""

from io import BytesIO
from pathlib import Path
from zipfile import ZIP_DEFLATED, ZipFile, ZipInfo


PACKAGE_FILES = (
    '__init__.py', '__main__.py', 'adapters.py', 'client.py',
    'distribution.py', 'discovery.py', 'companion.py', 'join.py', 'homebrew.py', 'install_client.py', 'launch.py', 'live_store.py', 'mcp.py',
    'onboarding.py', 'processes.py', 'integrations.py', 'coordination.py', 'live_coordination.py', 'managed_live.py', 'managed_providers.py', 'managed_tools.py', 'team.py', 'team_tools.py', 'team_cli.py', 'server.py', 'store.py', 'worker.py', 'lifecycle.py', 'reliability.py',
    'automation.py', 'team_integration.py',
    'web/app.js', 'web/index.html', 'web/style.css', 'web/live.css',
    'web/favicon.svg', 'web/companion.html', 'web/companion.js', 'web/companion.css',
)
QUICKSTART = '''Relay workspace client (not the unrelated PyPI package named relay)

Automatic team coding: python -m relay team --url https://YOUR_TEAM_HUB
Confirm the repository, choose an agent and create/join a shared goal.
Relay assigns NEW agents; keep this terminal open. Existing sessions are untouched.
Opt into isolated worktrees and bounded helpers. The goal owner approves exact
test/setup commands before automatic checks and merges to a separate Relay branch.
Commands execute trusted repo code with your OS privileges, not in a sandbox.
No push or merge into your current branch. Use --manual for manual integration.

1. Extract this ZIP into a permanent folder on your own computer.
2. Open a terminal in the extracted relay-workspace folder (containing relay/).
3. Open the browser app:
   python -m relay gui --url https://YOUR_TEAM_HUB
4. Join with an invite link and approve this computer in your workspace browser.
5. Choose your coding agent, Git repository, and conversation in the app.

Requires Python 3.11+, Git, and Codex or Claude Code installed and signed in.
Use python3 if that is your system's Python command. No pip install is needed.
You can close the terminal; syncing runs in the background. Do not start a second hub.
Use Pause or Quit Relay in the app. Reopen Relay after restarting the computer.
Settings offers opt-in login startup. Team workspace > Check team connection
checks that both developers have matching releases and connected agent tools.
Use Enable agent tools in My agent, approve registration, then reconnect your coding client.
Browser conversation sharing is advisory. The separate team command uses guarded
working agents and optional approved automation. /help explains team controls.
This archive contains application source only, not credentials or team context.
'''


def client_archive(package=None):
    package = Path(package) if package is not None else Path(__file__).parent
    output = BytesIO()
    with ZipFile(output, 'w', ZIP_DEFLATED) as archive:
        for name in PACKAGE_FILES:
            source = package / name
            # Do not follow redirected source files or directories outside the package.
            if any(p.is_symlink() for p in (source, *source.parents)):
                raise ValueError('Refusing to bundle symlinked source')
            source.resolve().relative_to(package.resolve())
            archive.writestr(ZipInfo('relay-workspace/relay/' + name), source.read_bytes(), compress_type=ZIP_DEFLATED)
        archive.writestr(ZipInfo('relay-workspace/START_HERE.txt'), QUICKSTART, compress_type=ZIP_DEFLATED)
    return output.getvalue()


def installer_script(origin):
    source = Path(__file__).with_name('install_client.py').read_text(encoding='utf-8')
    source = source.replace('HUB_URL = None', 'HUB_URL = ' + repr(origin))
    source = source.replace('EXPECTED_FILES = ()', 'EXPECTED_FILES = ' + repr(PACKAGE_FILES))
    return source.encode('utf-8')
