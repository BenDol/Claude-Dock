"""Cross-platform audio feedback (beep) helper."""

import os
import subprocess
import sys
import threading


def beep(freq: int = 440, duration_ms: int = 200):
    """Play a short tone without blocking. Best-effort — silently does nothing on failure."""
    threading.Thread(target=_beep_sync, args=(freq, duration_ms), daemon=True).start()


def _beep_sync(freq: int, duration_ms: int):
    """Synchronous beep implementation."""
    try:
        if os.name == "nt":
            import winsound
            winsound.Beep(freq, duration_ms)
            return

        if sys.platform == "darwin":
            # macOS: use afplay with a generated tone via say or tput bel
            subprocess.Popen(
                ["osascript", "-e", "beep"],
                stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
            )
            return

        # Linux: try paplay, then aplay, then terminal bell
        dur_s = duration_ms / 1000
        for player in ("paplay", "aplay"):
            if _try_sox_beep(freq, dur_s):
                return
        # Fallback: terminal bell
        sys.stderr.write("\a")
        sys.stderr.flush()
    except Exception:
        pass


def _try_sox_beep(freq: int, dur_s: float) -> bool:
    """Try to play a tone via sox (play command)."""
    try:
        subprocess.Popen(
            ["play", "-nq", "synth", str(dur_s), "sine", str(freq)],
            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
        )
        return True
    except FileNotFoundError:
        return False
