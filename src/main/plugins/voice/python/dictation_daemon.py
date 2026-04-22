#!/usr/bin/env python3
"""Persistent dictation daemon for the Coordinator Speak button.

Loads the VoiceRecorder + transcriber ONCE at startup so repeated
start/stop cycles don't pay the faster-whisper model-load cost every
time (10-20 seconds with large-v3; 2-5 seconds even for base).

Protocol (stdin -> stdout, one JSON line per exchange):

  parent: "start\\n"   -> {"started": true}  | {"error": "..."}
  parent: "stop\\n"    -> {"text": "..."}    | {"error": "..."}
  parent: "cancel\\n"  -> {"cancelled": true}| {"error": "..."}
  parent: "shutdown\\n" (no response; process exits)

On startup: {"ready": true} once recorder+transcriber init succeed,
            {"fatal": "..."} + non-zero exit otherwise.

Argv:
  1: base64-encoded JSON with {"recording": {...}, "transcriber": {...}}
     — same shape as VoiceConfig.recording / .transcriber.
"""

import base64
import json
import os
import sys


def _emit(obj: dict) -> None:
    sys.stdout.write(json.dumps(obj) + "\n")
    sys.stdout.flush()


def _log(msg: str) -> None:
    sys.stderr.write(f"[dictation-daemon] {msg}\n")
    sys.stderr.flush()


def main() -> int:
    if len(sys.argv) < 2:
        _emit({"fatal": "missing config argv"})
        return 1

    try:
        cfg = json.loads(base64.b64decode(sys.argv[1]).decode("utf-8"))
    except Exception as exc:
        _emit({"fatal": f"config parse failed: {exc}"})
        return 1

    script_dir = os.path.dirname(os.path.abspath(__file__))
    if script_dir not in sys.path:
        sys.path.insert(0, script_dir)

    try:
        from src.recorder import VoiceRecorder
        from src.transcriber import create_transcriber
    except Exception as exc:
        _emit({"fatal": f"import failed: {exc}"})
        return 1

    # Log the resolved recording config before instantiating the recorder so
    # "daemon sees input_device=null" is obvious in the Dock log even when
    # VoiceRecorder's later logs are clipped.
    _log(
        f"recording config: input_device={cfg['recording'].get('input_device')!r} "
        f"sample_rate={cfg['recording'].get('sample_rate')} "
        f"channels={cfg['recording'].get('channels')}"
    )
    try:
        rec = VoiceRecorder(
            sample_rate=cfg["recording"]["sample_rate"],
            channels=cfg["recording"]["channels"],
            speech_threshold=cfg["recording"]["speech_threshold"],
            device=cfg["recording"].get("input_device"),
        )
        trans = create_transcriber(cfg["transcriber"])
    except Exception as exc:
        _emit({"fatal": f"init failed: {exc}"})
        return 1

    _log(f"ready (backend: {trans.name})")
    _emit({"ready": True})

    recording = False
    for raw in sys.stdin:
        cmd = raw.strip()
        if not cmd:
            continue
        if cmd == "shutdown":
            _log("shutdown")
            break

        if cmd == "start":
            if recording:
                _emit({"error": "already recording"})
                continue
            try:
                rec.start()
            except Exception as exc:
                _emit({"error": f"start failed: {exc}"})
                continue
            recording = True
            _emit({"started": True})
            continue

        if cmd in ("stop", "cancel"):
            if not recording:
                _emit({"error": "not recording"})
                continue
            try:
                audio = rec.stop()
            except Exception as exc:
                recording = False
                _emit({"error": f"stop failed: {exc}"})
                continue
            recording = False

            if cmd == "cancel":
                if audio:
                    try:
                        os.unlink(audio)
                    except OSError:
                        pass
                _emit({"cancelled": True})
                continue

            # stop: transcribe. `rec.stop()` returns None for zero frames OR
            # when the captured buffer is pure silence — the latter is a
            # strong signal that the selected device isn't feeding audio.
            if not audio:
                _emit({
                    "error": (
                        "No audio was captured. The selected microphone "
                        "produced silence — try a different device (prefer "
                        "the WASAPI variant on Windows). See voice logs for "
                        "the resolved device details."
                    )
                })
                continue
            try:
                text = trans.transcribe(audio)
            except Exception as exc:
                try:
                    os.unlink(audio)
                except OSError:
                    pass
                _emit({"error": f"transcribe failed: {exc}"})
                continue
            try:
                os.unlink(audio)
            except OSError:
                pass
            _emit({"text": (text or "").strip()})
            continue

        _emit({"error": f"unknown command: {cmd}"})

    # Tidy up if we exit mid-recording (stdin closed, daemon told to shutdown).
    if recording:
        try:
            audio = rec.stop()
            if audio:
                try:
                    os.unlink(audio)
                except OSError:
                    pass
        except Exception:
            pass

    return 0


if __name__ == "__main__":
    sys.exit(main())
