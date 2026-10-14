"""N11 and W2: Kokoro phoneme tokens on the stats page, and the "This paper" numbers.

TTS runs a real TTSEngine on a fake Kokoro model whose phonemizer gives one token per
character plus Kokoro's two pad tokens, so counts are checkable by hand, and counts its
own calls, so a second G2P pass is caught. Every write
lands under tmp_path; no real model loads.
"""

from __future__ import annotations

import math
import threading
from datetime import datetime
from pathlib import Path

import numpy as np
import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from kokoro_reader import config, stats_store, stats_summary
from kokoro_reader.routes import stats as stats_routes
from kokoro_reader.routes import tts as tts_routes
from kokoro_reader.stats_store import StatsStore
from kokoro_reader.tts_engine import TTSEngine

DOC = "d" * 40
NOW = datetime(2026, 7, 4, 16, 5)
SAMPLES_PER_CHAR = 240
PADS = 2   # Kokoro wraps every chunk's token ids in a 0 at each end
TEXT = "The result is clear."


class FakeResult:
    def __init__(self, audio: np.ndarray, sample_rate: int) -> None:
        self.audio = audio
        self.sample_rate = sample_rate


class FakePhonemizer:
    """One token per character plus the pads; `calls` counts every G2P pass."""

    def __init__(self, ids_of=lambda text: [0, *([1] * len(text)), 0]) -> None:
        self.ids_of = ids_of
        self.calls = 0

    def phonemize_long(self, text: str) -> list[tuple[str, list[int]]]:
        self.calls += 1
        return [(text, self.ids_of(text))]


class SlottedPhonemizer:
    """A phonemizer whose method cannot be wrapped on the instance."""

    __slots__ = ()

    def phonemize_long(self, text: str) -> list[tuple[str, list[int]]]:
        return [(text, [0, 1, 0])]


class FakeKokoro:
    """kokoro_mlx.KokoroTTS as the counter sees it: a cached phonemizer per language,
    fetched with `_get_phonemizer` and run once per `generate`, under `_lock`."""

    def __init__(self, phonemizer: object | None = None) -> None:
        self._lock = threading.Lock()
        self.phonemizer = phonemizer or FakePhonemizer()

    def _get_phonemizer(self, language: str | None, voice: str) -> object:
        return self.phonemizer

    def generate(self, text, voice="af_heart", speed=1.0, sample_rate=config.SAMPLE_RATE):
        with self._lock:
            self._get_phonemizer(None, voice).phonemize_long(text)
            return FakeResult(tone(text, sample_rate), sample_rate)


class BareModel:
    """A model with none of kokoro_mlx's internals: it only generates."""

    def generate(self, text, voice="af_heart", speed=1.0, sample_rate=config.SAMPLE_RATE):
        return FakeResult(tone(text, sample_rate), sample_rate)


def tone(text: str, sample_rate: int) -> np.ndarray:
    t = np.arange(len(text) * SAMPLES_PER_CHAR, dtype=np.float32) / sample_rate
    return np.sin(2 * math.pi * 220.0 * t).astype(np.float32)


