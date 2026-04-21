#!/usr/bin/env python3
"""Background daemon that listens for a global hotkey to toggle voice recording.

In Dock-managed mode this daemon is spawned and supervised by the Voice plugin
in the Electron main process. It can also be run standalone:
    python hotkey_daemon.py --config <path> --pid-file <path> --log-file <path>

Uses a PID file to ensure only one instance runs at a time.
Logs to the provided --log-file for troubleshooting.
"""

import argparse
import atexit
import json
import os
import signal
import sys
import threading
import time

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))

# make sure our package is importable
if SCRIPT_DIR not in sys.path:
    sys.path.insert(0, SCRIPT_DIR)


# ---- argv parsing --------------------------------------------------- #

def _parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--config", default=None,
                        help="Path to voice config JSON. Defaults to SCRIPT_DIR/config.json.")
    parser.add_argument("--pid-file", default=None,
                        help="Path to PID file for single-instance locking. "
                             "Defaults to SCRIPT_DIR/.hotkey.pid.")
    parser.add_argument("--log-file", default=None,
                        help="Path to log file. Defaults to SCRIPT_DIR/.hotkey.log.")
    args, _ = parser.parse_known_args()
    return args


_ARGS = _parse_args()

CONFIG_FILE = _ARGS.config or os.environ.get("VOICE_CONFIG_PATH") or os.path.join(SCRIPT_DIR, "config.json")
PID_FILE = _ARGS.pid_file or os.environ.get("VOICE_PID_FILE") or os.path.join(SCRIPT_DIR, ".hotkey.pid")
LOG_FILE = _ARGS.log_file or os.environ.get("VOICE_LOG_FILE") or os.path.join(SCRIPT_DIR, ".hotkey.log")


def _ensure_parent(path: str):
    parent = os.path.dirname(path)
    if parent:
        try:
            os.makedirs(parent, exist_ok=True)
        except OSError:
            pass


def _log(msg: str):
    line = f"[{time.strftime('%H:%M:%S')}] {msg}"
    try:
        with open(LOG_FILE, "a", encoding="utf-8") as f:
            f.write(line + "\n")
    except OSError:
        pass
    # Also emit to stderr so Dock can tail subprocess output
    try:
        sys.stderr.write(line + "\n")
        sys.stderr.flush()
    except Exception:
        pass


def _beep(freq: int, dur: int):
    try:
        from src.audio_feedback import beep
        beep(freq, dur)
    except Exception:
        pass


# ---- single-instance management ------------------------------------- #

def _kill_existing():
    if not os.path.exists(PID_FILE):
        return
    try:
        with open(PID_FILE) as f:
            old_pid = int(f.read().strip())
        os.kill(old_pid, signal.SIGTERM)
        _log(f"Killed previous daemon (PID {old_pid})")
    except (ValueError, ProcessLookupError, PermissionError, OSError):
        pass
    try:
        os.unlink(PID_FILE)
    except OSError:
        pass


def _write_pid():
    with open(PID_FILE, "w") as f:
        f.write(str(os.getpid()))


def _cleanup_pid():
    try:
        os.unlink(PID_FILE)
    except OSError:
        pass


# ---- main ------------------------------------------------------------ #

def main():
    # Defer directory creation until main() — startup-time mkdir on a read-only
    # bundle path silently broke earlier; log and continue so the user still gets
    # stderr output even when the file-based log can't be created.
    for p in (PID_FILE, LOG_FILE):
        try:
            _ensure_parent(p)
        except Exception as exc:
            _log(f"Warning: could not create parent dir for {p}: {exc}")

    _kill_existing()
    _write_pid()
    atexit.register(_cleanup_pid)

    try:
        _run_daemon()
    finally:
        # Belt-and-braces: early returns below bypass atexit on some platforms
        # (e.g. when the interpreter is hard-killed shortly after), so remove
        # the PID file explicitly as well.
        _cleanup_pid()


