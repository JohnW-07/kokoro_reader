"""V1 (docs/18): Kokoro's native voice knobs, pitch and expressiveness, applied to the F0 curve
the model predicts. The real model is never loaded; a fake predictor stands in for it."""

from __future__ import annotations

import threading
from pathlib import Path
from typing import Any

import mlx.core as mx
import numpy as np
import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from kokoro_reader import config, tts_engine, voiceshape
from kokoro_reader.routes import tts as tts_routes
from kokoro_reader.tts_engine import TTSEngine
from kokoro_reader.voiceshape import NEUTRAL, VoiceShape
from tests.test_tts_engine import FakeModel

UNVOICED = 0.0
CURVE = [UNVOICED, 100.0, 200.0, 300.0, UNVOICED]   # voiced mean 200 Hz
NOISE = [7.0] * len(CURVE)


def as_list(a: Any) -> list[float]:
    return [round(float(x), 4) for x in np.array(a.tolist()).reshape(-1)]


class FakePredictor:
    def F0Ntrain(self, x: Any, s: Any) -> tuple[Any, Any]:  # noqa: N802 - kokoro_mlx's name
        return mx.array([[CURVE]]), mx.array([[NOISE]])


class FakeKokoro(FakeModel):
    """FakeModel with kokoro_mlx's internals: generate() runs the predictor and records its F0."""

    def __init__(self) -> None:
        super().__init__()
        self._model = type("Inner", (), {})()
        self._model.predictor = FakePredictor()
        self.f0s: list[list[float]] = []

    def generate(self, text: str, **kwargs: Any) -> Any:
        f0, _ = self._model.predictor.F0Ntrain(None, None)
        self.f0s.append(as_list(f0))
        return super().generate(text, **kwargs)


# ── VoiceShape ────────────────────────────────────────────────────────────────

def test_neutral_shape_adds_nothing_to_the_cache_key() -> None:
    """So every sentence already cached before V1 stays a hit."""
    assert NEUTRAL.is_neutral and NEUTRAL.key() == ""
    assert VoiceShape(1.0, 1.0) == NEUTRAL


def test_a_shape_is_clamped_to_its_measured_range_and_keyed_by_both_knobs() -> None:
    wild = VoiceShape.clamped(pitch=9.0, expressiveness=-3.0)

    assert wild == VoiceShape(voiceshape.PITCH_MAX, voiceshape.EXPRESSIVENESS_MIN)
    assert VoiceShape(1.1, 1.0).key() != VoiceShape(1.0, 1.1).key()
    assert VoiceShape(1.0, 1.2).key() != VoiceShape(1.0, 1.3).key()
    assert VoiceShape(1.1, 1.0).key() == VoiceShape(1.1, 1.0).key() != ""


# ── shape_f0 ──────────────────────────────────────────────────────────────────

def test_pitch_scales_voiced_frames_and_leaves_unvoiced_ones_at_zero() -> None:
    out = as_list(voiceshape.shape_f0(mx.array([[CURVE]]), VoiceShape(1.1, 1.0)))

    assert out == [UNVOICED, 110.0, 220.0, 330.0, UNVOICED]


def test_expressiveness_stretches_the_contour_about_its_voiced_mean() -> None:
    flat = as_list(voiceshape.shape_f0(mx.array([[CURVE]]), VoiceShape(1.0, 0.5)))
    wide = as_list(voiceshape.shape_f0(mx.array([[CURVE]]), VoiceShape(1.0, 1.5)))

    assert flat == [UNVOICED, 150.0, 200.0, 250.0, UNVOICED]
    assert wide == [UNVOICED, 50.0, 200.0, 350.0, UNVOICED]


def test_neutral_returns_the_curve_unchanged() -> None:
    curve = mx.array([[CURVE]])

    assert voiceshape.shape_f0(curve, NEUTRAL) is curve


# ── install / using ───────────────────────────────────────────────────────────

def test_installed_model_shapes_f0_only_inside_using_and_only_on_that_thread() -> None:
    model = voiceshape.install(FakeKokoro())
    predictor = model._model.predictor
    seen: list[list[float]] = []

    with voiceshape.using(VoiceShape(1.1, 1.0)):
        inside = as_list(predictor.F0Ntrain(None, None)[0])
        other = threading.Thread(target=lambda: seen.append(as_list(predictor.F0Ntrain(None, None)[0])))
        other.start()
        other.join()
    after = as_list(predictor.F0Ntrain(None, None)[0])

    assert inside == [UNVOICED, 110.0, 220.0, 330.0, UNVOICED]
    assert seen == [CURVE] and after == CURVE


