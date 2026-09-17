"""Read-only live private-tap verification; not a native Homebrew installation."""
import hashlib
import io
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import tempfile
from zipfile import ZipFile

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))


def main():
    origin = json.loads(Path('.relay/hub/network.json').read_text())['public_origin']
    with tempfile.TemporaryDirectory(prefix='brew-qa-', dir=Path('.relay').resolve()) as directory:
        directory = Path(directory)
        clone = directory / 'tap'
        result = subprocess.run(['git', 'clone', '--origin=origin', '--template=',
            '--config', 'core.fsmonitor=false', '--end-of-options',
            origin + '/homebrew/tap.git', str(clone)], capture_output=True, text=True, timeout=30)
        assert result.returncode == 0, result.stderr
        formula = (clone / 'Formula/relay-workspace.rb').read_text()
        url = re.search(r'^  url "([^"]+)"', formula, re.M).group(1)
        digest = re.search(r'^  sha256 "([0-9a-f]+)"', formula, re.M).group(1)
        assert url.startswith(origin + '/homebrew/releases/')
        # Homebrew uses curl for source downloads. Use normal system TLS validation;
        # never add --insecure or disable Git's certificate checks.
        curl = 'curl.exe' if os.name == 'nt' else 'curl'
        result = subprocess.run([curl, '--fail', '--silent', '--show-error', '--max-time', '20', url],
                                capture_output=True, timeout=25)
        assert result.returncode == 0, result.stderr.decode(errors='replace')
        package = result.stdout
        assert hashlib.sha256(package).hexdigest() == digest
        headers = subprocess.run([curl, '--fail', '--silent', '--show-error', '--head', '--max-time', '20', url],
                                 capture_output=True, text=True, timeout=25)
        assert headers.returncode == 0, headers.stderr
        assert int(re.search(r'content-length:\s*(\d+)', headers.stdout, re.I).group(1)) == len(package)
        with ZipFile(io.BytesIO(package)) as archive:
            assert all(name.startswith('relay-workspace/') and '..' not in name for name in archive.namelist())
            archive.extractall(directory / 'release')
        result = subprocess.run([sys.executable, 'relay/launch.py', '--help'],
            cwd=directory / 'release/relay-workspace', capture_output=True, text=True, timeout=15)
        assert result.returncode == 0, result.stderr
        assert 'transfer the understanding' in result.stdout
        report = dict(result='passed', origin=origin, archive_sha256=digest,
                      git_clone_verified=True, https_verified=True, downloader='system-curl', source_cli_verified=True,
                      native_brew_install_tested=False)
        Path('.relay/homebrew-verification.json').write_text(json.dumps(report, indent=2))
        print(json.dumps(report))


if __name__ == '__main__':
    main()
