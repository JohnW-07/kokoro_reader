"""Tests for the TTS engine and its routes. The real Kokoro model is never loaded."""

from __future__ import annotations

import inspect
import io
import math
import os
import threading
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import numpy as np
import pytest
import soundfile as sf
from fastapi import FastAPI
from fastapi.testclient import TestClient

from kokoro_reader import config, tts_engine
from kokoro_reader.routes import health as health_routes
from kokoro_reader.routes import tts as tts_routes
from kokoro_reader.tts_engine import TTSEngine, TTSError

SAMPLES_PER_CHAR = 20
FAKE_VOICES = ["af_heart", "am_puck"]


@dataclass(frozen=True)
class FakeResult:
    audio: np.ndarray
    sample_rate: int
    duration: float
    voice: str


class FakeModel:
    """Stands in for KokoroTTS: emits a sine wave proportional to input length."""

    def __init__(self) -> None:
        self.calls: list[tuple[str, str, float]] = []
        self._lock = threading.Lock()

    def generate(
        self,
        text: str,
        voice: str = "af_heart",
        speed: float = 1.0,
        sample_rate: int = config.SAMPLE_RATE,
    ) -> FakeResult:
        with self._lock:
            self.calls.append((text, voice, speed))
        n = max(1, len(text)) * SAMPLES_PER_CHAR
        t = np.arange(n, dtype=np.float32) / sample_rate
        audio = np.sin(2 * math.pi * 220.0 * t).astype(np.float32)
        return FakeResult(audio, sample_rate, n / sample_rate, voice)

    def list_voices(self) -> list[str]:
        return list(FAKE_VOICES)


