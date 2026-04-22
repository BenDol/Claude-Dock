"""Audio recording with manual toggle and auto-stop modes."""

import os
import sys
import tempfile
import threading
import time
import wave

import numpy as np
import sounddevice as sd

from src.audio_feedback import beep as _beep


def _log(msg: str) -> None:
    """Diagnostic logging to stderr (captured by Dock's voice-ipc)."""
    sys.stderr.write(f"[voice-recorder] {msg}\n")
    sys.stderr.flush()


def _describe_device(device) -> str:
    """Build a human-readable line for the selected device.

    sounddevice's device list on Windows contains 4+ entries per physical
    microphone (MME, DirectSound, WASAPI, WDM-KS). Logging the resolved
    entry helps diagnose when users pick a non-WASAPI variant that silently
    produces no audio at our preferred 16 kHz / int16 format.
    """
    try:
        info = sd.query_devices(device, kind="input")
    except Exception as exc:
        return f"device={device!r} (query failed: {exc})"
    host_name = ""
    try:
        host_name = sd.query_hostapis(info.get("hostapi")).get("name", "")
    except Exception:
        pass
    return (
        f"device={device!r} -> name={info.get('name', '?')!r} "
        f"hostApi={host_name!r} "
        f"maxIn={info.get('max_input_channels', '?')} "
        f"defaultSampleRate={info.get('default_samplerate', '?')}"
    )


def _resolve_device(device):
    """Normalize the user's configured device into something sounddevice accepts.

    Returns a tuple ``(resolved, description)`` where ``resolved`` is either
    ``None`` (system default), an int index, or a string to pass through for
    substring matching. ``description`` is a human-readable diagnostic.

    Rules:
      * ``None`` / ``""`` / ``"null"`` / ``"default"``  -> system default.
      * Numeric strings ("13", "  13 ") -> int (avoids accidental substring
        matching against a similarly-named device).
      * Other strings (device-name substrings) -> kept as-is. If we find
        zero or multiple matching input devices we raise, rather than silently
        letting sounddevice pick one — a bug disguised as "always uses
        system default" when a saved substring accidentally matches several
        devices (the first match wins, which can be the default mic).
    """
    if device is None:
        return None, "system default (device=None)"
    if isinstance(device, bool):
        # Defensive: bool is a subclass of int in Python, don't let it slip
        # through as an index (True -> index 1, almost certainly wrong).
        return None, f"system default (ignoring bool device={device!r})"
    if isinstance(device, str):
        stripped = device.strip()
        if stripped == "" or stripped.lower() in ("null", "none", "default"):
            return None, f"system default (empty/sentinel string {device!r})"
        # Numeric-looking strings come from careless JSON or old configs;
        # coerce so substring matching doesn't kick in for what the user
        # clearly meant as an index.
        try:
            return int(stripped), f"coerced string {device!r} to int index"
        except ValueError:
            pass
        # Real substring. Validate match count to avoid "first match wins" foot-gun.
        needle = stripped.lower()
        matches = []
        try:
            for i, d in enumerate(sd.query_devices()):
                if int(d.get("max_input_channels", 0)) <= 0:
                    continue
                if needle in str(d.get("name", "")).lower():
                    matches.append((i, d.get("name", "")))
        except Exception as exc:
            return stripped, (
                f"substring {device!r} (could not pre-validate: {exc})"
            )
        if not matches:
            raise ValueError(
                f"Input device substring {device!r} matched no input devices. "
                "Clear the selection in Voice settings or pick a different mic."
            )
        if len(matches) > 1:
            names = ", ".join(f"#{i} {n!r}" for i, n in matches)
            raise ValueError(
                f"Input device substring {device!r} is ambiguous — matched {len(matches)} devices: "
                f"{names}. Pick a specific device from the list in Voice settings."
            )
        idx, name = matches[0]
        return idx, f"resolved substring {device!r} -> index {idx} ({name!r})"
    # Int (or numpy int, etc.) — pass through.
    try:
        return int(device), f"int index {int(device)}"
    except Exception:
        return device, f"unknown type {type(device).__name__}: {device!r}"


def describe_system_default_input() -> str:
    """One-line summary of sounddevice's current default input device.

    Logged at daemon startup so the user can compare the device they *expect*
    to be used against what sounddevice thinks the default is — helpful when
    diagnosing "it always uses the system default" complaints.
    """
    try:
        default = sd.default.device
        default_in = default[0] if isinstance(default, (list, tuple)) else default
    except Exception as exc:
        return f"(sd.default.device read failed: {exc})"
    if default_in is None:
        return "(no system default input configured)"
    return f"sd.default.device.input={default_in!r} -> {_describe_device(default_in)}"


