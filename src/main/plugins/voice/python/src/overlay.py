"""Floating audio-visualizer indicator pinned to the active window's bottom-center.

Tracks the focused window on Windows (ctypes/Win32),
X11-based Linux (xdotool), and macOS (AppleScript).
"""

import math
import os
import shutil
import subprocess
import threading
import time


# ---- active-window rectangle ----------------------------------------- #

def _get_foreground_rect() -> tuple[int, int, int, int] | None:
    """Return (left, top, right, bottom) of the focused window, or None."""
    if os.name == "nt":
        return _win32_foreground_rect()
    import sys
    if sys.platform == "darwin":
        return _macos_foreground_rect()
    return _x11_foreground_rect()


# -- Windows ----------------------------------------------------------- #

def _win32_foreground_rect():
    try:
        import ctypes

        user32 = ctypes.windll.user32

        class RECT(ctypes.Structure):
            _fields_ = [
                ("left", ctypes.c_long),
                ("top", ctypes.c_long),
                ("right", ctypes.c_long),
                ("bottom", ctypes.c_long),
            ]

        hwnd = user32.GetForegroundWindow()
        if not hwnd:
            return None
        r = RECT()
        # Use DWM extended frame bounds to get the *visible* window rect
        # (GetWindowRect includes an invisible ~7px border on Win10/11)
        DWMWA_EXTENDED_FRAME_BOUNDS = 9
        try:
            dwmapi = ctypes.windll.dwmapi
            hr = dwmapi.DwmGetWindowAttribute(
                hwnd, DWMWA_EXTENDED_FRAME_BOUNDS,
                ctypes.byref(r), ctypes.sizeof(r),
            )
            if hr == 0:
                return r.left, r.top, r.right, r.bottom
        except Exception:
            pass
        # Fallback to GetWindowRect
        if user32.GetWindowRect(hwnd, ctypes.byref(r)):
            return r.left, r.top, r.right, r.bottom
    except Exception:
        pass
    return None


# -- X11 (Linux) ------------------------------------------------------- #

def _x11_foreground_rect():
    """Use xdotool to get the active window geometry (X11 only)."""
    if not shutil.which("xdotool"):
        return None
    try:
        wid = subprocess.check_output(
            ["xdotool", "getactivewindow"], stderr=subprocess.DEVNULL, timeout=1,
        ).strip()
        geo = subprocess.check_output(
            ["xdotool", "getwindowgeometry", "--shell", wid],
            stderr=subprocess.DEVNULL, timeout=1,
        ).decode()
        vals = {}
        for line in geo.splitlines():
            if "=" in line:
                k, v = line.split("=", 1)
                vals[k] = int(v)
        x = vals.get("X", 0)
        y = vals.get("Y", 0)
        w = vals.get("WIDTH", 0)
        h = vals.get("HEIGHT", 0)
        if w and h:
            return x, y, x + w, y + h
    except Exception:
        pass
    return None


# -- macOS ------------------------------------------------------------- #

def _macos_foreground_rect():
    """Use AppleScript to get the frontmost window bounds (macOS)."""
    try:
        script = (
            'tell application "System Events" to tell (first process '
            'whose frontmost is true) to get {position, size} of window 1'
        )
        out = subprocess.check_output(
            ["osascript", "-e", script],
            stderr=subprocess.DEVNULL, timeout=1,
        ).decode().strip()
        parts = [int(p.strip()) for p in out.split(",")]
        if len(parts) == 4:
            x, y, w, h = parts
            return x, y, x + w, y + h
    except Exception:
        pass
    return None


# ---- overlay --------------------------------------------------------- #

# Bar visualizer dimensions
_NUM_BARS = 7
_BAR_W = 4
_BAR_GAP = 3
_BAR_MAX_H = 22
_BAR_MIN_H = 3
_PAD_X = 8
_PAD_Y = 4
_BOTTOM_PAD = 6
_HOTKEY_PAD = 8

_WIN_W = _PAD_X * 2 + _NUM_BARS * _BAR_W + (_NUM_BARS - 1) * _BAR_GAP
_WIN_H = _PAD_Y * 2 + _BAR_MAX_H