def _run_daemon():
    # Truncate log on fresh start
    try:
        with open(LOG_FILE, "w") as f:
            f.write("")
    except OSError:
        pass

    _log(f"Daemon starting (PID {os.getpid()})")
    _log(f"Config: {CONFIG_FILE}")
    _log(f"PID file: {PID_FILE}")

    try:
        with open(CONFIG_FILE, encoding="utf-8") as f:
            config = json.load(f)
    except Exception as exc:
        _log(f"Failed to load config: {exc}")
        return

    hotkey_cfg = config.get("hotkey", {})
    if not hotkey_cfg.get("enabled", True):
        _log("Hotkey disabled in config — exiting")
        return

    binding = hotkey_cfg.get("binding", "ctrl+alt+v")
    mode = hotkey_cfg.get("mode", "toggle")  # "toggle" or "hold"
    auto_paste = hotkey_cfg.get("auto_paste", True)
    auto_send_keywords = [kw.lower().strip() for kw in hotkey_cfg.get("auto_send_keywords", [])]
    auto_stop_on_keyword = hotkey_cfg.get("auto_stop_on_keyword", True)
    undo_enabled = hotkey_cfg.get("undo_enabled", True)
    undo_phrases = [p.lower().strip() for p in hotkey_cfg.get("undo_phrases", [
        "forget that last part", "forget that", "actually forget that",
    ]) if p and p.strip()] if undo_enabled else []
    scope = hotkey_cfg.get("scope", "global")  # "global" or "focused"
    scope_patterns = [p.lower() for p in hotkey_cfg.get("scope_title_patterns", ["claude"])]
    scope_process_patterns = [p.lower() for p in hotkey_cfg.get("scope_process_patterns", [
        "cmd.exe", "powershell.exe", "pwsh.exe", "windowsterminal.exe",
        "wt.exe", "alacritty.exe", "wezterm-gui.exe",
    ])]

    # ---- load components ---- #

    # Wayland provides no reliable global-hook API. The main process also gates
    # this, but check again here so a daemon launched from a stale X11 session
    # into Wayland exits cleanly rather than silently not firing.
    if sys.platform.startswith("linux"):
        if os.environ.get("XDG_SESSION_TYPE", "").lower() == "wayland" or os.environ.get("WAYLAND_DISPLAY"):
            _log("Wayland session detected — global hotkeys unsupported, exiting. Use /voice MCP command instead.")
            return

    try:
        from pynput import keyboard as pkb
    except ImportError:
        _log("'pynput' package not installed — exiting")
        return
    except Exception as exc:
        _log(f"pynput init failed: {exc}")
        return

    try:
        from src.hotkey_parser import parse_binding, modifiers_satisfied
    except Exception as exc:
        _log(f"Hotkey parser import failed: {exc}")
        return

    from src.recorder import VoiceRecorder
    from src.transcriber import create_transcriber
    from src.overlay import RecordingOverlay

    overlay = RecordingOverlay(hotkey=binding)
    overlay.start()

    rec_cfg = config.get("recording", {})
    recorder = VoiceRecorder(
        sample_rate=rec_cfg.get("sample_rate", 16000),
        channels=rec_cfg.get("channels", 1),
        speech_threshold=rec_cfg.get("speech_threshold", 500),
        on_levels=overlay.set_levels,
        device=rec_cfg.get("input_device"),
    )

    try:
        transcriber = create_transcriber(config.get("transcriber", {}))
    except Exception as exc:
        _log(f"Transcriber init failed: {exc}")
        return

    _log(f"Backend: {transcriber.name}")

    # ---- scope helper ---- #

    def _is_target_window_focused() -> bool:
        """Check if the foreground window matches by title or process name."""
        if scope != "focused":
            return True
        try:
            from src.window_title import get_foreground_window_title, get_foreground_process_name
            title = get_foreground_window_title().lower()
            if any(p in title for p in scope_patterns):
                return True
            proc = get_foreground_process_name().lower()
            return any(p in proc for p in scope_process_patterns)
        except Exception:
            return False

    # ---- hotkey toggle / hold ---- #

    state = {"recording": False, "busy": False}
    lock = threading.Lock()

    def _start_recording():
        """Start recording. Caller must hold lock and ensure not busy/already recording."""
        state["recording"] = True
        _beep(880, 150)
        try:
            recorder.start()
            overlay.show_recording()
            _log("Recording started")
            if auto_stop_on_keyword and auto_send_keywords:
                threading.Thread(
                    target=_keyword_watch_loop,
                    daemon=True,
                ).start()
        except Exception as exc:
            _log(f"Mic error: {exc}")
            _beep(220, 300)
            state["recording"] = False
            overlay.hide()

    def _stop_and_transcribe():
        """Stop recording and kick off transcription. Caller must hold lock."""
        state["recording"] = False
        state["busy"] = True
        _beep(440, 200)
        overlay.show_transcribing()
        _log("Recording stopped")

        audio_path = recorder.stop()
        if not audio_path:
            _log("Empty recording")
            _beep(220, 300)
            overlay.hide()
            state["busy"] = False
            return

        threading.Thread(
            target=_transcribe_and_paste,
            args=(audio_path,),
            daemon=True,
        ).start()

    def on_hotkey():
        """Toggle mode: press to start, press again to stop."""
        if not state["recording"] and not _is_target_window_focused():
            return
        with lock:
            if state["busy"]:
                _beep(330, 100)
                return

            if not state["recording"]:
                _start_recording()
            else:
                _stop_and_transcribe()

    def on_hold_press():
        """Hold mode: key pressed — start recording."""
        if not _is_target_window_focused():
            return
        with lock:
            if state["busy"] or state["recording"]:
                return
            _start_recording()

    def on_hold_release(event):
        """Hold mode: key released — stop recording."""
        with lock:
            if not state["recording"] or state["busy"]:
                return
            _stop_and_transcribe()

    def _keyword_watch_loop():
        """Periodically transcribe tail audio to detect auto-send keywords."""
        _log("Keyword watch started")
        # Wait a bit before first check to accumulate audio
        time.sleep(2.0)
        while state["recording"] and not state["busy"]:
            tail_path = recorder.get_tail_wav(seconds=3.0)
            if tail_path:
                try:
                    tail_text = transcriber.transcribe(tail_path)
                except Exception:
                    tail_text = ""
                finally:
                    try:
                        os.unlink(tail_path)
                    except OSError:
                        pass
                if tail_text:
                    norm = tail_text.lower().replace("'", "").replace("\u2019", "").rstrip(".!?,;: ")
                    for kw in auto_send_keywords:
                        if norm.endswith(kw):
                            _log(f"Keyword '{kw}' detected in live audio — auto-stopping")
                            with lock:
                                if state["recording"] and not state["busy"]:
                                    _stop_and_transcribe()
                            return
            time.sleep(1.5)
        _log("Keyword watch ended")

    def _apply_undo_phrases(text: str) -> str:
        """Remove the sentence before each occurrence of any undo phrase."""
        import re
        # Sort longest first so "forget that last part" matches before "forget that"
        sorted_phrases = sorted(undo_phrases, key=len, reverse=True)
        pattern = re.compile(
            "|".join(re.escape(p) for p in sorted_phrases),
            re.IGNORECASE,
        )
        while True:
            m = pattern.search(text)
            if not m:
                break
            start, end = m.start(), m.end()
            # Skip any trailing punctuation/whitespace after the phrase
            while end < len(text) and text[end] in ".!?,;: ":
                end += 1
            after = text[end:]
            before = text[:start].rstrip()
            # Remove back to the last sentence boundary (. ! ?)
            # or the start of the text
            last_period = max(before.rfind(". "), before.rfind("! "), before.rfind("? "))
            if last_period >= 0:
                before = before[:last_period + 1]
            else:
                before = ""
            text = (before + " " + after).strip() if before and after else (before + after).strip()
        return text

    def _transcribe_and_paste(audio_path: str):
        try:
            _log("Transcribing...")
            text = transcriber.transcribe(audio_path)
        except Exception as exc:
            _log(f"Transcription error: {exc}")
            _beep(220, 300)
            return
        finally:
            try:
                os.unlink(audio_path)
            except OSError:
                pass
            overlay.hide()
            state["busy"] = False

        if not text or not text.strip():
            _log("No text returned")
            _beep(220, 300)
            return

        text = text.strip()
        _log(f"Transcribed ({len(text)} chars): {text[:120]}")

        # Process undo phrase — remove the sentence before each occurrence
        if undo_phrases and text:
            text = _apply_undo_phrases(text)
            _log(f"After undo processing ({len(text)} chars): {text[:120]}")

        # Check for auto-send keyword at the end
        # Strip apostrophes/punctuation for fuzzy matching
        # so "Let's go" matches keyword "lets go"
        def _normalize(s: str) -> str:
            return s.lower().replace("'", "").replace("\u2019", "").rstrip(".!?,;: ")

        should_send = False
        if auto_send_keywords:
            norm = _normalize(text)
            for kw in auto_send_keywords:
                if norm.endswith(kw):
                    # Find where the keyword starts in the original text
                    # by counting characters from the end (ignoring trailing punct)
                    stripped = text.rstrip(".!?,;: ''\u2019")
                    # Remove len(kw) worth of normalized chars from the end
                    cut = len(stripped)
                    norm_count = 0
                    while norm_count < len(kw) and cut > 0:
                        cut -= 1
                        ch = stripped[cut].lower()
                        if ch not in ("'", "\u2019"):
                            norm_count += 1
                    text = stripped[:cut].rstrip()
                    should_send = True
                    _log(f"Auto-send keyword '{kw}' detected")
                    break

        # Paste via pynput Controller. Ctrl+V on Windows/Linux, Cmd+V on macOS.
        # NB: unlike the legacy `keyboard` lib, pynput cannot "suppress" the
        # trigger key from reaching the focused app on Windows. For
        # modifier+letter bindings (alt+q, ctrl+shift+v) this is usually
        # harmless — the modifier alone doesn't produce input.
        try:
            import pyperclip
            controller = pkb.Controller()
            paste_modifier = pkb.Key.cmd if sys.platform == "darwin" else pkb.Key.ctrl
            if text:
                # When auto-pasting, snapshot the user's clipboard and restore
                # it after the paste completes — otherwise every hotkey fire
                # silently wipes whatever they had copied. pyperclip only
                # reads text; when the clipboard held an image or other
                # non-text format, paste() returns "" AND our subsequent
                # copy(text) has already overwritten that content (pyperclip
                # wipes all formats before writing). So once the paste is
                # done, restoring "" by copy("") clears the voice text —
                # leaving an empty clipboard behind instead of the transcript
                # leaking into the user's next paste.
                prior_clipboard = None
                snapshot_ok = False
                if auto_paste:
                    try:
                        prior_clipboard = pyperclip.paste()
                        snapshot_ok = True
                    except Exception as exc:
                        _log(f"Could not read prior clipboard (won't restore): {exc}")

                pyperclip.copy(text)
                if auto_paste:
                    time.sleep(0.05)
                    with controller.pressed(paste_modifier):
                        controller.press("v")
                        controller.release("v")
                    # Wait long enough for the focused app to consume the paste
                    # before restoring the prior clipboard — otherwise the app
                    # races and pastes the restored value instead.
                    time.sleep(0.15)
                    # Only restore when the snapshot succeeded. When it
                    # failed we'd be writing an uninitialised value, so
                    # leave the clipboard alone (fail-safe). When the
                    # prior matches `text` there's nothing to restore.
                    if snapshot_ok and prior_clipboard != text:
                        try:
                            pyperclip.copy(prior_clipboard)
                        except Exception as exc:
                            _log(f"Could not restore prior clipboard: {exc}")
            if should_send:
                time.sleep(0.3)
                controller.press(pkb.Key.enter)
                controller.release(pkb.Key.enter)
        except Exception as exc:
            _log(f"Paste error: {exc}")
            _beep(220, 300)
            return

        _beep(660, 100)
        time.sleep(0.06)
        _beep(660, 100)

    # ---- register and block ---- #

    try:
        modifier_groups, trigger = parse_binding(binding)
    except Exception as exc:
        _log(f"Failed to parse hotkey binding {binding!r}: {exc}")
        return

    held: set = set()
    last_fire = [0.0]            # mutable cell for toggle-debounce timestamp
    trigger_armed = [False]      # hold-mode: True between press and release

    def _is_trigger(key) -> bool:
        # KeyCode equality is char-based; Key equality handles the named ones.
        return key == trigger

    def _on_press(key):
        try:
            held.add(key)
            if not _is_trigger(key):
                return
            if not modifiers_satisfied(held, modifier_groups):
                return

            if mode == "hold":
                if trigger_armed[0]:
                    return  # auto-repeat while held
                trigger_armed[0] = True
                on_hold_press()
            else:
                now = time.monotonic()
                if now - last_fire[0] < 0.25:
                    return  # debounce auto-repeat
                last_fire[0] = now
                on_hotkey()
        except Exception as exc:
            _log(f"Hotkey press handler error: {exc}")

    def _on_release(key):
        try:
            held.discard(key)
            if mode == "hold" and _is_trigger(key) and trigger_armed[0]:
                trigger_armed[0] = False
                on_hold_release(key)
        except Exception as exc:
            _log(f"Hotkey release handler error: {exc}")

    try:
        listener = pkb.Listener(on_press=_on_press, on_release=_on_release)
        listener.start()
    except Exception as exc:
        _log(f"Failed to start hotkey listener: {exc}")
        if sys.platform == "darwin":
            _log("NOTE: On macOS, Dock needs Accessibility permission. "
                 "Grant it in System Settings → Privacy & Security → Accessibility.")
        return

    _log(f"Hotkey [{binding}] active ({mode} mode, scope={scope}) — waiting for input")

    try:
        listener.join()
    except KeyboardInterrupt:
        pass
    finally:
        try:
            listener.stop()
        except Exception:
            pass

    _log("Daemon exiting")


if __name__ == "__main__":
    main()
