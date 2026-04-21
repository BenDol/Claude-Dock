"""Audio recording with manual toggle and auto-stop modes."""

import os
import tempfile
import threading
import time
import wave

import numpy as np
import sounddevice as sd

from src.audio_feedback import beep as _beep


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
        # sounddevice accepts None (system default), an int index, or a
        # substring match against the device name. Dock passes the user's
        # choice straight through — empty strings mean "system default".
        self.device = device if device not in ("", None) else None
        self._frames: list[np.ndarray] = []
        self._stream: sd.InputStream | None = None
        self._is_recording = False

    # ---- manual toggle ------------------------------------------------ #

    def start(self):
        """Begin recording (call ``stop()`` later to finish)."""
        self._frames = []
        self._is_recording = True
        self._stream = sd.InputStream(
            samplerate=self.sample_rate,
            channels=self.channels,
            dtype="int16",
            callback=self._toggle_cb,
            blocksize=1024,
            device=self.device,
        )
        self._stream.start()

    def _toggle_cb(self, indata, frame_count, time_info, status):
        if self._is_recording:
            self._frames.append(indata.copy())
            if self.on_levels:
                self.on_levels(self._compute_bands(indata))

    def stop(self) -> str | None:
        """Stop a toggle-mode recording.  Returns WAV path or None."""
        self._is_recording = False
        if self._stream:
            self._stream.stop()
            self._stream.close()
            self._stream = None

        if not self._frames:
            return None

        audio = np.concatenate(self._frames)
        self._frames = []
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
