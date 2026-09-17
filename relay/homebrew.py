"""Build and expose a source-only private Homebrew tap over read-only Git HTTP."""
import argparse
import hashlib
import json
from pathlib import Path
import re
import subprocess

from .distribution import client_archive
from .install_client import validate_hub

from . import __version__ as VERSION
TAP = 'relay/workspace'
FORMULA = 'relay-workspace'
MARKER = 'Relay managed Homebrew artifacts v1\n'


def formula_text(origin, digest, revision):
    origin = validate_hub(origin)
    # Values are interpolated into Ruby and shell caveats; accept URL characters only.
    if not re.fullmatch(r'https?://[A-Za-z0-9.\-:\[\]]+', origin):
        raise ValueError('Homebrew requires a plain hostname/IP origin.')
    if not re.fullmatch(r'[0-9a-f]{64}', digest):
        raise ValueError('Invalid release checksum')
    return f'''class RelayWorkspace < Formula
  desc "Shared understanding between local coding agent sessions"
  homepage "{origin}"
  url "{origin}/homebrew/releases/{digest}/relay-workspace.zip"
  version "{VERSION}"
  sha256 "{digest}"
  revision {int(revision)}

  depends_on "python@3.13"
  depends_on "git"

  def install
    libexec.install "relay", "START_HERE.txt"
    (bin/"relay-workspace").write <<~EOS
      #!/bin/sh
      exec "#{{Formula["python@3.13"].opt_bin}}/python3.13" "#{{opt_libexec}}/relay/launch.py" "$@"
    EOS
    (bin/"relay-workspace").chmod 0755
    on_macos do
      app = prefix/"Relay.app/Contents"
      (app/"MacOS").mkpath
      (app/"Info.plist").write <<~EOS
        <?xml version="1.0" encoding="UTF-8"?>
        <!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
        <plist version="1.0"><dict>
        <key>CFBundleName</key><string>Relay</string>
        <key>CFBundleIdentifier</key><string>workspace.relay.companion</string>
        <key>CFBundleVersion</key><string>{int(revision) + 1}</string>
        <key>CFBundleShortVersionString</key><string>{VERSION}</string>
        <key>CFBundleExecutable</key><string>Relay</string>
        <key>CFBundlePackageType</key><string>APPL</string>
        <key>LSUIElement</key><true/>
        </dict></plist>
      EOS
      (app/"MacOS/Relay").write <<~EOS
        #!/bin/sh
        exec "#{{opt_bin}}/relay-workspace" gui --url {origin}
      EOS
      (app/"MacOS/Relay").chmod 0755
    end
  end

  def caveats
    <<~EOS
      Keep Tailscale connected and the workspace host running.
      Automatic team coding (keep this terminal open):
        relay-workspace team --url {origin}
      Create or join one shared goal. Relay assigns new agents automatically.
      Existing conversations stay untouched; integration/test acceptance is explicit.
      Open the browser app (the terminal can close after launch):
        relay-workspace gui --url {origin}
      On macOS, open #{{opt_prefix}}/Relay.app in Finder.
      You can drag Relay.app to the Dock for next time.
      For existing-conversation sharing, join with an invite and choose a conversation.
      Codex or Claude Code must be installed and signed in separately.
      Connection state is saved privately in your user application-data folder.
      No workspace token or source conversation is included in this package.
    EOS
  end

  test do
    assert_match "transfer the understanding", shell_output("#{{bin}}/relay-workspace --help")
    assert_match "--url", shell_output("#{{bin}}/relay-workspace start --help")
  end
end
'''


def safe_path(root, relative):
    target = root / relative
    if any(path.is_symlink() for path in (target, *target.parents)):
        raise ValueError('Refusing symlinked Homebrew artifacts')
    target.resolve().relative_to(root.resolve())
    return target


