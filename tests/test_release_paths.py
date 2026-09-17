"""Homebrew opt aliases must not break version reporting."""
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from relay.distribution import client_archive
from relay.reliability import release_info


class ReleasePathTests(unittest.TestCase):
    def tearDown(self):
        release_info.cache_clear()

    def test_release_resolves_installation_before_building_archive(self):
        release_info.cache_clear()
        package = Path(__file__).resolve().parents[1] / 'relay'
        with patch('relay.reliability.Path') as path, \
             patch('relay.distribution.client_archive', wraps=client_archive) as archive:
            path.return_value.resolve.return_value.parent = package
            result = release_info()
        path.return_value.resolve.assert_called_once_with()
        archive.assert_called_once_with(package)
        self.assertEqual(len(result['build']), 64)

    def test_homebrew_style_symlink_reports_same_build_as_real_install(self):
        release_info.cache_clear()
        expected = release_info()['build']
        package = Path(__file__).resolve().parents[1] / 'relay'
        with tempfile.TemporaryDirectory() as directory:
            alias = Path(directory) / 'opt-relay'
            try:
                os.symlink(package, alias, target_is_directory=True)
            except OSError:
                self.skipTest('Directory symlink creation is unavailable on this host')
            # Reproduce the original exception without relaxing archive safety.
            with self.assertRaisesRegex(ValueError, 'symlinked source'):
                client_archive(alias)
            release_info.cache_clear()
            with patch('relay.reliability.__file__', str(alias / 'reliability.py')):
                self.assertEqual(release_info()['build'], expected)
