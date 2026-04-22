"""Pluggable speech-to-text backends."""

import json
import os
import sys
import wave

import numpy as np

from abc import ABC, abstractmethod

# Sentinel the Dock main process watches for on the daemon's stderr so it
# can surface structured warnings in the UI (e.g. CUDA→CPU fallback). Keep
# in sync with voice-server-manager.ts parseWarning().
_VOICE_WARNING_PREFIX = "__VOICE_WARNING__:"


def _emit_warning(kind: str, message: str, **extra) -> None:
    """Print a parseable warning line to stderr for Dock to pick up.

    We avoid the `warnings` module so the message bypasses user-configured
    filters and lands on stderr, which Dock already forwards to the app log
    and watches for the VOICE_WARNING sentinel.

    `default=str` stringifies non-serializable extras (Path objects,
    exceptions, etc.) so a single bad value can't silently drop the entire
    warning.
    """
    payload = {"kind": kind, "message": message}
    payload.update(extra)
    try:
        sys.stderr.write(_VOICE_WARNING_PREFIX + json.dumps(payload, default=str) + "\n")
        sys.stderr.flush()
    except Exception:
        # Never let a logging failure interfere with transcription.
        pass


class Transcriber(ABC):
    """Base class -- subclass to add a new STT backend."""

    @property
    @abstractmethod
    def name(self) -> str:
        """Human-readable backend name."""

    @abstractmethod
    def transcribe(self, audio_path: str) -> str:
        """Transcribe a WAV file and return the text."""


# ---------- OpenAI Whisper API (remote) ---------- #


class OpenAIWhisperAPI(Transcriber):
    def __init__(self, api_key: str = "", model: str = "whisper-1"):
        self._api_key = api_key or os.environ.get("OPENAI_API_KEY", "")
        self._model = model

    @property
    def name(self) -> str:
        return "OpenAI Whisper API"

    def transcribe(self, audio_path: str) -> str:
        if not self._api_key:
            raise ValueError(
                "OpenAI API key not configured. "
                "Set OPENAI_API_KEY env var or add it to config.json"
            )
        from openai import OpenAI

        client = OpenAI(api_key=self._api_key)
        with open(audio_path, "rb") as f:
            result = client.audio.transcriptions.create(model=self._model, file=f)
        return result.text


# ---------- Faster-Whisper (local) ---------- #


