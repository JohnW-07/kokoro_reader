"""C1/N5: the beat after a sentence is chosen by context, not fixed. The model is never loaded."""

from __future__ import annotations

import hashlib
import io
import struct
from pathlib import Path

import numpy as np
import pytest
import soundfile as sf
from fastapi import FastAPI
from fastapi.testclient import TestClient

from kokoro_reader import tts_engine
from kokoro_reader.routes import tts as tts_routes
from kokoro_reader.tts_engine import TTSEngine, TTSError
from tests.test_tts_engine import (  # noqa: F401 - cache_dir is a fixture
    FakeResult, PaddedModel, cache_dir, frame_count, pad_frames, speech_frames,
)

TEXT = "One short sentence."
TIERS = ("sentence", "paragraph", "section")
#: The natural in-paragraph gap John's brief asks for, all silence heard included.
NATURAL_GAP_MS = (250, 350)
#: Measured 2026-10-09 (af_aoede, af_heart; 10 PI0_6 sentences): speech decay and onset
#: still under -35 dB past the pads, tail side and lead side together.
MEASURED_EDGE_MS = 15


@pytest.fixture
def padded(cache_dir: Path) -> PaddedModel:
    return PaddedModel()


@pytest.fixture
def engine(padded: PaddedModel) -> TTSEngine:
    return TTSEngine(model_id="fake-model", loader=lambda _m: padded)


def expected_frames(tier: str) -> int:
    return (pad_frames(tts_engine.LEAD_PAD_MS) + speech_frames(TEXT)
            + pad_frames(tts_engine.PAUSE_TAIL_MS[tier]))


@pytest.mark.parametrize("tier", TIERS)
def test_each_pause_sets_the_silence_after_the_sentence(engine: TTSEngine, tier: str) -> None:
    wav = engine.synthesize(TEXT, voice="af_heart", pause=tier)

    assert frame_count(wav) == expected_frames(tier)


def test_pauses_grow_from_sentence_to_paragraph_to_section() -> None:
    tails = [tts_engine.PAUSE_TAIL_MS[tier] for tier in TIERS]

    assert tails == sorted(tails) and len(set(tails)) == len(tails)


def test_the_sentence_pause_is_a_natural_in_paragraph_gap() -> None:
    heard = (tts_engine.LEAD_PAD_MS + tts_engine.PAUSE_TAIL_MS["sentence"]
             + MEASURED_EDGE_MS)

    assert NATURAL_GAP_MS[0] <= heard <= NATURAL_GAP_MS[1]


def test_no_pause_given_means_the_sentence_beat(engine: TTSEngine) -> None:
    assert tts_engine.DEFAULT_PAUSE == "sentence"
    assert frame_count(engine.synthesize(TEXT, voice="af_heart")) == expected_frames("sentence")


# ── Cache: the stored WAV stays v2; the tier is added when serving ───────────

def cached_frames() -> int:
    return (pad_frames(tts_engine.LEAD_PAD_MS) + speech_frames(TEXT)
            + pad_frames(tts_engine.TAIL_PAD_MS))


def test_every_pause_shares_one_cache_entry(
    engine: TTSEngine, padded: PaddedModel, cache_dir: Path
) -> None:
    for tier in TIERS:
        engine.synthesize(TEXT, voice="af_heart", pause=tier)

    entries = list(cache_dir.glob(f"*{tts_engine.CACHE_SUFFIX}"))
    assert len(padded.calls) == 1, "one render for all three pauses"
    assert len(entries) == 1
    assert frame_count(entries[0].read_bytes()) == cached_frames(), "stored as v2: 120 ms tail"


def test_the_cache_format_is_still_v2() -> None:
    """John's existing cache must keep hitting: no version bump, no tier in the key."""
    raw = f"m|af_heart|1.00|v2|{TEXT}"

    assert tts_engine.AUDIO_FORMAT_VERSION == 2
    assert tts_engine.cache_key("m", "af_heart", 1.0, TEXT) == hashlib.sha1(raw.encode()).hexdigest()


@pytest.mark.parametrize("tier", TIERS)
def test_a_cache_hit_gets_the_pause_too(engine: TTSEngine, tier: str) -> None:
    engine.synthesize(TEXT, voice="af_heart")

    def no_model(_model_id: str) -> None:
        raise AssertionError("must be served from cache")

    cold = TTSEngine(model_id="fake-model", loader=no_model)
    assert frame_count(cold.synthesize(TEXT, voice="af_heart", pause=tier)) == expected_frames(tier)


def test_the_route_cache_probe_ignores_the_pause(engine: TTSEngine) -> None:
    engine.synthesize(TEXT, voice="af_heart", pause="section")

    assert tts_routes._is_cached(engine, TEXT, "af_heart", 1.0)


