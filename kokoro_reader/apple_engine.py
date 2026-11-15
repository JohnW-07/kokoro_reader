"""Siri natural voices as a second TTS engine — a dev switch, not a supported path.

Voices named `siri_*` are rendered by AVSpeechSynthesizer through `apple_host.swift`, run
by the Apple-signed `swift` interpreter: macOS hides the Siri voices from ad-hoc-signed
binaries, so a compiled helper cannot see them. Apple can close that door in any update.
Research and measurements: docs/10-voice-quality-research.md, ~/local/apple-tts-lab.

`AppleModel` duck-types the Kokoro model, so `TTSEngine` supplies the cache, chunking,
silence trim and admission control unchanged. The host process starts on first use and
holds ~740 MB; it exits when the server does (its stdin closes).
"""

from __future__ import annotations

import json
import subprocess
import tempfile
import threading
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Sequence

import numpy as np
import soundfile as sf

from kokoro_reader import voiceshape
from kokoro_reader.tts_engine import TTSEngine, TTSError, TTSVoiceUnavailable

MODEL_ID = "apple-siri"       # part of the cache key, so Siri audio never collides with Kokoro's
SIRI_PREFIX = "siri_"
SIRI_VOICES = {"siri_nora": "com.apple.siri.natural.Nora"}   # "Voice 4"; Voice 6 is not exposed
HOST_CMD = ("swift", "-O", str(Path(__file__).with_name("apple_host.swift")), "serve")
TMP_PREFIX = "kokoro-siri-"
#: How apple_host.swift says AVSpeechSynthesisVoice(identifier:) found nothing (R6).
UNKNOWN_VOICE_ERROR = "unknown voice:"

#: (playback speed, AVSpeechUtterance.rate). Measured 2026-10-06 on Nora with one 390-char
#: paragraph, as duration at rate 0.5 / duration at each rate. The curve has a knee at the
#: default 0.5, and Siri cannot go slower than ~0.56×, so speeds below that clamp to rate 0.
SPEED_TO_RATE: tuple[tuple[float, float], ...] = (
    (0.562, 0.0), (0.652, 0.1), (0.732, 0.2), (0.822, 0.3), (0.913, 0.4), (0.953, 0.45),
    (1.0, 0.5), (1.108, 0.52), (1.297, 0.55), (1.467, 0.58), (1.590, 0.6), (1.883, 0.65),
    (2.186, 0.7),
)


def is_siri_voice(voice: str) -> bool:
    return voice.startswith(SIRI_PREFIX)


def rate_for_speed(speed: float) -> float:
    speeds, rates = zip(*SPEED_TO_RATE)
    return float(np.interp(speed, speeds, rates))


class SwiftHost:
    """One persistent `apple_host.swift serve` process; JSON lines over its pipes.

    Requests are serialised: the host renders one utterance at a time. A host that dies
    fails the request in hand and is restarted on the next one.
    """

    def __init__(self, cmd: Sequence[str] = HOST_CMD) -> None:
        self._cmd = tuple(cmd)
        self._proc: subprocess.Popen[str] | None = None
        self._lock = threading.Lock()

    def ask(self, request: dict[str, Any]) -> dict[str, Any]:
        with self._lock:
            proc = self._running()
            try:
                proc.stdin.write(json.dumps(request) + "\n")
                proc.stdin.flush()
                line = proc.stdout.readline()
            except OSError:            # broken pipe: the host died mid-request
                line = ""
                proc.kill()
            if not line:
                code = proc.wait()
                self._proc = None
                raise TTSError(f"Siri host exited (code {code})")
            return json.loads(line)

    def close(self) -> None:
        with self._lock:
            if self._proc is not None:
                self._proc.stdin.close()
                self._proc.wait(timeout=30)
                self._proc = None

    def _running(self) -> subprocess.Popen[str]:
        if self._proc is None or self._proc.poll() is not None:
            try:
                self._proc = subprocess.Popen(
                    self._cmd, stdin=subprocess.PIPE, stdout=subprocess.PIPE, text=True, bufsize=1
                )  # stderr inherited: a Swift compile error lands in the server log
            except OSError as exc:
                raise TTSVoiceUnavailable(f"Siri voices need macOS with swift installed: {exc}") from exc
        return self._proc


@dataclass(frozen=True)
class AppleResult:
    audio: np.ndarray
    sample_rate: int


class AppleModel:
    """The slice of the Kokoro model interface that `TTSEngine` uses."""

    def __init__(self, host: Any | None = None) -> None:
        self._host = host if host is not None else SwiftHost()

    def list_voices(self) -> list[str]:
        return list(SIRI_VOICES)

    def generate(self, text: str, voice: str, speed: float = 1.0, sample_rate: int | None = None) -> AppleResult:
        """Render `text`, shaped by the thread's voice shape (V2). `sample_rate` is ignored:
        Siri renders at its own rate (48 kHz)."""
        voice_id = SIRI_VOICES.get(voice)
        if voice_id is None:
            raise TTSError(f"unknown Siri voice {voice!r}")
        with tempfile.TemporaryDirectory(prefix=TMP_PREFIX) as tmp:
            out = Path(tmp) / "out.wav"
            reply = self._host.ask({"voice": voice_id, "text": text, "out": str(out), "rate": rate_for_speed(speed)})
            if not reply.get("ok"):
                error = str(reply.get("error", "unknown error"))
                if error.startswith(UNKNOWN_VOICE_ERROR):
                    raise TTSVoiceUnavailable(f"the Siri voice {voice!r} is not installed on this Mac ({error})")
                raise TTSError(f"Siri synthesis failed: {error}")
            audio, rate = sf.read(str(out), dtype="float32", always_2d=True)
        mono = audio.mean(axis=1)
        return AppleResult(audio=voiceshape.shape_audio(mono, int(rate), voiceshape.current()), sample_rate=int(rate))


_engine: TTSEngine | None = None
_engine_lock = threading.Lock()


def get_apple_engine() -> TTSEngine:
    """Process-wide singleton; the host process starts on the first Siri request."""
    global _engine
    if _engine is None:
        with _engine_lock:
            if _engine is None:
                _engine = TTSEngine(model_id=MODEL_ID, loader=lambda _model_id: AppleModel())
    return _engine