# Animation
_ANIM_SHOW_S = 0.45
_ANIM_HIDE_S = 0.18


class RecordingOverlay:
    """Audio-bar visualizer that follows the active window (bottom-center)."""

    HIDDEN = "hidden"
    RECORDING = "recording"
    TRANSCRIBING = "transcribing"

    _COLOR = {RECORDING: "#e53935", TRANSCRIBING: "#f9a825"}
    _COLOR_DIM = {RECORDING: "#7a1a1a", TRANSCRIBING: "#7a5a00"}

    def __init__(self, hotkey: str = ""):
        self._desired = self.HIDDEN
        self._current = self.HIDDEN
        self._hotkey = hotkey
        self._root = None
        self._canvas = None
        self._bar_ids: list = []
        self._label = None
        self._ready = threading.Event()
        # Virtual desktop bounds (all monitors combined)
        self._virt_left = 0
        self._virt_top = 0
        self._virt_right = 0
        self._virt_bottom = 0
        self._win_w = _WIN_W
        self._win_h = _WIN_H
        # Audio levels: list of floats 0.0–1.0, one per bar
        self._levels = [0.0] * _NUM_BARS
        self._smooth = [0.0] * _NUM_BARS
        self._lock = threading.Lock()
        # Animation state
        self._anim_type = None   # "show" or "hide"
        self._anim_start = 0.0
        self._anim_scale = 0.0
        self._target_x = 0
        self._target_y = 0

    # ---- public API (thread-safe) ------------------------------------ #

    def start(self):
        threading.Thread(target=self._tk_main, daemon=True).start()
        self._ready.wait(timeout=3)

    def show_recording(self):
        self._desired = self.RECORDING

    def show_transcribing(self):
        self._desired = self.TRANSCRIBING

    def hide(self):
        self._desired = self.HIDDEN

    def set_levels(self, levels: list[float]):
        """Update audio bar levels (0.0–1.0). Called from recorder callback."""
        with self._lock:
            self._levels = levels[:_NUM_BARS]

    # ---- tkinter thread ---------------------------------------------- #

    def _tk_main(self):
        try:
            import tkinter as tk
        except ImportError:
            self._ready.set()
            return

        # Enable DPI awareness on Windows so coordinates match across monitors
        if os.name == "nt":
            try:
                import ctypes
                ctypes.windll.shcore.SetProcessDpiAwareness(1)
            except Exception:
                try:
                    import ctypes
                    ctypes.windll.user32.SetProcessDPIAware()
                except Exception:
                    pass

        root = tk.Tk()
        self._root = root

        root.overrideredirect(True)
        root.attributes("-topmost", True)

        # Background — use transparent color key on Windows for true rounded corners
        bg = "#222222"
        transparent = "#010101"
        use_transparency = os.name == "nt"
        canvas_bg = transparent if use_transparency else bg
        root.configure(bg=canvas_bg)
        if use_transparency:
            try:
                root.attributes("-transparentcolor", transparent)
            except Exception:
                use_transparency = False
                root.configure(bg=bg)
                canvas_bg = bg

        # Get virtual desktop bounds (spans all monitors)
        self._init_virtual_bounds(root)

        font_family = "Segoe UI" if os.name == "nt" else "sans-serif"

        # Measure hotkey label width
        hotkey_w = 0
        if self._hotkey:
            tmp = tk.Label(root, text=self._hotkey, font=(font_family, 8), bg=canvas_bg)
            tmp.update_idletasks()
            hotkey_w = tmp.winfo_reqwidth() + _HOTKEY_PAD
            tmp.destroy()

        self._win_w = _WIN_W + hotkey_w
        self._win_h = _WIN_H

        canvas = tk.Canvas(
            root, width=self._win_w, height=self._win_h,
            bg=canvas_bg, highlightthickness=0, bd=0,
        )
        # Use place with center anchor so window resize clips equally from all edges
        canvas.place(relx=0.5, rely=0.5, anchor="center")
        self._canvas = canvas

        # Rounded rectangle background
        self._draw_rounded_rect(
            canvas, 0, 0, self._win_w, self._win_h,
            radius=12, fill=bg, outline="",
        )

        # Create bars
        self._bar_ids = []
        for i in range(_NUM_BARS):
            x = _PAD_X + i * (_BAR_W + _BAR_GAP)
            # Start with min height bars
            y_top = _PAD_Y + _BAR_MAX_H - _BAR_MIN_H
            y_bot = _PAD_Y + _BAR_MAX_H
            bar = canvas.create_rectangle(
                x, y_top, x + _BAR_W, y_bot,
                fill="#e53935", outline="", width=0,
            )
            self._bar_ids.append(bar)

        # Hotkey label
        if self._hotkey:
            label_x = _WIN_W + _HOTKEY_PAD // 2
            label_y = self._win_h // 2
            self._label = canvas.create_text(
                label_x, label_y,
                text=self._hotkey, fill="#888888",
                font=(font_family, 8), anchor="w",
            )

        root.geometry(self._fallback_geometry())
        root.withdraw()
        self._ready.set()
        self._poll()
        root.mainloop()

    # ---- drawing ------------------------------------------------------- #

    @staticmethod
    def _draw_rounded_rect(canvas, x1, y1, x2, y2, radius=6, **kwargs):
        """Draw a rounded rectangle using a smooth polygon."""
        r = radius
        points = [
            x1 + r, y1,
            x2 - r, y1,
            x2, y1,
            x2, y1 + r,
            x2, y2 - r,
            x2, y2,
            x2 - r, y2,
            x1 + r, y2,
            x1, y2,
            x1, y2 - r,
            x1, y1 + r,
            x1, y1,
        ]
        canvas.create_polygon(points, smooth=True, **kwargs)

    # ---- easing -------------------------------------------------------- #

    @staticmethod
    def _elastic_out(t: float) -> float:
        """Elastic ease-out: overshoots then settles to 1.0."""
        if t <= 0:
            return 0.0
        if t >= 1:
            return 1.0
        p = 0.35
        s = p / 4
        return math.pow(2, -10 * t) * math.sin((t - s) * 2 * math.pi / p) + 1.0

    # ---- positioning ------------------------------------------------- #

    def _init_virtual_bounds(self, root):
        """Detect virtual desktop bounds spanning all monitors."""
        if os.name == "nt":
            try:
                import ctypes
                user32 = ctypes.windll.user32
                SM_XVIRTUALSCREEN = 76
                SM_YVIRTUALSCREEN = 77
                SM_CXVIRTUALSCREEN = 78
                SM_CYVIRTUALSCREEN = 79
                self._virt_left = user32.GetSystemMetrics(SM_XVIRTUALSCREEN)
                self._virt_top = user32.GetSystemMetrics(SM_YVIRTUALSCREEN)
                self._virt_right = self._virt_left + user32.GetSystemMetrics(SM_CXVIRTUALSCREEN)
                self._virt_bottom = self._virt_top + user32.GetSystemMetrics(SM_CYVIRTUALSCREEN)
                return
            except Exception:
                pass
        # Fallback: primary monitor only
        self._virt_left = 0
        self._virt_top = 0
        self._virt_right = root.winfo_screenwidth()
        self._virt_bottom = root.winfo_screenheight()

    def _fallback_geometry(self) -> str:
        cx = (self._virt_left + self._virt_right) // 2
        x = cx - self._win_w // 2
        y = self._virt_bottom - self._win_h - _BOTTOM_PAD - 40
        return f"{self._win_w}x{self._win_h}+{x}+{y}"

    def _reposition(self):
        """Compute target position (bottom-center of foreground window)."""
        rect = _get_foreground_rect()
        if rect:
            left, top, right, bottom = rect
            win_center = (left + right) // 2
            x = max(self._virt_left, min(win_center - self._win_w // 2, self._virt_right - self._win_w))
            y = max(self._virt_top, min(bottom - self._win_h - _BOTTOM_PAD, self._virt_bottom - self._win_h - _BOTTOM_PAD))
        else:
            cx = (self._virt_left + self._virt_right) // 2
            x = cx - self._win_w // 2
            y = self._virt_bottom - self._win_h - _BOTTOM_PAD - 40
        self._target_x = x
        self._target_y = y
        # Only set geometry directly when not animating
        if self._anim_type is None:
            self._root.geometry(f"{self._win_w}x{self._win_h}+{x}+{y}")

    def _apply_scale(self):
        """Resize window around center-bottom anchor based on _anim_scale."""
        s = max(0.01, self._anim_scale)
        sw = max(1, int(self._win_w * s))
        sh = max(1, int(self._win_h * s))
        # Anchor at center-bottom of target position
        cx = self._target_x + self._win_w // 2
        bot = self._target_y + self._win_h
        x = cx - sw // 2
        y = bot - sh
        self._root.geometry(f"{sw}x{sh}+{x}+{y}")

    # ---- poll loop --------------------------------------------------- #

    def _poll(self):
        if self._root is None:
            return

        desired = self._desired
        now = time.time()

        if desired == self.HIDDEN:
            if self._current != self.HIDDEN:
                # Start hide animation (shrink out)
                if self._anim_type != "hide":
                    self._anim_type = "hide"
                    self._anim_start = now

                t = min(1.0, (now - self._anim_start) / _ANIM_HIDE_S)
                self._anim_scale = (1.0 - t) ** 2  # quadratic ease-in shrink
                self._apply_scale()

                if t >= 1.0:
                    self._root.withdraw()
                    self._current = self.HIDDEN
                    self._anim_type = None
                    self._anim_scale = 0.0
                    self._smooth = [0.0] * _NUM_BARS
        else:
            color = self._COLOR[desired]
            color_dim = self._COLOR_DIM[desired]

            if self._current == self.HIDDEN:
                # Transition from hidden → visible: start pop-in
                self._root.deiconify()
                self._current = desired
                self._anim_type = "show"
                self._anim_start = now
            elif self._current != desired:
                self._current = desired

            self._reposition()

            if self._anim_type == "show":
                t = min(1.0, (now - self._anim_start) / _ANIM_SHOW_S)
                self._anim_scale = self._elastic_out(t)
                self._apply_scale()
                if t >= 1.0:
                    self._anim_type = None
                    self._anim_scale = 1.0
                    self._root.geometry(
                        f"{self._win_w}x{self._win_h}+{self._target_x}+{self._target_y}"
                    )

            self._update_bars(color, color_dim, desired)

        # 16ms (~60fps) when visible, 50ms when hidden for fast response
        interval = 16 if self._current != self.HIDDEN else 50
        self._root.after(interval, self._poll)

    def _update_bars(self, color: str, color_dim: str, state: str):
        """Animate bars based on audio levels."""
        with self._lock:
            raw = list(self._levels)

        # Pad to NUM_BARS if needed
        while len(raw) < _NUM_BARS:
            raw.append(0.0)

        for i in range(_NUM_BARS):
            target = raw[i]

            if state == self.TRANSCRIBING:
                # Pulsing animation when transcribing
                t = time.time() * 3 + i * 0.7
                target = 0.3 + 0.3 * math.sin(t)

            # Smooth: rise fast, fall slow
            if target > self._smooth[i]:
                self._smooth[i] += (target - self._smooth[i]) * 0.6
            else:
                self._smooth[i] += (target - self._smooth[i]) * 0.25

            level = max(0.0, min(1.0, self._smooth[i]))
            bar_h = _BAR_MIN_H + level * (_BAR_MAX_H - _BAR_MIN_H)

            x = _PAD_X + i * (_BAR_W + _BAR_GAP)
            y_top = _PAD_Y + _BAR_MAX_H - bar_h
            y_bot = _PAD_Y + _BAR_MAX_H

            fill = color if level > 0.15 else color_dim
            self._canvas.coords(self._bar_ids[i], x, y_top, x + _BAR_W, y_bot)
            self._canvas.itemconfigure(self._bar_ids[i], fill=fill)
