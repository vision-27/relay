import hashlib
import io
import os
from pathlib import Path
import runpy
import subprocess
import sys
import unittest
from unittest.mock import patch
from urllib.error import HTTPError
from urllib.request import urlopen
from zipfile import ZipFile

import test_relay
from relay.distribution import PACKAGE_FILES, client_archive
from relay.install_client import install, unpack_verified, validate_hub


class InstallTests(unittest.TestCase):
    setUp = test_relay.RelayIntegrationTests.setUp
    tearDown = test_relay.RelayIntegrationTests.tearDown

    def test_bootstrap_and_authenticated_install_from_clean_directory(self):
        with urlopen(self.url + '/install.py') as response:
            script = response.read()
        self.assertNotIn(self.token.encode(), script)
        self.assertNotIn(self.bob_token.encode(), script)
        source = self.directory / 'installer.py'
        source.write_bytes(script)
        bootstrap = runpy.run_path(str(source))
        self.assertEqual(bootstrap['HUB_URL'], self.url)
        self.assertEqual(bootstrap['EXPECTED_FILES'], PACKAGE_FILES)
        destination = self.directory / 'installed'
        launcher = bootstrap['install'](self.url, self.bob_token, PACKAGE_FILES, destination)
        self.assertNotIn(self.bob_token, launcher.read_text())
        release = next((destination / 'releases').iterdir())
        result = subprocess.run([sys.executable, '-m', 'relay', 'start', '--help'],
            cwd=release / 'relay-workspace', capture_output=True, text=True, timeout=15)
        self.assertEqual(result.returncode, 0, result.stderr)
        # Invoke the actual launcher without opening browsers or leaking test services.
        previous = Path.cwd()
        try:
            with patch('relay.companion.launch') as launch:
                runpy.run_path(str(launcher))['main']()
                self.assertEqual(launch.call_args.args[0].url, self.url)
        finally:
            os.chdir(previous)

    def test_public_source_install_needs_no_token(self):
        launcher = install(self.url, None, PACKAGE_FILES, self.directory / 'public-install')
        self.assertIn('relay.companion import launch', launcher.read_text())

    def test_install_preserves_private_state_and_previous_release(self):
        destination = self.directory / 'installed'
        install(self.url, self.bob_token, PACKAGE_FILES, destination)
        state = destination / '.relay/keep.json'
        state.parent.mkdir()
        state.write_text('keep')
        install(self.url, self.bob_token, PACKAGE_FILES, destination)
        self.assertEqual(state.read_text(), 'keep')
        self.assertEqual(len(list((destination / 'releases').iterdir())), 2)

    def test_invalid_token_does_not_install(self):
        destination = self.directory / 'not-installed'
        with self.assertRaisesRegex(ValueError, 'rejected the token'):
            install(self.url, 'invalid', PACKAGE_FILES, destination)
        self.assertFalse(destination.exists())

    def test_archive_deterministic_and_rejects_unexpected_paths(self):
        self.assertEqual(hashlib.sha256(client_archive()).digest(), hashlib.sha256(client_archive()).digest())
        payload = io.BytesIO()
        with ZipFile(payload, 'w') as archive:
            archive.writestr('../escape', 'bad')
        with self.assertRaisesRegex(ValueError, 'Unexpected files'):
            unpack_verified(payload.getvalue(), PACKAGE_FILES, self.directory / 'unpack')
        self.assertFalse((self.directory / 'unpack').exists())

    def test_remote_plaintext_and_credential_urls_rejected(self):
        for url in ('http://remote.example', 'https://user:token@example.com', 'https://example.com/?token=secret'):
            with self.assertRaises(ValueError):
                validate_hub(url)

    def test_workspace_origin_and_public_bootstrap_do_not_expose_state(self):
        self.server.public_origin = 'https://private.example'
        self.assertEqual(self.alice.request('/api/state')['workspace_url'], 'https://private.example')
        with urlopen(self.url + '/install.py') as response:
            self.assertIn(b"HUB_URL = 'https://private.example'", response.read())
        with self.assertRaises(HTTPError) as caught:
            urlopen(self.url + '/api/download/relay-client.zip')
        self.assertEqual(caught.exception.code, 401)
