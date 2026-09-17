"""Windows native-provider startup check; no model calls or session discovery."""
import json
from pathlib import Path
import subprocess
import sys
import tempfile

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from relay.adapters import CodexRPC
from relay.processes import background_options


def console_state(pid):
    probe = (
        'import ctypes,json; from ctypes import wintypes; '
        'k=ctypes.windll.kernel32; u=ctypes.windll.user32; '
        'k.GetConsoleWindow.restype=wintypes.HWND; '
        'u.IsWindowVisible.argtypes=[wintypes.HWND]; '
        'k.FreeConsole(); '
        f'a=bool(k.AttachConsole({int(pid)})); h=k.GetConsoleWindow(); '
        'print(json.dumps(dict(attached=a,has_window=bool(h),'
        'visible=bool(u.IsWindowVisible(h))))); k.FreeConsole()'
    )
    result = subprocess.run([sys.executable, '-c', probe], capture_output=True,
                            text=True, timeout=10, check=True, **background_options())
    return json.loads(result.stdout)


def main():
    if sys.platform != 'win32':
        raise SystemExit('Windows only')
    runs = []
    with tempfile.TemporaryDirectory(prefix='relay-quiet-start-') as repo:
        for _ in range(3):
            rpc = CodexRPC(repo)
            try:
                state = console_state(rpc.process.pid)
                assert not state['visible'], state
                runs.append(state)
            finally:
                rpc.close()
            assert rpc.process.poll() is not None, 'Owned provider did not stop'
    report = dict(passed=True, native_codex_starts=3, console_states=runs,
                  model_calls=0, existing_sessions_touched=False)
    evidence = Path('.relay/windows-spawn-verification.json')
    evidence.parent.mkdir(parents=True, exist_ok=True)
    evidence.write_text(json.dumps(report, indent=2), encoding='utf-8')
    print(json.dumps(report))


if __name__ == '__main__':
    main()
