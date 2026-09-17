import hashlib
import io
import re
import subprocess
import sys
import unittest
from urllib.error import HTTPError
from urllib.request import Request, urlopen
from zipfile import ZipFile

import test_relay
from relay.homebrew import asset, formula_text, publish


class HomebrewTests(unittest.TestCase):
    setUp = test_relay.RelayIntegrationTests.setUp
    tearDown = test_relay.RelayIntegrationTests.tearDown

    def test_private_tap_clones_and_release_checksum_matches(self):
        manifest = publish(self.store.directory, self.url)
        clone = self.directory / 'tap-clone'
        result = subprocess.run(['git', 'clone', '--origin=origin', '--template=',
            '--config', 'core.fsmonitor=false', '--end-of-options', manifest['tap_url'], str(clone)],
            capture_output=True, text=True, timeout=20)
        self.assertEqual(result.returncode, 0, result.stderr)
        formula = (clone / 'Formula/relay-workspace.rb').read_text()
        self.assertIn('depends_on "python@3.13"', formula)
        self.assertIn('depends_on "git"', formula)
        self.assertIn(manifest['sha256'], formula)
        url = re.search(r'^  url "([^"]+)"', formula, re.M).group(1)
        with urlopen(url) as response:
            package = response.read()
        with urlopen(Request(url, method='HEAD')) as response:
            self.assertEqual(int(response.headers['Content-Length']), len(package))
            self.assertEqual(response.read(), b'')
        self.assertEqual(hashlib.sha256(package).hexdigest(), manifest['sha256'])
        with ZipFile(io.BytesIO(package)) as archive:
            for name in archive.namelist():
                self.assertNotIn(self.token.encode(), archive.read(name))
                self.assertNotIn(self.bob_token.encode(), archive.read(name))
            archive.extractall(self.directory / 'brew-stage')
        result = subprocess.run([sys.executable, 'relay/launch.py', '--help'],
            cwd=self.directory / 'brew-stage/relay-workspace', capture_output=True, text=True, timeout=15)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn('transfer the understanding', result.stdout)
        self.assertEqual(publish(self.store.directory, self.url), manifest)

    def test_git_config_workspace_secrets_and_traversal_not_served(self):
        publish(self.store.directory, self.url)
        for path in ('/homebrew/tap.git/config', '/homebrew/tap.git/hooks/pre-commit',
                     '/homebrew/tap.git/../../owner-token', '/homebrew/../owner-token',
                     '/homebrew/tap.git/objects/../../config', '/homebrew/tap.git/%2e%2e/config'):
            self.assertIsNone(asset(self.store.directory, path))
            with self.assertRaises(HTTPError) as caught:
                urlopen(self.url + path)
            self.assertEqual(caught.exception.code, 404)
        with self.assertRaises(HTTPError) as caught:
            urlopen(self.url + '/api/state')
        self.assertEqual(caught.exception.code, 401)

    def test_formula_rejects_interpolation_and_invalid_checksum(self):
        for origin, digest in [("https://host'evil", 'a'*64), ('https://host', '#{bad}')]:
            with self.assertRaises(ValueError):
                formula_text(origin, digest, 0)

    def test_unmanaged_artifact_folder_not_overwritten(self):
        root = self.store.directory / 'homebrew'
        root.mkdir()
        existing = root / 'keep.txt'
        existing.write_text('user file')
        with self.assertRaisesRegex(ValueError, 'not managed'):
            publish(self.store.directory, self.url)
        self.assertEqual(existing.read_text(), 'user file')
