"""Cross-platform utility to get the foreground window title and process name."""

import os
import subprocess
import sys


def get_foreground_window_title() -> str:
    """Return the title of the currently focused window, or '' on failure."""
    try:
        if sys.platform == "win32":
            return _win32_title()
        elif sys.platform == "linux":
            return _linux_title()
        elif sys.platform == "darwin":
            return _macos_title()
    except Exception:
        pass
    return ""


def get_foreground_process_name() -> str:
    """Return the process name of the focused window (e.g. 'cmd.exe'), or '' on failure."""
    try:
        if sys.platform == "win32":
            return _win32_process_name()
        elif sys.platform == "linux":
            return _linux_process_name()
        elif sys.platform == "darwin":
            return _macos_process_name()
    except Exception:
        pass
    return ""


# ---- Windows ---- #

def _win32_title() -> str:
    import ctypes
    hwnd = ctypes.windll.user32.GetForegroundWindow()
    if not hwnd:
        return ""
    buf = ctypes.create_unicode_buffer(512)
    ctypes.windll.user32.GetWindowTextW(hwnd, buf, 512)
    return buf.value


def _win32_process_name() -> str:
    import ctypes
    import ctypes.wintypes

    GetForegroundWindow = ctypes.windll.user32.GetForegroundWindow
    GetWindowThreadProcessId = ctypes.windll.user32.GetWindowThreadProcessId

    hwnd = GetForegroundWindow()
    if not hwnd:
        return ""

    pid = ctypes.wintypes.DWORD()
    GetWindowThreadProcessId(hwnd, ctypes.byref(pid))
    if not pid.value:
        return ""

    # OpenProcess with PROCESS_QUERY_LIMITED_INFORMATION (0x1000)
    OpenProcess = ctypes.windll.kernel32.OpenProcess
    CloseHandle = ctypes.windll.kernel32.CloseHandle
    QueryFullProcessImageNameW = ctypes.windll.kernel32.QueryFullProcessImageNameW

    handle = OpenProcess(0x1000, False, pid.value)
    if not handle:
        return ""
    try:
        buf = ctypes.create_unicode_buffer(512)
        size = ctypes.wintypes.DWORD(512)
        if QueryFullProcessImageNameW(handle, 0, buf, ctypes.byref(size)):
            # Return just the filename, e.g. "cmd.exe"
            return os.path.basename(buf.value)
    finally:
        CloseHandle(handle)
    return ""


# ---- Linux ---- #

def _linux_title() -> str:
    result = subprocess.run(
        ["xdotool", "getactivewindow", "getwindowname"],
        capture_output=True, text=True, timeout=2,
    )
    return result.stdout.strip() if result.returncode == 0 else ""


def _linux_process_name() -> str:
    result = subprocess.run(
        ["xdotool", "getactivewindow", "getwindowpid"],
        capture_output=True, text=True, timeout=2,
    )
    if result.returncode != 0:
        return ""
    pid = result.stdout.strip()
    try:
        with open(f"/proc/{pid}/comm") as f:
            return f.read().strip()
    except OSError:
        return ""


# ---- macOS ---- #

def _macos_title() -> str:
    script = (
        'tell application "System Events" to get name of first window '
        'of (first application process whose frontmost is true)'
    )
    result = subprocess.run(
        ["osascript", "-e", script],
        capture_output=True, text=True, timeout=2,
    )
    return result.stdout.strip() if result.returncode == 0 else ""


def _macos_process_name() -> str:
    script = (
        'tell application "System Events" to get name '
        'of first application process whose frontmost is true'
    )
    result = subprocess.run(
        ["osascript", "-e", script],
        capture_output=True, text=True, timeout=2,
    )
    return result.stdout.strip() if result.returncode == 0 else ""
