"""Read-only short window/process trace. Records no window titles or commands."""
import ctypes
from ctypes import wintypes as w
import json
from pathlib import Path
import time

k = ctypes.WinDLL('kernel32', use_last_error=True)
u = ctypes.WinDLL('user32', use_last_error=True)

class Entry(ctypes.Structure):
    _fields_ = [('size', w.DWORD), ('usage', w.DWORD), ('pid', w.DWORD),
               ('heap', ctypes.c_size_t), ('module', w.DWORD), ('threads', w.DWORD),
               ('parent', w.DWORD), ('priority', w.LONG), ('flags', w.DWORD),
               ('exe', w.WCHAR * 260)]

k.CreateToolhelp32Snapshot.restype = w.HANDLE
k.Process32FirstW.argtypes = [w.HANDLE, ctypes.POINTER(Entry)]
k.Process32NextW.argtypes = [w.HANDLE, ctypes.POINTER(Entry)]
k.CloseHandle.argtypes = [w.HANDLE]
u.GetWindowThreadProcessId.argtypes = [w.HWND, ctypes.POINTER(w.DWORD)]
u.IsWindowVisible.argtypes = [w.HWND]
u.GetClassNameW.argtypes = [w.HWND, w.LPWSTR, ctypes.c_int]

def processes():
    snapshot = k.CreateToolhelp32Snapshot(2, 0)
    rows = {}
    try:
        entry = Entry()
        entry.size = ctypes.sizeof(entry)
        more = k.Process32FirstW(snapshot, ctypes.byref(entry))
        while more:
            rows[entry.pid] = dict(pid=entry.pid, parent=entry.parent, exe=entry.exe)
            more = k.Process32NextW(snapshot, ctypes.byref(entry))
        return rows
    finally:
        k.CloseHandle(snapshot)

def main():
    known = processes()
    events = []
    callback_type = ctypes.WINFUNCTYPE(None, w.HANDLE, w.DWORD, w.HWND,
                                      w.LONG, w.LONG, w.DWORD, w.DWORD)
    def shown(hook, event, hwnd, obj, child, thread, timestamp):
        if obj or child or not hwnd or not u.IsWindowVisible(hwnd):
            return
        pid = w.DWORD()
        u.GetWindowThreadProcessId(hwnd, ctypes.byref(pid))
        name = ctypes.create_unicode_buffer(128)
        u.GetClassNameW(hwnd, name, len(name))
        tree = processes()
        chain, current = [], pid.value
        for _ in range(5):
            row = tree.get(current) or known.get(current)
            if not row or row in chain:
                break
            chain.append(row)
            current = row['parent']
        events.append(dict(kind='visible-window', window_class=name.value, chain=chain))
    callback = callback_type(shown)
    u.SetWinEventHook.argtypes = [w.DWORD, w.DWORD, w.HMODULE, callback_type,
                                  w.DWORD, w.DWORD, w.DWORD]
    u.SetWinEventHook.restype = w.HANDLE
    u.UnhookWinEvent.argtypes = [w.HANDLE]
    hook = u.SetWinEventHook(0x8002, 0x8002, None, callback, 0, 0, 0)
    if not hook:
        raise ctypes.WinError(ctypes.get_last_error())
    deadline = time.monotonic() + 25
    msg = w.MSG()
    try:
        while time.monotonic() < deadline:
            while u.PeekMessageW(ctypes.byref(msg), None, 0, 0, 1):
                u.TranslateMessage(ctypes.byref(msg))
                u.DispatchMessageW(ctypes.byref(msg))
            current = processes()
            for pid, row in current.items():
                if pid not in known:
                    events.append(dict(kind='process-start', process=row,
                                       parent=current.get(row['parent']) or known.get(row['parent'])))
            known.update(current)
            time.sleep(.05)
    finally:
        u.UnhookWinEvent(hook)
    path = Path('.relay/windows-window-trace.json')
    path.write_text(json.dumps(events, indent=2), encoding='utf-8')
    print(json.dumps(events))

if __name__ == '__main__':
    main()