@pytest.fixture
def cache_dir(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    """Keep every cache write inside tmp_path, never the user's home dir."""
    audio_dir = tmp_path / "audio"
    audio_dir.mkdir()
    monkeypatch.setattr(config, "AUDIO_CACHE_DIR", audio_dir)
    return audio_dir


@pytest.fixture
def model() -> FakeModel:
    return FakeModel()


@pytest.fixture
def engine(model: FakeModel, cache_dir: Path) -> TTSEngine:
    return TTSEngine(model_id="fake-model", loader=lambda _model_id: model)


def frame_count(wav: bytes) -> int:
    with sf.SoundFile(io.BytesIO(wav)) as handle:
        return len(handle)


def dir_size(path: Path) -> int:
    return sum(p.stat().st_size for p in path.glob("*.wav"))


# ── Engine ────────────────────────────────────────────────────────────────────

def test_synthesize_returns_riff_wav_bytes(engine: TTSEngine) -> None:
    wav = engine.synthesize("Hello there.", voice="af_heart")

    assert isinstance(wav, bytes)
    assert wav[:4] == b"RIFF"
    assert wav[8:12] == b"WAVE"


def test_model_loads_lazily_and_warmup_forces_it(engine: TTSEngine) -> None:
    assert engine.is_ready() is False

    engine.warmup()

    assert engine.is_ready() is True


def test_long_text_is_chunked_into_multiple_generate_calls(
    engine: TTSEngine, model: FakeModel
) -> None:
    sentence = "This is a reasonably long sentence about numerical analysis. "
    long_text = sentence * (config.MAX_TTS_CHARS * 3 // len(sentence))
    assert len(long_text) > config.MAX_TTS_CHARS

    short_wav = engine.synthesize("Short.", voice="af_heart")
    long_wav = engine.synthesize(long_text, voice="af_heart")

    assert len(model.calls) > 2  # one short call plus several chunks
    assert all(len(call[0]) <= config.MAX_TTS_CHARS for call in model.calls)
    assert frame_count(long_wav) > frame_count(short_wav)


def test_cache_hit_avoids_a_second_generate_call(
    engine: TTSEngine, model: FakeModel
) -> None:
    first = engine.synthesize("Cache me once.", voice="af_heart", speed=1.0)
    calls_after_first = len(model.calls)

    second = engine.synthesize("Cache me once.", voice="af_heart", speed=1.0)

    assert second == first
    assert len(model.calls) == calls_after_first


def test_cache_key_separates_voice_and_speed(
    engine: TTSEngine, model: FakeModel
) -> None:
    engine.synthesize("Same words.", voice="af_heart", speed=1.0)
    engine.synthesize("Same words.", voice="am_puck", speed=1.0)
    engine.synthesize("Same words.", voice="af_heart", speed=1.5)

    assert len(model.calls) == 3


def test_cache_eviction_respects_the_byte_cap(
    engine: TTSEngine, cache_dir: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    probe = engine.synthesize("Sizing probe sentence.", voice="af_heart")
    cap = len(probe) * 3
    monkeypatch.setattr(config, "AUDIO_CACHE_MAX_BYTES", cap)

    for i in range(12):
        engine.synthesize(f"Sizing probe sentence number {i}.", voice="af_heart")

    assert dir_size(cache_dir) <= cap
    assert len(list(cache_dir.glob("*.wav"))) >= 1


def test_cache_read_failure_degrades_to_synthesis(
    engine: TTSEngine, cache_dir: Path, model: FakeModel
) -> None:
    cache_dir.rmdir()  # cache directory gone: must not raise

    wav = engine.synthesize("No cache directory here.", voice="af_heart")

    assert wav[:4] == b"RIFF"
    assert len(model.calls) == 1


def test_empty_text_raises_tts_error(engine: TTSEngine) -> None:
    with pytest.raises(TTSError):
        engine.synthesize("   \n\t ", voice="af_heart")


def test_loader_failure_is_wrapped_in_tts_error(cache_dir: Path) -> None:
    def broken_loader(_model_id: str) -> Any:
        raise OSError("weights missing")

    broken = TTSEngine(model_id="fake-model", loader=broken_loader)

    with pytest.raises(TTSError, match="weights missing"):
        broken.synthesize("Anything.", voice="af_heart")


def test_generate_failure_is_wrapped_in_tts_error(cache_dir: Path) -> None:
    class BoomModel:
        def generate(self, *args: Any, **kwargs: Any) -> Any:
            raise ValueError("mlx exploded")

    engine = TTSEngine(model_id="fake-model", loader=lambda _m: BoomModel())

    with pytest.raises(TTSError, match="mlx exploded"):
        engine.synthesize("Anything.", voice="af_heart")


def test_voices_are_reported_from_the_model(engine: TTSEngine) -> None:
    assert engine.voices() == FAKE_VOICES


def test_concurrent_synthesis_from_four_threads_all_succeed(
    engine: TTSEngine,
) -> None:
    results: dict[int, bytes] = {}
    errors: list[BaseException] = []

    def run(i: int) -> None:
        try:
            results[i] = engine.synthesize(f"Thread number {i} speaking.", voice="af_heart")
        except BaseException as exc:  # noqa: BLE001 - re-raised by the assertion below
            errors.append(exc)

    threads = [threading.Thread(target=run, args=(i,)) for i in range(4)]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join(timeout=30)

    assert not errors
    assert len(results) == 4
    assert all(wav[:4] == b"RIFF" for wav in results.values())


# ── J5: the silence Kokoro pads every utterance with ──────────────────────────

PAD_SAMPLES = 4000   # the dead air a real Kokoro utterance arrives wrapped in


class PaddedModel(FakeModel):
    """FakeModel, but every utterance arrives wrapped in silence, as Kokoro's does."""

    def generate(self, text: str, **kwargs: Any) -> FakeResult:
        result = super().generate(text, **kwargs)
        pad = np.zeros(PAD_SAMPLES, dtype=np.float32)
        # A flat tone, not FakeModel's sine: a sine's first sample is zero, and a
        # frame-exact assertion below cannot tell that apart from padding.
        speech = np.full(len(result.audio), 0.5, dtype=np.float32)
        return FakeResult(
            np.concatenate([pad, speech, pad]), result.sample_rate, 0.0, result.voice
        )


def speech_frames(text: str) -> int:
    return max(1, len(text)) * SAMPLES_PER_CHAR


def pad_frames(ms: float) -> int:
    return int(config.SAMPLE_RATE * ms / tts_engine.MS_PER_S)


def test_strip_silence_keeps_only_the_audible_span() -> None:
    quiet = np.zeros(1000, dtype=np.float32)
    loud = np.full(500, 0.5, dtype=np.float32)
    audio = np.concatenate([quiet, loud, quiet])

    trimmed = tts_engine.strip_silence(audio)

    assert len(trimmed) == 500
    assert np.array_equal(trimmed, loud)
    assert len(audio) == 2500, "the caller's array must not be mutated"


def test_audio_that_is_silent_throughout_is_returned_whole() -> None:
    """An empty result would reach the client as a media error, not as a quiet word."""
    audio = np.zeros(1000, dtype=np.float32)

    assert len(tts_engine.strip_silence(audio)) == 1000


def test_a_padded_utterance_is_trimmed_back_to_a_fixed_beat(cache_dir: Path) -> None:
    text = "One short sentence."
    engine = TTSEngine(model_id="fake-model", loader=lambda _m: PaddedModel())

    wav = engine.synthesize(text, voice="af_heart")

    expected = (pad_frames(tts_engine.LEAD_PAD_MS)
                + speech_frames(text)
                + pad_frames(tts_engine.PAUSE_TAIL_MS[tts_engine.DEFAULT_PAUSE]))
    assert frame_count(wav) == expected


def test_every_chunk_is_trimmed_not_only_the_ends_of_the_sentence(
    cache_dir: Path,
) -> None:
    """Left in place, a chunked sentence stutters in its middle as well as its ends."""
    model = PaddedModel()
    engine = TTSEngine(model_id="fake-model", loader=lambda _m: model)
    sentence = "This is a reasonably long sentence about numerical analysis. "
    text = sentence * (config.MAX_TTS_CHARS * 3 // len(sentence))

    wav = engine.synthesize(text, voice="af_heart")

    chunks = [call[0] for call in model.calls]
    assert len(chunks) > 1, "this text must chunk for the test to mean anything"
    expected = (pad_frames(tts_engine.LEAD_PAD_MS)
                + sum(speech_frames(chunk) for chunk in chunks)
                + pad_frames(tts_engine.CHUNK_GAP_MS) * (len(chunks) - 1)
                + pad_frames(tts_engine.PAUSE_TAIL_MS[tts_engine.DEFAULT_PAUSE]))
    assert frame_count(wav) == expected


def test_the_audio_format_version_is_part_of_the_cache_key(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Without it, every sentence read before J5 would still be served untrimmed."""
    args = ("fake-model", "af_heart", 1.0, "One short sentence.")
    before = tts_engine.cache_key(*args)
    monkeypatch.setattr(tts_engine, "AUDIO_FORMAT_VERSION", tts_engine.AUDIO_FORMAT_VERSION + 1)

    assert tts_engine.cache_key(*args) != before


# ── Routes ────────────────────────────────────────────────────────────────────

@pytest.fixture
def client(engine: TTSEngine, monkeypatch: pytest.MonkeyPatch) -> TestClient:
    monkeypatch.setattr(tts_routes, "get_engine", lambda: engine)
    app = FastAPI()
    app.include_router(tts_routes.router)
    app.include_router(health_routes.router)
    return TestClient(app)


def test_tts_route_returns_wav_audio(client: TestClient) -> None:
    response = client.get("/api/tts", params={"text": "Hello.", "voice": "af_heart"})

    assert response.status_code == 200
    assert response.headers["content-type"] == "audio/wav"
    assert response.headers["cache-control"] == "no-store"
    assert response.content[:4] == b"RIFF"


def test_tts_route_clamps_out_of_range_speed(
    client: TestClient, model: FakeModel
) -> None:
    response = client.get("/api/tts", params={"text": "Fast.", "speed": 99})

    assert response.status_code == 200
    assert model.calls[-1][2] == pytest.approx(tts_routes.MAX_SPEED)


def test_tts_route_defaults_to_af_aoede(client: TestClient, model: FakeModel) -> None:
    # Arrange
    params = {"text": "No voice given."}

    # Act
    response = client.get("/api/tts", params=params)

    # Assert
    assert config.DEFAULT_VOICE == "af_aoede"
    assert tts_routes.FALLBACK_VOICES[0] == "af_aoede"
    assert response.status_code == 200
    assert model.calls[-1][1] == "af_aoede"


def test_tts_route_rejects_empty_text(client: TestClient) -> None:
    response = client.get("/api/tts", params={"text": "   "})

    assert response.status_code == 400
    assert "empty" in response.json()["detail"]


def test_tts_route_rejects_oversized_text(client: TestClient) -> None:
    response = client.get(
        "/api/tts", params={"text": "x" * (tts_routes.MAX_TEXT_CHARS + 1)}
    )

    assert response.status_code == 400


def test_tts_route_rejects_bad_voice(client: TestClient) -> None:
    response = client.get("/api/tts", params={"text": "Hi.", "voice": "../etc/passwd"})

    assert response.status_code == 400


def test_tts_route_maps_tts_error_to_500(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    class FailingEngine:
        def synthesize(self, *args: Any, **kwargs: Any) -> bytes:
            raise TTSError("no audio today")

    monkeypatch.setattr(tts_routes, "get_engine", lambda: FailingEngine())

    response = client.get("/api/tts", params={"text": "Hi."})

    assert response.status_code == 500
    assert response.json()["detail"] == "no audio today"


def test_voices_route_lists_model_voices(client: TestClient) -> None:
    response = client.get("/api/voices")

    assert response.status_code == 200
    assert response.json() == {"voices": FAKE_VOICES}


def test_voices_route_falls_back_when_listing_fails(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    class FailingEngine:
        def voices(self) -> list[str]:
            raise TTSError("model unavailable")

    monkeypatch.setattr(tts_routes, "get_engine", lambda: FailingEngine())

    response = client.get("/api/voices")

    assert response.status_code == 200
    assert response.json()["voices"] == list(tts_routes.FALLBACK_VOICES)


def test_health_reports_ok_without_loading_the_model(
    client: TestClient, engine: TTSEngine
) -> None:
    response = client.get("/api/health")

    body = response.json()
    assert response.status_code == 200
    assert body["ok"] is True
    assert body["version"] == "2.0"
    assert body["llm_model"] == config.LLM_MODEL
    assert isinstance(body["llm_available"], bool)
    assert engine.is_ready() is False


def test_tts_handler_is_sync_and_health_is_async() -> None:
    """D3/R2: /api/tts must run in the threadpool, /api/health on the loop."""
    assert not inspect.iscoroutinefunction(tts_routes.get_tts)
    assert inspect.iscoroutinefunction(health_routes.health)


# ── H4: concurrent cache writers must never produce a torn entry ──────────────

TORN_WRITE_PAYLOAD_BYTES = 400_000   # big enough that a write is not atomic
TORN_WRITE_WRITERS = 6
TORN_WRITE_ROUNDS = 40


def test_concurrent_cache_writers_never_produce_a_torn_entry(cache_dir: Path) -> None:
    """A deterministic `<key>.wav.tmp` is shared by every writer of the same key.

    One writer's `os.replace` then moves the file another is still writing into, so the
    live cache entry receives the tail of a *different* payload and is served as a 200.
    Measured against the old path: 1 torn read and 163 lost writes in this same loop.
    """
    key = "0" * 40
    payloads = [bytes([i + 1]) * TORN_WRITE_PAYLOAD_BYTES for i in range(TORN_WRITE_WRITERS)]
    whole = set(payloads)
    torn: list[int] = []
    stop = threading.Event()

    def write(payload: bytes) -> None:
        for _ in range(TORN_WRITE_ROUNDS):
            tts_engine.cache_write(key, payload)

    def read() -> None:
        while not stop.is_set():
            data = tts_engine.cache_read(key)
            if data is not None and data not in whole:
                torn.append(len(data))

    readers = [threading.Thread(target=read, daemon=True) for _ in range(3)]
    writers = [threading.Thread(target=write, args=(p,)) for p in payloads]
    for thread in readers + writers:
        thread.start()
    for thread in writers:
        thread.join(timeout=60)
    stop.set()
    for thread in readers:
        thread.join(timeout=5)

    assert not torn, f"{len(torn)} torn reads served from the audio cache"
    assert tts_engine.cache_read(key) in whole


def test_cache_write_uses_a_unique_tmp_path_per_writer() -> None:
    path = Path("/tmp/kokoro-test/abc.wav")

    first, second = tts_engine._tmp_path(path), tts_engine._tmp_path(path)

    assert first != second
    assert first.name.endswith(tts_engine.TMP_SUFFIX)
    assert first.parent == path.parent


# ── M11: `.wav.tmp` orphans must not accumulate ───────────────────────────────

def test_stale_tmp_orphans_are_swept_but_live_ones_are_left_alone(cache_dir: Path) -> None:
    stale = cache_dir / f"dead.wav.1234.abcdef{tts_engine.TMP_SUFFIX}"
    fresh = cache_dir / f"live.wav.5678.fedcba{tts_engine.TMP_SUFFIX}"
    for path in (stale, fresh):
        path.write_bytes(b"partial")
    old = time.time() - tts_engine.TMP_ORPHAN_MAX_AGE_S - 60
    os.utime(stale, (old, old))

    removed = tts_engine.sweep_tmp_orphans()

    assert removed == 1
    assert not stale.exists()
    assert fresh.exists()


def test_a_normal_synthesis_leaves_no_tmp_files_behind(
    engine: TTSEngine, cache_dir: Path
) -> None:
    engine.synthesize("A sentence that lands in the cache.", voice="af_heart")

    assert list(cache_dir.glob(f"*{tts_engine.TMP_SUFFIX}")) == []


# ── M15: only offer voices whose language pack is installed ───────────────────

def test_voices_needing_a_missing_language_pack_are_dropped() -> None:
    """Measured on 2026-09-11: jf_alpha and zf_xiaobei raise, the other seven speak."""
    # Arrange
    voices = ["af_alloy", "bf_alice", "jf_alpha", "zf_xiaobei", "ef_dora"]

    # Act
    kept = tts_routes.usable_voices(voices)

    # Assert
    assert "jf_alpha" not in kept
    assert "zf_xiaobei" not in kept
    assert kept == ["af_alloy", "bf_alice", "ef_dora"]


def test_an_installed_language_pack_keeps_its_voices(monkeypatch) -> None:
    # Arrange: pretend both backends are present
    monkeypatch.setattr(tts_routes, "LANGUAGE_REQUIREMENTS", {})

    # Act / Assert
    assert tts_routes.usable_voices(["jf_alpha", "zf_xiaobei"]) == ["jf_alpha", "zf_xiaobei"]


def test_an_over_eager_filter_never_empties_the_picker(monkeypatch) -> None:
    """If the table is wrong, too much choice beats none: a dead picker is a dead player."""
    # Arrange: claim every language needs a module that does not exist
    monkeypatch.setattr(
        tts_routes, "LANGUAGE_REQUIREMENTS", {"a": ("no_such_module_xyz",)}
    )

    # Act / Assert
    assert tts_routes.usable_voices(["af_alloy", "am_puck"]) == ["af_alloy", "am_puck"]


# ── Offline launch: a cached model is loaded without asking the Hub ───────────
REPO_ID = "mlx-community/Kokoro-82M-bf16"


def _fake_hub(monkeypatch: pytest.MonkeyPatch, snapshot: Path, cached: bool) -> list[bool]:
    """Patch snapshot_download; returns the `local_files_only` flag of every call."""
    import huggingface_hub
    from huggingface_hub.errors import LocalEntryNotFoundError

    calls: list[bool] = []

    def fake_snapshot_download(repo_id: str, local_files_only: bool = False, **_: Any) -> str:
        calls.append(local_files_only)
        if local_files_only and not cached:
            raise LocalEntryNotFoundError("not cached")
        return str(snapshot)

    monkeypatch.setattr(huggingface_hub, "snapshot_download", fake_snapshot_download)
    return calls


def _fake_kokoro_mlx(monkeypatch: pytest.MonkeyPatch) -> list[str]:
    """A stand-in `kokoro_mlx` that downloads like the real one: only for a non-dir id."""
    import sys
    import types

    import huggingface_hub

    loaded: list[str] = []

    class FakeKokoroTTS:
        @classmethod
        def from_pretrained(cls, model_id_or_path: str) -> str:
            path = model_id_or_path
            if not Path(path).is_dir():
                path = huggingface_hub.snapshot_download(repo_id=path)
            loaded.append(path)
            return path

    monkeypatch.setitem(sys.modules, "kokoro_mlx", types.SimpleNamespace(KokoroTTS=FakeKokoroTTS))
    return loaded


def test_a_cached_tts_model_loads_without_an_online_call(monkeypatch, tmp_path) -> None:
    calls = _fake_hub(monkeypatch, tmp_path, cached=True)
    loaded = _fake_kokoro_mlx(monkeypatch)

    tts_engine._default_loader(REPO_ID)

    assert calls == [True]
    assert loaded == [str(tmp_path)]


def test_an_uncached_tts_model_is_downloaded_once(monkeypatch, tmp_path) -> None:
    calls = _fake_hub(monkeypatch, tmp_path, cached=False)
    loaded = _fake_kokoro_mlx(monkeypatch)

    tts_engine._default_loader(REPO_ID)

    assert calls == [True, False]
    assert loaded == [str(tmp_path)]


def test_a_local_tts_model_dir_skips_the_hub_entirely(monkeypatch, tmp_path) -> None:
    calls = _fake_hub(monkeypatch, tmp_path, cached=True)
    loaded = _fake_kokoro_mlx(monkeypatch)

    tts_engine._default_loader(str(tmp_path))

    assert calls == []
    assert loaded == [str(tmp_path)]
