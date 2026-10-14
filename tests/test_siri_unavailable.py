"""R6: when macOS no longer has the Siri voice, the request fails with its own status (424)."""

from __future__ import annotations

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from kokoro_reader import apple_engine, config
from kokoro_reader.apple_engine import AppleModel, SwiftHost
from kokoro_reader.routes import tts as tts_routes
from kokoro_reader.tts_engine import TTSEngine, TTSError, TTSVoiceUnavailable

#: What the real apple_host.swift answered for an identifier macOS does not have (2026-10-10).
GONE_REPLY = {"ok": False, "error": "unknown voice: com.apple.siri.natural.Nora"}


class ReplyHost:
    def __init__(self, reply: dict) -> None:
        self.reply = reply

    def ask(self, request: dict) -> dict:
        return self.reply


def _apple_engine(reply: dict) -> TTSEngine:
    return TTSEngine(model_id=apple_engine.MODEL_ID, loader=lambda _id: AppleModel(host=ReplyHost(reply)))


def test_a_voice_macos_does_not_have_is_unavailable_not_just_failed() -> None:
    with pytest.raises(TTSVoiceUnavailable, match="siri_nora"):
        AppleModel(host=ReplyHost(GONE_REPLY)).generate("Hello.", voice="siri_nora")


@pytest.mark.parametrize("reply", [{"ok": False, "error": "timeout after 120.0s"}, {"ok": False}])
def test_other_host_failures_stay_ordinary_errors(reply) -> None:
    with pytest.raises(TTSError) as caught:
        AppleModel(host=ReplyHost(reply)).generate("Hello.", voice="siri_nora")
    assert not isinstance(caught.value, TTSVoiceUnavailable)


def test_unavailable_is_still_a_tts_error_so_existing_handlers_catch_it() -> None:
    assert issubclass(TTSVoiceUnavailable, TTSError)


def test_no_swift_toolchain_means_the_voice_is_unavailable() -> None:
    with pytest.raises(TTSVoiceUnavailable, match="swift"):
        SwiftHost(cmd=("/nonexistent/swift", "serve")).ask({"text": "x"})


def test_the_engine_passes_unavailability_through_unwrapped(tmp_path, monkeypatch) -> None:
    monkeypatch.setattr(config, "AUDIO_CACHE_DIR", tmp_path / "audio")
    with pytest.raises(TTSVoiceUnavailable):
        _apple_engine(GONE_REPLY).synthesize("Hello.", voice="siri_nora")


def _client(monkeypatch, engine: TTSEngine) -> TestClient:
    app = FastAPI()
    app.include_router(tts_routes.router)
    monkeypatch.setattr(tts_routes, "get_apple_engine", lambda: engine)
    return TestClient(app)


def test_the_route_answers_424_with_a_readable_reason(tmp_path, monkeypatch) -> None:
    monkeypatch.setattr(config, "AUDIO_CACHE_DIR", tmp_path / "audio")
    client = _client(monkeypatch, _apple_engine(GONE_REPLY))
    response = client.get("/api/tts", params={"text": "Hello.", "voice": "siri_nora"})
    assert response.status_code == tts_routes.VOICE_UNAVAILABLE_STATUS == 424
    assert "siri_nora" in response.json()["detail"]
    assert response.headers["cache-control"] == "no-store"


def test_an_ordinary_siri_failure_is_still_a_500(tmp_path, monkeypatch) -> None:
    monkeypatch.setattr(config, "AUDIO_CACHE_DIR", tmp_path / "audio")
    client = _client(monkeypatch, _apple_engine({"ok": False, "error": "no audio"}))
    response = client.get("/api/tts", params={"text": "Hello.", "voice": "siri_nora"})
    assert response.status_code == 500
