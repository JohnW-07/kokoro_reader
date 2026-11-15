"""Siri dev engine: speed mapping, the host pipe protocol, and /api/tts routing.

The real host needs macOS and the Siri voice, so only one test touches it, opt-in:
`KOKORO_LIVE_SIRI=1 pytest tests/test_apple_engine.py`.
"""

from __future__ import annotations

import io
import os
import sys
import textwrap

import numpy as np
import pytest
import soundfile as sf

from kokoro_reader import apple_engine, config, voiceshape
from kokoro_reader.apple_engine import AppleModel, SwiftHost, is_siri_voice, rate_for_speed
from kokoro_reader.routes import tts as tts_routes
from kokoro_reader.tts_engine import TTSEngine, TTSError

HOST_SR = 48_000


class FakeHost:
    """Writes a short 48 kHz stereo WAV where the request asks, like the Swift host."""

    def __init__(self, reply: dict | None = None) -> None:
        self.requests: list[dict] = []
        self._reply = reply

    def ask(self, request: dict) -> dict:
        self.requests = [*self.requests, request]
        if self._reply is not None:
            return self._reply
        tone = 0.1 * np.sin(np.linspace(0, 200, HOST_SR // 10, dtype=np.float32))
        sf.write(request["out"], np.stack([tone, tone], axis=1), HOST_SR, subtype="FLOAT")
        return {"ok": True, "sr": HOST_SR, "audio_s": 0.1}


# ── speed → utterance.rate ────────────────────────────────────────────────────

def test_normal_speed_is_the_avspeech_default_rate() -> None:
    assert rate_for_speed(1.0) == pytest.approx(0.5)


def test_rate_rises_with_speed_and_stays_in_the_measured_range() -> None:
    rates = [rate_for_speed(s) for s in np.arange(0.5, 2.01, 0.05)]
    assert rates == sorted(rates)
    assert rate_for_speed(0.5) == pytest.approx(0.0)       # slowest Siri goes is ~0.56×
    assert rate_for_speed(1.5) == pytest.approx(0.5854, abs=1e-3)   # between (1.467, 0.58) and (1.590, 0.6)
    assert 0.0 <= min(rates) and max(rates) <= 0.7


# ── AppleModel ────────────────────────────────────────────────────────────────

def test_generate_returns_mono_float_audio_at_the_host_rate() -> None:
    host = FakeHost()
    result = AppleModel(host=host).generate("Hello.", voice="siri_nora", speed=1.5, sample_rate=24_000)
    assert result.sample_rate == HOST_SR
    assert result.audio.dtype == np.float32 and result.audio.ndim == 1 and result.audio.size > 0
    (request,) = host.requests
    assert request["voice"] == "com.apple.siri.natural.Nora"
    assert request["rate"] == pytest.approx(rate_for_speed(1.5))
    assert not os.path.exists(request["out"])               # temp WAV cleaned up (D8)


def test_host_failure_is_a_tts_error() -> None:
    model = AppleModel(host=FakeHost(reply={"ok": False, "error": "unknown voice: x"}))
    with pytest.raises(TTSError, match="unknown voice"):
        model.generate("Hello.", voice="siri_nora")


def test_generate_shapes_the_audio_by_the_threads_voice_shape(monkeypatch: pytest.MonkeyPatch) -> None:
    """V2: Siri has no F0 to hook, so the rendered waveform is reshaped instead."""
    calls: list[tuple[int, voiceshape.VoiceShape]] = []
    monkeypatch.setattr(voiceshape, "shape_audio", lambda a, rate, shape: calls.append((rate, shape)) or a)
    shape = voiceshape.VoiceShape(1.1, 1.3)
    with voiceshape.using(shape):
        AppleModel(host=FakeHost()).generate("Hello.", voice="siri_nora")
    assert calls == [(HOST_SR, shape)]


def test_unknown_siri_voice_is_refused_before_the_host_is_asked() -> None:
    host = FakeHost()
    with pytest.raises(TTSError, match="siri_nobody"):
        AppleModel(host=host).generate("Hello.", voice="siri_nobody")
    assert host.requests == []


def test_engine_wraps_the_model_with_cache_chunking_and_padding(tmp_path, monkeypatch) -> None:
    monkeypatch.setattr(config, "AUDIO_CACHE_DIR", tmp_path / "audio")
    host = FakeHost()
    engine = TTSEngine(model_id=apple_engine.MODEL_ID, loader=lambda _id: AppleModel(host=host))
    first = engine.synthesize("Hello.", voice="siri_nora")
    again = engine.synthesize("Hello.", voice="siri_nora")
    assert first == again and len(host.requests) == 1          # second call is a cache hit
    audio, sr = sf.read(io.BytesIO(first))
    assert sr == HOST_SR and audio.size > 0


# ── SwiftHost pipe protocol, driven by a stand-in process ─────────────────────

ECHO_HOST = textwrap.dedent("""
    import json, sys
    for line in sys.stdin:
        req = json.loads(line)
        if req["text"] == "die":
            sys.exit(3)
        print(json.dumps({"ok": True, "echo": req["text"]}), flush=True)
""")


def test_host_answers_one_line_per_request_and_restarts_after_dying() -> None:
    host = SwiftHost(cmd=(sys.executable, "-c", ECHO_HOST))
    try:
        assert host.ask({"text": "one"})["echo"] == "one"
        with pytest.raises(TTSError, match="exited"):
            host.ask({"text": "die"})
        assert host.ask({"text": "two"})["echo"] == "two"      # fresh process
    finally:
        host.close()


def test_missing_toolchain_is_a_readable_tts_error() -> None:
    host = SwiftHost(cmd=("/nonexistent/swift", "serve"))
    with pytest.raises(TTSError, match="swift"):
        host.ask({"text": "x"})


# ── routing ───────────────────────────────────────────────────────────────────

class RecordingEngine:
    def __init__(self, name: str) -> None:
        self.name, self.calls = name, []

    def synthesize(
        self, text: str, voice: str, speed: float = 1.0, pause: str = "", shape: object = None
    ) -> bytes:
        self.calls = [*self.calls, voice]
        return b"RIFF" + self.name.encode()


@pytest.mark.parametrize("voice, expected", [("siri_nora", "siri"), ("af_aoede", "kokoro")])
def test_tts_route_sends_siri_voices_to_the_apple_engine(monkeypatch, voice, expected) -> None:
    from fastapi import FastAPI
    from fastapi.testclient import TestClient

    app = FastAPI()
    app.include_router(tts_routes.router)
    engines = {"kokoro": RecordingEngine("kokoro"), "siri": RecordingEngine("siri")}
    monkeypatch.setattr(tts_routes, "get_engine", lambda: engines["kokoro"])
    monkeypatch.setattr(tts_routes, "get_apple_engine", lambda: engines["siri"])
    response = TestClient(app).get("/api/tts", params={"text": "Hello.", "voice": voice})
    assert response.status_code == 200
    assert engines[expected].calls == [voice]
    assert all(not e.calls for name, e in engines.items() if name != expected)


def test_siri_prefix_detection() -> None:
    assert is_siri_voice("siri_nora") and not is_siri_voice("af_aoede")
    assert tts_routes.VOICE_RE.match("siri_nora")


# ── live (opt-in) ─────────────────────────────────────────────────────────────

@pytest.mark.skipif(os.environ.get("KOKORO_LIVE_SIRI") != "1", reason="needs macOS + Siri voice; opt-in")
def test_live_siri_render() -> None:
    host = SwiftHost()
    try:
        result = AppleModel(host=host).generate("The result is clear.", voice="siri_nora")
    finally:
        host.close()
    assert result.sample_rate == HOST_SR
    assert 0.5 < result.audio.size / result.sample_rate < 5
    assert float(np.abs(result.audio).max()) > 0.05
