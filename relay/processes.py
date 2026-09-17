"""Consistent quiet child-process creation for background desktop work."""
import os
import subprocess


def background_options():
    if os.name != 'nt':
        return {}
    # CREATE_NO_WINDOW alone does not govern a later AllocConsole call in a
    # native client. Pass the initial window visibility as well, before launch.
    # Do not hide windows after creation: that still flashes and can steal focus.
    startup = subprocess.STARTUPINFO()
    startup.dwFlags |= subprocess.STARTF_USESHOWWINDOW
    startup.wShowWindow = subprocess.SW_HIDE
    return {'creationflags': subprocess.CREATE_NO_WINDOW, 'startupinfo': startup}
