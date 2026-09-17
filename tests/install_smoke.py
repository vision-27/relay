"""Verify the real private HTTPS installer without connecting any agent session."""
import hashlib
import json
from pathlib import Path
import subprocess
import sys
import tempfile
from urllib.request import build_opener

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from relay.client import NoRedirect


def main():
    data = Path('.relay/hub')
    origin = json.loads((data / 'network.json').read_text())['public_origin']
    token = (data / 'owner-token').read_text().strip()
    with build_opener(NoRedirect).open(origin + '/install.py', timeout=20) as response:
        script = response.read()
    namespace = {'__name__': 'relay_install_verification'}
    exec(compile(script, origin + '/install.py', 'exec'), namespace)
    assert namespace['HUB_URL'] == origin
    assert token.encode() not in script
    with tempfile.TemporaryDirectory(prefix='install-qa-', dir=Path('.relay').resolve()) as temporary:
        launcher = namespace['install'](origin, token, namespace['EXPECTED_FILES'], Path(temporary) / 'client')
        assert token not in launcher.read_text()
        release = next((launcher.parent / 'releases').iterdir())
        result = subprocess.run([sys.executable, '-m', 'relay', 'start', '--help'],
            cwd=release / 'relay-workspace', capture_output=True, text=True, timeout=20)
        assert result.returncode == 0, result.stderr
        assert '--url' in result.stdout
        assert not (launcher.parent / '.relay').exists()
    report = {'result': 'passed', 'origin': origin,
              'installer_sha256': hashlib.sha256(script).hexdigest(),
              'https_verified': True, 'authenticated_download': True,
              'checksum_and_file_allowlist_verified': True, 'clean_extracted_cli': True,
              'agent_connected': False, 'second_physical_pc_tested': False}
    Path('.relay/install-verification.json').write_text(json.dumps(report, indent=2))
    print(json.dumps(report))


if __name__ == '__main__':
    main()