class FasterWhisperLocal(Transcriber):
    def __init__(
        self,
        model_size: str = "base",
        device: str = "auto",
        compute_type: str = "default",
        preload: bool = False,
        vad_filter: bool = True,
        beam_size: int = 1,
        language: str = "en",
        without_timestamps: bool = True,
        temperature: float = 0.0,
        trim_silence: bool = True,
        trim_threshold: int = 300,
    ):
        self._model_size = model_size
        self._device = device
        self._compute_type = compute_type
        self._vad_filter = vad_filter
        self._beam_size = beam_size
        self._language = language or None
        self._without_timestamps = without_timestamps
        self._temperature = temperature
        self._trim_silence = trim_silence
        self._trim_threshold = trim_threshold
        self._model = None
        if preload:
            self._ensure_model()

    def _ensure_model(self):
        if self._model is not None:
            return
        # Register nvidia-cublas-cu12 / nvidia-cudnn-cu12 DLL directories
        # BEFORE importing faster_whisper — ctranslate2's shared-library load
        # happens at import time, and on Python 3.8+ Windows PATH is not
        # consulted for dynamic loads. A no-op when the nvidia packages
        # aren't installed (user is on the CPU-only path).
        try:
            from .cuda_setup import setup_cuda_dll_paths
            setup_cuda_dll_paths()
        except ImportError:
            # cuda_setup module missing — older venv layout. Not fatal on CPU.
            pass

        try:
            from faster_whisper import WhisperModel
        except ImportError:
            raise ImportError(
                "faster-whisper is not installed.  Run:  pip install faster-whisper"
            )
        # `device='auto'` (and 'cuda') asks ctranslate2 to load CUDA libraries
        # eagerly. On boxes without CUDA installed this throws
        # "Library cublas64_12.dll is not found" — fall back to CPU
        # automatically so a missing GPU is a soft downgrade, but emit a
        # structured warning so the UI can tell the user it's happening
        # instead of pretending CUDA worked.
        try:
            self._model = WhisperModel(
                self._model_size,
                device=self._device,
                compute_type=self._compute_type,
            )
        except Exception as e:  # noqa: BLE001 — ctranslate2 raises generic RuntimeError
            msg = str(e)
            requested_device = self._device
            requested_compute = self._compute_type
            # Broad substring match covers the common ctranslate2 / CUDA failure
            # modes: library-not-found for cuBLAS / cuDNN, "CUDA driver" / NVML
            # errors when the driver is absent or mismatched, and "no GPU
            # available" when ctranslate2 can't see any device.
            msg_lower = msg.lower()
            is_cuda_failure = (
                requested_device != "cpu"
                and (
                    "cublas" in msg_lower
                    or "cuda" in msg_lower
                    or "cudnn" in msg_lower
                    or "gpu" in msg_lower
                    or "driver" in msg_lower
                    or "nvml" in msg_lower
                )
            )
            if is_cuda_failure:
                # CPU-only fallback — int8 is the safe compute_type for CPU.
                _emit_warning(
                    "cuda_fallback",
                    (
                        f"CUDA unavailable ({msg.strip() or type(e).__name__}). "
                        "Falling back to CPU transcription — install GPU "
                        "acceleration from the Transcriber settings to use "
                        "'cuda'."
                    ),
                    requested_device=requested_device,
                    requested_compute_type=requested_compute,
                    fallback_device="cpu",
                    fallback_compute_type="int8",
                )
                self._device = "cpu"
                self._compute_type = "int8"
                self._model = WhisperModel(
                    self._model_size,
                    device=self._device,
                    compute_type=self._compute_type,
                )
            else:
                raise

    @property
    def name(self) -> str:
        return f"Faster Whisper (local, {self._model_size}, {self._compute_type})"

    def transcribe(self, audio_path: str) -> str:
        self._ensure_model()
        path = self._trim(audio_path) if self._trim_silence else audio_path
        segments, _ = self._model.transcribe(
            path,
            beam_size=self._beam_size,
            language=self._language,
            without_timestamps=self._without_timestamps,
            temperature=self._temperature,
            vad_filter=self._vad_filter,
            vad_parameters={"min_silence_duration_ms": 500},
        )
        text = " ".join(seg.text.strip() for seg in segments)
        if path != audio_path:
            try:
                os.unlink(path)
            except OSError:
                pass
        return text

    def _trim(self, audio_path: str) -> str:
        """Trim leading/trailing silence from a WAV file."""
        try:
            with wave.open(audio_path, "rb") as wf:
                frames = wf.readframes(wf.getnframes())
                sr = wf.getframerate()
                ch = wf.getnchannels()
            audio = np.frombuffer(frames, dtype=np.int16)
            # Find first and last sample above threshold
            abs_audio = np.abs(audio)
            window = sr // 10  # 100ms window
            if len(abs_audio) < window:
                return audio_path
            # Rolling RMS over windows
            energy = np.array([
                np.sqrt(np.mean(abs_audio[i:i + window].astype(np.float32) ** 2))
                for i in range(0, len(abs_audio) - window, window)
            ])
            above = np.where(energy > self._trim_threshold)[0]
            if len(above) == 0:
                return audio_path
            start = max(0, above[0] * window - sr // 4)  # 250ms padding
            end = min(len(audio), (above[-1] + 1) * window + sr // 4)
            trimmed = audio[start:end]
            import tempfile
            fd, path = tempfile.mkstemp(suffix=".wav")
            os.close(fd)
            with wave.open(path, "wb") as wf:
                wf.setnchannels(ch)
                wf.setsampwidth(2)
                wf.setframerate(sr)
                wf.writeframes(trimmed.tobytes())
            return path
        except Exception:
            return audio_path


# ---------- Factory ---------- #


def create_transcriber(config: dict) -> Transcriber:
    """Build a Transcriber from the ``transcriber`` config section."""
    backend = config.get("backend", "openai_api")

    if backend == "openai_api":
        s = config.get("openai_api", {})
        return OpenAIWhisperAPI(api_key=s.get("api_key", ""), model=s.get("model", "whisper-1"))

    if backend == "faster_whisper":
        s = config.get("faster_whisper", {})
        return FasterWhisperLocal(
            model_size=s.get("model_size", "base"),
            device=s.get("device", "auto"),
            compute_type=s.get("compute_type", "default"),
            preload=s.get("preload", False),
            vad_filter=s.get("vad_filter", True),
            beam_size=s.get("beam_size", 1),
            language=s.get("language", "en"),
            without_timestamps=s.get("without_timestamps", True),
            temperature=s.get("temperature", 0.0),
            trim_silence=s.get("trim_silence", True),
            trim_threshold=s.get("trim_threshold", 300),
        )

    raise ValueError(f"Unknown transcriber backend: '{backend}'.  Supported: openai_api, faster_whisper")