SIRI_RATE = 48000  # AppleModel renders at Siri's own rate, not Kokoro's 24 kHz


class SiriRateModel:
    """Like AppleModel: a flat tone at 48 kHz, whatever rate is asked for."""

    def generate(self, text: str, voice: str, speed: float = 1.0, **_: object) -> FakeResult:
        return FakeResult(np.full(SIRI_RATE // 10, 0.5, dtype=np.float32), SIRI_RATE, 0.1, voice)


def test_siri_voices_get_the_pause_at_their_own_rate(cache_dir: Path) -> None:
    """get_apple_engine() is a TTSEngine too, so the same synthesize pads Siri audio."""
    siri = TTSEngine(model_id="fake-siri", loader=lambda _m: SiriRateModel())

    wav = siri.synthesize(TEXT, voice="siri_x", pause="paragraph")

    ms = tts_engine.LEAD_PAD_MS + tts_engine.PAUSE_TAIL_MS["paragraph"]
    assert sf.info(io.BytesIO(wav)).samplerate == SIRI_RATE
    assert frame_count(wav) == SIRI_RATE // 10 + SIRI_RATE * ms // tts_engine.MS_PER_S


# ── pad_tail: a valid WAV comes back ──────────────────────────────────────────

def riff_sizes(wav: bytes) -> tuple[int, int]:
    """(RIFF size field, data chunk size field), found by walking the chunks."""
    offset = tts_engine.RIFF_HEADER_BYTES
    while True:
        chunk_id, size = struct.unpack_from("<4sI", wav, offset)
        if chunk_id == b"data":
            return struct.unpack_from("<I", wav, 4)[0], size
        offset += tts_engine.CHUNK_HEADER_BYTES + size + (size & 1)


@pytest.mark.parametrize("channels", [1, 2])
def test_pad_tail_appends_silence_with_a_valid_header(channels: int) -> None:
    audio = np.full((480, channels), 0.5, dtype=np.float32)
    wav = tts_engine.encode_wav(audio, 24000)

    out = tts_engine.pad_tail(wav, 130)

    samples, rate = sf.read(io.BytesIO(out), always_2d=True)
    added = 24 * 130
    assert rate == 24000 and samples.shape == (480 + added, channels)
    assert np.all(samples[480:] == 0) and np.all(samples[:480] > 0)
    assert riff_sizes(out) == (len(out) - 8, (480 + added) * 2 * channels)


def test_pad_tail_keeps_chunks_after_the_data() -> None:
    wav = tts_engine.encode_wav(np.full(480, 0.5, dtype=np.float32), 24000)
    trailer = b"LIST" + struct.pack("<I", 4) + b"INFO"
    tagged = wav[:4] + struct.pack("<I", len(wav) + len(trailer) - 8) + wav[8:] + trailer

    out = tts_engine.pad_tail(tagged, 10)

    assert out.endswith(trailer)
    assert frame_count(out) == 480 + 240
    assert riff_sizes(out)[0] == len(out) - 8


def test_pad_tail_of_nothing_is_the_same_wav() -> None:
    wav = tts_engine.encode_wav(np.full(480, 0.5, dtype=np.float32), 24000)

    assert tts_engine.pad_tail(wav, 0) == wav


def test_an_unknown_pause_is_a_tts_error(engine: TTSEngine) -> None:
    with pytest.raises(TTSError, match="pause"):
        engine.synthesize(TEXT, voice="af_heart", pause="forever")


# ── Route ─────────────────────────────────────────────────────────────────────

@pytest.fixture
def client(engine: TTSEngine, monkeypatch: pytest.MonkeyPatch) -> TestClient:
    monkeypatch.setattr(tts_routes, "get_engine", lambda: engine)
    app = FastAPI()
    app.include_router(tts_routes.router)
    return TestClient(app)


@pytest.mark.parametrize("tier", TIERS)
def test_the_route_passes_the_pause_through(client: TestClient, tier: str) -> None:
    response = client.get("/api/tts", params={"text": TEXT, "voice": "af_heart", "pause": tier})

    assert response.status_code == 200
    assert frame_count(response.content) == expected_frames(tier)


def test_the_route_defaults_to_the_sentence_beat(client: TestClient) -> None:
    response = client.get("/api/tts", params={"text": TEXT, "voice": "af_heart"})

    assert frame_count(response.content) == expected_frames("sentence")


def test_the_route_rejects_an_unknown_pause(client: TestClient) -> None:
    response = client.get("/api/tts", params={"text": TEXT, "pause": "forever"})

    assert response.status_code == 400
    assert "pause" in response.json()["detail"]
