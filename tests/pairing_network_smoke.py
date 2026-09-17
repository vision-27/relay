"""Verify anonymous pairing over the private HTTPS proxy, without granting access."""
import json
from pathlib import Path
import shutil
import subprocess


def main():
    origin = json.loads(Path('.relay/hub/network.json').read_text())['public_origin']
    curl = shutil.which('curl.exe') or shutil.which('curl')
    if not curl:
        raise SystemExit('A TLS-verifying curl is required for this network check.')

    def post(path, data, headers):
        command = [curl, '--silent', '--show-error', '--max-time', '15', '--request', 'POST',
                   '--header', 'Content-Type: application/json', '--data-binary', '@-',
                   '--write-out', '\n%{http_code}']
        for header in headers:
            command += ['--header', header]
        result = subprocess.run(command + [origin + path], input=json.dumps(data),
                                capture_output=True, text=True, timeout=20)
        if result.returncode:
            raise RuntimeError('HTTPS check failed: ' + result.stderr)
        body, status = result.stdout.rsplit('\n', 1)
        return int(status), json.loads(body)

    checks = []
    for label, headers in [('legacy_proxy_trimmed', ['Authorization: Bearer']),
                           ('explicit_client_header', ['X-Relay-Client: web'])]:
        status, pair = post('/api/pair/start', {'machine': 'Relay protocol QA'}, headers)
        assert status == 200, (label, status, pair.get('error'))
        status, result = post('/api/pair/poll', {'device_secret': pair['device_secret']}, headers)
        assert status == 200 and result == {'status': 'pending'}
        checks += [label + '_start', label + '_poll_requires_approval']
    for label, path, headers in [
            ('foreign_origin_blocked', '/api/pair/start', ['Authorization: Bearer', 'Origin: https://untrusted.invalid']),
            ('missing_header_blocked', '/api/pair/start', []),
            ('approval_not_exempt', '/api/pair/approve', ['Authorization: Bearer']),
            ('login_not_exempt', '/api/login', ['Authorization: Bearer'])]:
        status, _ = post(path, {}, headers)
        assert status == 403, (label, status)
        checks.append(label)
    report = {'passed': True, 'checks': checks, 'https_verified': True,
              'access_granted': False, 'conversations_shared': False}
    Path('.relay/pairing-network-verification.json').write_text(json.dumps(report, indent=2))
    print(json.dumps(report))


if __name__ == '__main__':
    main()