def publish(directory, origin):
    directory = Path(directory)
    root = safe_path(directory, 'homebrew')
    origin = validate_hub(origin)
    archive = client_archive()
    digest = hashlib.sha256(archive).hexdigest()
    manifest_path = safe_path(root, 'manifest.json')
    previous = json.loads(manifest_path.read_text()) if manifest_path.exists() else {}
    revision = previous.get('revision', 0)
    if previous and previous.get('sha256') != digest:
        revision += 1
    formula = formula_text(origin, digest, revision)
    if root.exists():
        marker = safe_path(root, 'MANAGED')
        if not marker.is_file() or marker.read_text() != MARKER:
            raise ValueError('Existing homebrew directory is not managed by Relay')
    else:
        root.mkdir(parents=True)
        (root / 'MANAGED').write_text(MARKER)
    release = safe_path(root, 'releases/' + digest + '.zip')
    release.parent.mkdir(exist_ok=True)
    if release.exists():
        if hashlib.sha256(release.read_bytes()).hexdigest() != digest:
            raise ValueError('Existing immutable Homebrew release is damaged')
    else:
        release.write_bytes(archive)
    tap = safe_path(root, 'tap')
    tap.mkdir(exist_ok=True)
    hooks = safe_path(root, 'empty-hooks')
    hooks.mkdir(exist_ok=True)

    def git(*args, allowed=(0,)):
        result = subprocess.run(['git', '-c', 'core.autocrlf=false', '-c', 'commit.gpgsign=false',
            '-c', 'safe.directory=' + tap.resolve().as_posix(),
            '-c', 'core.hooksPath=' + str(hooks.resolve()),
            '-c', 'user.name=Relay Packaging', '-c', 'user.email=relay@localhost',
            '-C', str(tap), *args], capture_output=True, text=True, encoding='utf-8', timeout=30)
        if result.returncode not in allowed:
            raise ValueError('Homebrew Git packaging failed: ' + result.stderr.strip())
        return result.returncode

    if not (tap / '.git').exists():
        git('init', '--initial-branch=main')
    safe_path(tap, 'Formula').mkdir(exist_ok=True)
    safe_path(tap, 'Formula/relay-workspace.rb').write_text(formula, encoding='utf-8')
    safe_path(tap, 'README.md').write_text(
        '# Relay private Homebrew tap\n\nSource-only package. Requires access to the private hub network.\n\n'
        + 'brew tap relay/workspace ' + origin + '/homebrew/tap.git\n'
        + 'brew install relay/workspace/relay-workspace\n\n'
        + 'relay-workspace start --url ' + origin + '\n', encoding='utf-8')
    git('add', '--', 'Formula/relay-workspace.rb', 'README.md')
    if git('diff', '--cached', '--quiet', allowed=(0, 1)):
        git('commit', '-m', f'Relay {VERSION} revision {revision}')
    git('update-server-info')
    manifest = dict(version=VERSION, revision=revision, sha256=digest, origin=origin,
                    tap_url=origin + '/homebrew/tap.git')
    pending = safe_path(root, 'manifest.pending')
    pending.write_text(json.dumps(manifest, indent=2), encoding='utf-8')
    pending.replace(manifest_path)
    return manifest


def asset(directory, path):
    """Only Git discovery/object files and content-addressed source releases are public."""
    root = Path(directory) / 'homebrew'
    if path == '/homebrew/relay-workspace.rb':
        relative, mime = 'tap/Formula/relay-workspace.rb', 'text/plain; charset=utf-8'
    elif path.startswith('/homebrew/tap.git/'):
        part = path[len('/homebrew/tap.git/'):]
        if part not in {'HEAD', 'info/refs', 'objects/info/packs'} and not re.fullmatch(
                r'objects/(?:[0-9a-f]{2}/[0-9a-f]{38}|pack/pack-[0-9a-f]{40}\.(?:pack|idx))', part):
            return None
        relative, mime = 'tap/.git/' + part, 'application/octet-stream'
    else:
        match = re.fullmatch(r'/homebrew/releases/([0-9a-f]{64})/relay-workspace\.zip', path)
        if not match:
            return None
        relative, mime = 'releases/' + match[1] + '.zip', 'application/zip'
    target = safe_path(root, relative)
    return (target.read_bytes(), mime) if target.is_file() else None


def main():
    parser = argparse.ArgumentParser(description='Publish a source-only Homebrew tap on this private Relay hub')
    parser.add_argument('--data', default='.relay/hub')
    args = parser.parse_args()
    config = json.loads((Path(args.data) / 'network.json').read_text())
    print(json.dumps(publish(args.data, config['public_origin'])))


if __name__ == '__main__':
    main()