def test_install_is_idempotent_and_leaves_the_noise_curve_alone() -> None:
    model = voiceshape.install(voiceshape.install(FakeKokoro()))

    with voiceshape.using(VoiceShape(1.15, 1.5)):
        f0, noise = model._model.predictor.F0Ntrain(None, None)

    assert as_list(noise) == NOISE
    assert as_list(f0)[2] == pytest.approx(200.0 * 1.15)   # wrapped once: the mean scaled once


def test_a_model_without_kokoro_internals_is_returned_as_is() -> None:
    plain = FakeModel()

    assert voiceshape.install(plain) is plain


# ── engine and route ──────────────────────────────────────────────────────────

@pytest.fixture
def kokoro(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> tuple[TTSEngine, FakeKokoro]:
    monkeypatch.setattr(config, "AUDIO_CACHE_DIR", tmp_path)
    model = FakeKokoro()
    return TTSEngine(model_id="fake-model", loader=lambda _id: model), model


def test_engine_renders_with_the_shape_and_caches_each_shape_apart(kokoro: tuple[TTSEngine, FakeKokoro]) -> None:
    engine, model = kokoro

    engine.synthesize("One.", "af_heart", shape=VoiceShape(1.1, 1.0))
    engine.synthesize("One.", "af_heart")
    engine.synthesize("One.", "af_heart", shape=VoiceShape(1.1, 1.0))

    assert model.f0s == [[UNVOICED, 110.0, 220.0, 330.0, UNVOICED], CURVE]   # third call: a cache hit


def test_the_neutral_cache_key_is_unchanged_by_v1() -> None:
    args = ("fake-model", "af_heart", 1.0, "One.")

    assert tts_engine.cache_key(*args, shape=NEUTRAL) == tts_engine.cache_key(*args)
    assert tts_engine.cache_key(*args, shape=VoiceShape(0.9, 1.0)) != tts_engine.cache_key(*args)


@pytest.fixture
def client(kokoro: tuple[TTSEngine, FakeKokoro], monkeypatch: pytest.MonkeyPatch) -> TestClient:
    monkeypatch.setattr(tts_routes, "get_engine", lambda: kokoro[0])
    app = FastAPI()
    app.include_router(tts_routes.router)
    return TestClient(app)


def test_route_passes_pitch_and_expressiveness_clamped(
    client: TestClient, kokoro: tuple[TTSEngine, FakeKokoro]
) -> None:
    response = client.get("/api/tts", params={"text": "Hi.", "voice": "af_heart", "pitch": 5, "expr": 1.5})

    assert response.status_code == 200
    top = 200.0 * voiceshape.PITCH_MAX + 100.0 * 1.5 * voiceshape.PITCH_MAX
    assert kokoro[1].f0s[-1][3] == pytest.approx(top)


def test_route_without_knobs_renders_neutral(client: TestClient, kokoro: tuple[TTSEngine, FakeKokoro]) -> None:
    client.get("/api/tts", params={"text": "Plain.", "voice": "af_heart"})

    assert kokoro[1].f0s[-1] == CURVE


def test_route_ignores_the_knobs_for_a_siri_voice(
    client: TestClient, kokoro: tuple[TTSEngine, FakeKokoro], monkeypatch: pytest.MonkeyPatch
) -> None:
    """Siri has no F0 to shape (pitchMultiplier measured: no effect), so no separate cache entry either."""
    shapes: list[VoiceShape] = []
    engine = kokoro[0]
    real = engine.synthesize
    monkeypatch.setattr(engine, "synthesize", lambda *a, **k: shapes.append(k.get("shape", NEUTRAL)) or real(*a, **k))
    monkeypatch.setattr(tts_routes, "get_apple_engine", lambda: engine)

    client.get("/api/tts", params={"text": "Hi.", "voice": "siri_nora", "pitch": 1.1, "expr": 1.3})

    assert shapes == [NEUTRAL]
