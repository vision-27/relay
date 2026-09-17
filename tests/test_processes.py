import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

from relay.client import git_info
from relay.discovery import git_root
from relay.processes import background_options
from relay.integrations import register


class QuietProcessTests(unittest.TestCase):
    def assert_quiet(self, kwargs):
        expected = background_options()
        if os.name == 'nt':
            self.assertEqual(kwargs['creationflags'], expected['creationflags'])
            self.assertEqual(kwargs['startupinfo'].dwFlags, expected['startupinfo'].dwFlags)
            self.assertEqual(kwargs['startupinfo'].wShowWindow, subprocess.SW_HIDE)

    def test_repository_checks_pass_background_flags(self):
        with tempfile.TemporaryDirectory() as directory:
            with patch('relay.client.subprocess.run') as run:
                run.return_value = subprocess.CompletedProcess([], 0, 'main', '')
                git_info(directory)
                self.assertEqual(run.call_count, 3)
                for call in run.call_args_list:
                    self.assert_quiet(call.kwargs)
            with patch('relay.discovery.subprocess.run') as run:
                run.return_value = subprocess.CompletedProcess([], 0, directory, '')
                self.assertEqual(git_root(directory), str(Path(directory).resolve()))
                self.assert_quiet(run.call_args.kwargs)

    @unittest.skipUnless(os.name == 'nt', 'Windows console behavior')
    def test_real_child_has_no_console_window(self):
        result = subprocess.run([sys.executable, '-c',
            'import ctypes; print(bool(ctypes.windll.kernel32.GetConsoleWindow()))'],
            capture_output=True, text=True, timeout=8, **background_options())
        self.assertEqual(result.returncode, 0)
        self.assertEqual(result.stdout.strip(), 'False')

    @unittest.skipUnless(os.name == 'nt', 'Windows console behavior')
    def test_later_console_allocation_stays_hidden(self):
        # Model the native provider behavior: it allocates its own console even
        # though the caller requested CREATE_NO_WINDOW. Pipes must remain usable.
        probe = ('import ctypes,json; from ctypes import wintypes; '
                 'k=ctypes.windll.kernel32; u=ctypes.windll.user32; '
                 'k.GetConsoleWindow.restype=wintypes.HWND; '
                 'u.IsWindowVisible.argtypes=[wintypes.HWND]; '
                 'k.FreeConsole(); '
                 'allocated=bool(k.AllocConsole()); hwnd=k.GetConsoleWindow(); '
                 'print(json.dumps([allocated,bool(hwnd),bool(u.IsWindowVisible(hwnd))])); '
                 'k.FreeConsole()')
        result = subprocess.run([sys.executable, '-c', probe], capture_output=True,
                                text=True, timeout=8, **background_options())
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stdout.strip(), '[true, true, false]')

    @unittest.skipUnless(os.name == 'nt', 'Windows console behavior')
    def test_supervisor_does_not_disable_no_window_flag(self):
        from relay.lifecycle import detached_options
        options = detached_options()
        self.assertTrue(options['creationflags'] & subprocess.CREATE_NO_WINDOW)
        self.assertTrue(options['creationflags'] & subprocess.CREATE_NEW_PROCESS_GROUP)
        self.assertFalse(options['creationflags'] & subprocess.DETACHED_PROCESS)
        self.assertEqual(options['startupinfo'].wShowWindow, subprocess.SW_HIDE)

    def test_registration_is_quiet_preserves_other_entries_and_is_idempotent(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'connection.json'
            config = {'provider':'codex', 'session_id':'a'*16, 'repo':directory}
            with patch('relay.integrations.shutil.which', return_value='codex.exe'), patch('relay.integrations.subprocess.run') as run:
                run.side_effect = [subprocess.CompletedProcess([], 1, '', "Error: No MCP server named 'relay-aaaaaaaa' found."),
                                   subprocess.CompletedProcess([], 0, 'added', '')]
                self.assertTrue(register(path, config)['configured'])
                self.assertEqual(run.call_count, 2)
                self.assertIn('mcp', run.call_args.args[0])
                self.assert_quiet(run.call_args.kwargs)
                register(path, config)
                self.assertEqual(run.call_count, 2)

    def test_conflicting_codex_entry_is_never_overwritten(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'connection.json'
            config = {'provider':'codex', 'session_id':'a'*16, 'repo':directory}
            with patch('relay.integrations.shutil.which', return_value='codex.exe'), patch('relay.integrations.subprocess.run') as run:
                run.return_value = subprocess.CompletedProcess([], 0, '{"transport":{"command":"unrelated","args":[]}}', '')
                with self.assertRaisesRegex(ValueError, 'Nothing was replaced'):
                    register(path, config)
                self.assertEqual(run.call_count, 1)
                self.assertFalse(path.with_suffix('.tools.json').exists())

    def test_registration_failure_does_not_claim_configured(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'connection.json'
            config = {'provider':'claude', 'session_id':'b'*16, 'repo':directory}
            with patch('relay.integrations.shutil.which', return_value='claude.exe'), patch('relay.integrations.subprocess.run') as run:
                run.return_value = subprocess.CompletedProcess([], 1, 'private output', '')
                with self.assertRaises(ValueError) as caught:
                    register(path, config)
                self.assertNotIn('private output', str(caught.exception))
                self.assertFalse(path.with_suffix('.tools.json').exists())


if __name__ == '__main__':
    unittest.main()