class VoiceRecorder:
    """Records microphone audio in two modes:

    * **Manual toggle** – ``start()`` / ``stop()``  (hotkey daemon)
    * **Auto-stop**     – ``record_until_silence()`` (MCP tool)
    """

    NUM_BANDS = 7  # match overlay bar count

    def __init__(
        self,
        sample_rate: int = 16000,
        channels: int = 1,
        speech_threshold: float = 500,
        on_levels=None,
        device=None,
    ):
        self.sample_rate = sample_rate
        self.channels = channels
        self.speech_threshold = speech_threshold
        self.on_levels = on_levels  # callback(levels: list[float])
        # Normalize the user's configured device via `_resolve_device` —
        # coerces numeric strings to indices, validates substring matches,
        # and surfaces the resolution details so "always uses system
        # default" bugs are immediately visible in the log.
        self._raw_device = device
        try:
            self.device, reason = _resolve_device(device)
        except Exception as exc:
            # Surface the failure loudly in the log AND as a stored error
            # so start() re-raises (don't silently drop back to default).
            _log(f"device resolution failed (raw={device!r}): {exc}")
            self.device = None
            self._device_resolution_error = str(exc)
            reason = f"UNRESOLVED (will fail on start): {exc}"
        else:
            self._device_resolution_error = None
        _log(
            f"init: raw_device={device!r} -> resolved={self.device!r} "
            f"({reason}); {_describe_device(self.device)}; "
            f"default: {describe_system_default_input()}"
        )
        self._frames: list[np.ndarray] = []
        self._stream: sd.InputStream | None = None
        self._is_recording = False

    # ---- manual toggle ------------------------------------------------ #

    def start(self):
        """Begin recording (call ``stop()`` later to finish).

        Pre-validates device + format via :func:`sounddevice.check_input_settings`
        so a mismatched config (common on Windows when the user picks an MME
        variant of a device that only supports 44.1/48 kHz) surfaces as a
        clear ``PortAudioError`` instead of silently opening a stream that
        captures nothing.
        """
        if self._device_resolution_error:
            # Bubble the resolution failure here rather than silently using
            # the system default — matches the user's selection intent.
            raise sd.PortAudioError(
                f"Cannot start recording: {self._device_resolution_error}"
            )
        self._frames = []
        self._is_recording = True
        _log(
            f"start requested: samplerate={self.sample_rate} channels={self.channels} "
            f"dtype=int16 {_describe_device(self.device)}"
        )
        try:
            sd.check_input_settings(
                device=self.device,
                channels=self.channels,
                samplerate=self.sample_rate,
                dtype="int16",
            )
        except Exception as exc:
            _log(f"check_input_settings failed: {exc}")
            # Re-raise with a message that names the device so the UI error
            # tells the user *which* selection is incompatible.
            raise sd.PortAudioError(
                f"Device rejected format (samplerate={self.sample_rate}, "
                f"channels={self.channels}, int16): {exc}"
            ) from exc
        self._stream = sd.InputStream(
            samplerate=self.sample_rate,
            channels=self.channels,
            dtype="int16",
            callback=self._toggle_cb,
            blocksize=1024,
            device=self.device,
        )
        self._stream.start()
        # After the stream is live, cross-check what PortAudio actually opened
        # against what the user asked for. On Windows the device index +
        # host-API are the source of truth; logging the resolved stream's
        # device lets us see if the kernel substituted something (rare but
        # does happen with exclusive-mode WDM-KS devices).
        try:
            opened_device = getattr(self._stream, "device", None)
            _log(
                f"stream started: requested_device={self.device!r} "
                f"opened_device={opened_device!r} "
                f"samplerate={getattr(self._stream, 'samplerate', '?')} "
                f"channels={getattr(self._stream, 'channels', '?')}"
            )
        except Exception as exc:
            _log(f"could not read stream device info: {exc}")

    def _toggle_cb(self, indata, frame_count, time_info, status):
        if self._is_recording:
            self._frames.append(indata.copy())
            if self.on_levels:
                self.on_levels(self._compute_bands(indata))

    def stop(self) -> str | None:
        """Stop a toggle-mode recording.  Returns WAV path or None.

        Returns ``None`` if the stream produced zero frames *or* produced
        only silence (peak amplitude == 0). A silent capture almost always
        means the selected device isn't actually feeding audio into the
        stream — a known failure mode on Windows when the wrong hostAPI
        variant of a mic is picked.
        """
        self._is_recording = False
        if self._stream:
            self._stream.stop()
            self._stream.close()
            self._stream = None

        if not self._frames:
            _log("stop: no frames captured")
            return None

        audio = np.concatenate(self._frames)
        self._frames = []
        peak = int(np.max(np.abs(audio))) if audio.size else 0
        _log(f"stop: captured {audio.shape[0]} samples, peak={peak}")
        if peak == 0:
            _log(
                "stop: peak amplitude is zero — selected device produced "
                "no audio; check that the correct microphone (preferably "
                "the WASAPI variant on Windows) is selected"
            )
            return None
        return self._save_wav(audio)

    def get_tail_wav(self, seconds: float = 3.0) -> str | None:
        """Save the last N seconds of buffered audio to a temp WAV. Non-destructive."""
        if not self._frames:
            return None
        samples_needed = int(self.sample_rate * seconds)
        # Concatenate from the end
        tail_frames = []
        total = 0
        for frame in reversed(self._frames):
            tail_frames.insert(0, frame)
            total += len(frame)
            if total >= samples_needed:
                break
        audio = np.concatenate(tail_frames)[-samples_needed:]
        return self._save_wav(audio)

    # ---- auto-stop (silence detection) -------------------------------- #

    def record_until_silence(
        self,
        max_seconds: float = 30,
        silence_timeout: float = 2.0,
        log_fn=None,
    ) -> str | None:
        """Record until speech is followed by silence.  Returns WAV path."""
        frames: list[np.ndarray] = []
        speech_started = False
        speech_start_time = 0.0
        last_speech_time = 0.0
        start_time = time.time()
        done = threading.Event()

        def callback(indata, frame_count, time_info, status):
            nonlocal speech_started, speech_start_time, last_speech_time
            frames.append(indata.copy())
            rms = np.sqrt(np.mean(indata.astype(np.float32) ** 2))
            now = time.time()

            if rms > self.speech_threshold:
                if not speech_started:
                    speech_started = True
                    speech_start_time = now
                last_speech_time = now

            if (now - start_time) >= max_seconds:
                done.set()
            elif speech_started:
                if (
                    (now - speech_start_time) > 0.5
                    and (now - last_speech_time) > silence_timeout
                ):
                    done.set()

        _beep(880, 150)

        if log_fn:
            log_fn("Listening... speak now")

        with sd.InputStream(
            samplerate=self.sample_rate,
            channels=self.channels,
            dtype="int16",
            callback=callback,
            blocksize=1024,
            device=self.device,
        ):
            while not done.is_set():
                done.wait(timeout=0.3)
                if log_fn:
                    elapsed = time.time() - start_time
                    if speech_started:
                        log_fn(f"Recording... {elapsed:.0f}s")
                    else:
                        log_fn(f"Waiting for speech... {elapsed:.0f}s")

        _beep(440, 200)

        if not frames or not speech_started:
            return None

        return self._save_wav(np.concatenate(frames))

    # ---- audio analysis ------------------------------------------------- #

    def _compute_bands(self, indata: np.ndarray) -> list[float]:
        """Compute frequency band levels (0.0–1.0) for the visualizer."""
        audio = indata[:, 0].astype(np.float32) if indata.ndim > 1 else indata.astype(np.float32)
        n = len(audio)
        if n < 2:
            return [0.0] * self.NUM_BANDS

        # Noise gate: suppress visualizer for ambient noise below speech threshold
        rms = np.sqrt(np.mean(audio ** 2))
        if rms < self.speech_threshold:
            return [0.0] * self.NUM_BANDS

        # FFT magnitude spectrum (positive frequencies only)
        fft = np.abs(np.fft.rfft(audio))
        freqs = np.fft.rfftfreq(n, d=1.0 / self.sample_rate)

        # Split into bands (logarithmic spacing for natural feel)
        band_edges = np.logspace(
            np.log10(80), np.log10(min(7500, self.sample_rate / 2)),
            self.NUM_BANDS + 1,
        )

        levels = []
        for i in range(self.NUM_BANDS):
            mask = (freqs >= band_edges[i]) & (freqs < band_edges[i + 1])
            if mask.any():
                band_power = np.mean(fft[mask])
                # Normalize: log scale, clamped to 0–1
                db = 20 * np.log10(max(band_power, 1e-10)) - 20
                level = max(0.0, min(1.0, (db + 10) / 50))
            else:
                level = 0.0
            levels.append(level)

        return levels

    # ---- helpers ------------------------------------------------------ #

    def _save_wav(self, audio_data: np.ndarray) -> str:
        fd, path = tempfile.mkstemp(suffix=".wav")
        os.close(fd)
        with wave.open(path, "wb") as wf:
            wf.setnchannels(self.channels)
            wf.setsampwidth(2)
            wf.setframerate(self.sample_rate)
            wf.writeframes(audio_data.tobytes())
        return path

    @staticmethod
    def list_devices() -> str:
        return str(sd.query_devices())
