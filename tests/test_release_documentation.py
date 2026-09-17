"""Offline release/documentation checks, safe for all CI platforms."""
from io import BytesIO
from pathlib import Path
import re
import tomllib
import unittest
from urllib.parse import unquote, urlsplit
from zipfile import ZipFile

from relay import __version__
from relay.distribution import PACKAGE_FILES, client_archive


ROOT = Path(__file__).resolve().parents[1]
GUIDES = (
    'README.md', 'GETTING_STARTED.md', 'CHANGELOG.md', 'CONTRIBUTING.md',
    'SECURITY.md', 'RELIABILITY_ACCEPTANCE.md', 'docs/OPERATIONS.md',
    'docs/ARCHITECTURE.md', 'docs/ACCEPTANCE_HISTORY.md',
)


class ReleaseDocumentationTests(unittest.TestCase):
    def test_runtime_metadata_and_current_release_notes_agree(self):
        metadata = tomllib.loads((ROOT / 'pyproject.toml').read_text(encoding='utf-8'))
        self.assertEqual(metadata['project']['version'], __version__)
        self.assertEqual(metadata['project']['scripts']['relay-workspace'], 'relay.__main__:main')
        notes = (ROOT / 'CHANGELOG.md').read_text(encoding='utf-8')
        self.assertEqual(re.search(r'^## (\d+\.\d+\.\d+) ', notes, re.M).group(1), __version__)
        self.assertIn('version: ' + __version__, (ROOT / 'README.md').read_text(encoding='utf-8'))

    def test_primary_guides_have_resolvable_local_links(self):
        for name in GUIDES:
            guide = ROOT / name
            body = guide.read_text(encoding='utf-8')
            for target in re.findall(r'\]\(([^)]+)\)', body):
                parsed = urlsplit(target)
                if parsed.scheme or not parsed.path:
                    continue
                with self.subTest(guide=name, link=target):
                    path = (guide.parent / unquote(parsed.path)).resolve()
                    path.relative_to(ROOT)
                    self.assertTrue(path.is_file())

    def test_distribution_is_application_source_only(self):
        with ZipFile(BytesIO(client_archive())) as archive:
            expected = {'relay-workspace/relay/' + name for name in PACKAGE_FILES}
            expected.add('relay-workspace/START_HERE.txt')
            self.assertEqual(set(archive.namelist()), expected)
            self.assertEqual(len(archive.namelist()), len(expected))
            for name in archive.namelist():
                self.assertNotIn('.relay/', name)
                self.assertNotIn('__pycache__', name)
                self.assertNotIn('connection.json', name)

    def test_ci_is_cross_platform_pinned_and_not_privileged(self):
        ci = (ROOT / '.github/workflows/ci.yml').read_text(encoding='utf-8')
        for platform in ('ubuntu-latest', 'windows-latest', 'macos-latest'):
            self.assertIn(platform, ci)
        self.assertIn('contents: read', ci)
        self.assertIn('persist-credentials: false', ci)
        self.assertNotIn('pull_request_target', ci)
        self.assertNotIn('secrets.', ci)
        self.assertNotIn('native_smoke', ci)
        uses = re.findall(r'uses: ([^\s]+)', ci)
        self.assertTrue(uses)
        for action in uses:
            self.assertRegex(action, r'^actions/[a-z-]+@[a-f0-9]{40}$')