@pytest.fixture
def store(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> StatsStore:
    fresh = StatsStore(path_fn=lambda: tmp_path / "stats.json", clock=lambda: NOW,
                       flush_delay=None)
    monkeypatch.setattr(stats_store, "_store", fresh)
    monkeypatch.setattr(config, "DOCS_DIR", tmp_path / "docs")
    monkeypatch.setattr(config, "AUDIO_CACHE_DIR", tmp_path / "audio")
    return fresh


def client_for(model: object, monkeypatch: pytest.MonkeyPatch) -> TestClient:
    engine = TTSEngine(model_id="fake/kokoro", loader=lambda _id: model)
    monkeypatch.setattr(tts_routes, "get_engine", lambda: engine)
    app = FastAPI()
    for router in (stats_routes.router, tts_routes.router):
        app.include_router(router)
    return TestClient(app)


def tts_summary(client: TestClient) -> dict:
    return client.get("/api/stats").json()["tts"]


# ── W2: phoneme tokens ───────────────────────────────────────────────────────
def test_a_miss_counts_the_tokens_from_kokoros_own_single_g2p_pass(store, monkeypatch) -> None:
    model = FakeKokoro()
    client = client_for(model, monkeypatch)

    assert client.get("/api/tts", params={"text": TEXT}).status_code == 200

    assert tts_summary(client)["tokens"] == len(TEXT) + PADS
    assert model.phonemizer.calls == 1, "counting must not run G2P a second time"


def test_each_miss_counts_its_own_tokens_once(store, monkeypatch) -> None:
    model = FakeKokoro()
    client = client_for(model, monkeypatch)

    for text in (TEXT, "Another one."):
        client.get("/api/tts", params={"text": text})

    assert tts_summary(client)["tokens"] == len(TEXT) + len("Another one.") + 2 * PADS
    assert model.phonemizer.calls == 2


def test_a_cache_hit_adds_no_tokens_and_counts_the_ones_it_saved(store, monkeypatch) -> None:
    model = FakeKokoro()
    client = client_for(model, monkeypatch)

    client.get("/api/tts", params={"text": TEXT})
    client.get("/api/tts", params={"text": TEXT})

    tts = tts_summary(client)
    assert tts["hits"] == 1 and tts["tokens"] == len(TEXT) + PADS
    assert tts["tokens_saved"] == len(TEXT) + PADS, "estimated at the generated tokens-per-char rate"
    assert model.phonemizer.calls == 1


@pytest.mark.parametrize("model", [
    FakeKokoro(FakePhonemizer(ids_of=lambda text: len(text))),   # ids the counter cannot size
    FakeKokoro(SlottedPhonemizer()),                              # cannot be wrapped
    BareModel(),                                                  # no kokoro_mlx internals
], ids=["odd-ids", "unwrappable", "bare-model"])
def test_a_counter_that_cannot_count_counts_zero_and_never_fails_synthesis(
        model, store, monkeypatch) -> None:
    client = client_for(model, monkeypatch)

    reply = client.get("/api/tts", params={"text": TEXT})

    assert reply.status_code == 200 and reply.content[:4] == b"RIFF"
    assert tts_summary(client)["tokens"] == 0 and tts_summary(client)["requests"] == 1


def test_a_stats_store_failure_never_fails_synthesis(store, monkeypatch) -> None:
    def boom(*args, **kwargs):
        raise RuntimeError("stats on fire")

    monkeypatch.setattr(store, "record_tokens", boom)
    client = client_for(FakeKokoro(), monkeypatch)

    assert client.get("/api/tts", params={"text": TEXT}).status_code == 200


def test_the_token_facade_never_raises(monkeypatch: pytest.MonkeyPatch) -> None:
    def broken() -> StatsStore:
        raise RuntimeError("disk on fire")

    monkeypatch.setattr(stats_store, "get_store", broken)
    stats_store.record_tokens(12)


def test_a_stats_file_from_before_tokens_reads_them_as_zero() -> None:
    day = {"tts": {"requests": 3, "hits": 1, "chars": 40, "audio_s": 2.0}}
    clean = stats_store.clean_stats({"version": 1, "since": "", "days": {"2026-07-04": day},
                                     "docs": {}})

    tts = stats_summary.summarize(clean, None, [])["tts"]
    assert tts["tokens"] == 0 and tts["tokens_saved"] == 0


# ── N11: "This paper" ────────────────────────────────────────────────────────
def listen(store: StatsStore, seconds: float, progress: float = 0.25) -> None:
    store.record_listen({"doc_id": DOC, "title": "Paper D", "voice": "af_aoede",
                         "seconds": seconds, "sentences": 2, "words": 20, "pages": 0,
                         "progress": progress})


def test_the_paper_totals_every_day_whatever_the_period(tmp_path: Path) -> None:
    clock = {"at": datetime(2025, 12, 31, 22, 0)}
    store = StatsStore(path_fn=lambda: tmp_path / "s.json", clock=lambda: clock["at"],
                       flush_delay=None)
    listen(store, 60.0)
    clock["at"] = datetime(2026, 1, 2, 9, 0)
    listen(store, 30.0, progress=0.5)

    paper = stats_summary.summarize(store.snapshot(), 2026, [], doc_id=DOC)["paper"]

    assert paper == {"doc_id": DOC, "title": "Paper D", "seconds": 90.0, "progress": 0.5,
                     "finished": None}


def test_no_paper_without_a_doc_and_zero_for_an_unknown_one(store: StatsStore) -> None:
    assert stats_summary.summarize(store.snapshot(), 2026, [])["paper"] is None
    unknown = stats_summary.summarize(store.snapshot(), 2026, [], doc_id=DOC)["paper"]
    assert unknown == {"doc_id": DOC, "title": "", "seconds": 0, "progress": 0.0, "finished": None}


def test_the_doc_query_adds_the_paper_and_a_bad_one_is_a_400(store, monkeypatch) -> None:
    client = client_for(FakeKokoro(), monkeypatch)
    listen(store, 42.0)

    assert client.get("/api/stats", params={"doc": DOC}).json()["paper"]["seconds"] == 42.0
    assert client.get("/api/stats").json()["paper"] is None
    assert client.get("/api/stats", params={"doc": "../etc"}).status_code == 400
