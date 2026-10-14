"""Reading stats over HTTP, and the hooks that feed it from /api/tts, /api/notes and the LLM.

No real model loads: TTS runs a real TTSEngine on a fake Kokoro model, the LLM a fake
generator with a whitespace tokenizer. Every write lands under tmp_path.
"""

from __future__ import annotations

import inspect
import json
import math
from datetime import datetime
from pathlib import Path

import numpy as np
import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from kokoro_reader import apple_engine, config, llm, notes_store, stats_store
from kokoro_reader.routes import notes as notes_routes
from kokoro_reader.routes import stats as stats_routes
from kokoro_reader.routes import tts as tts_routes
from kokoro_reader.stats_store import StatsStore
from kokoro_reader.tts_engine import TTSEngine

DOC = "c" * 40
NOW = datetime(2026, 7, 4, 16, 5)
SAMPLES_PER_CHAR = 240


class FakeResult:
    def __init__(self, audio: np.ndarray, sample_rate: int) -> None:
        self.audio = audio
        self.sample_rate = sample_rate


class FakeModel:
    def __init__(self) -> None:
        self.calls = 0

    def generate(self, text, voice="af_heart", speed=1.0, sample_rate=config.SAMPLE_RATE):
        self.calls += 1
        t = np.arange(len(text) * SAMPLES_PER_CHAR, dtype=np.float32) / sample_rate
        return FakeResult(np.sin(2 * math.pi * 220.0 * t).astype(np.float32), sample_rate)


class SplitTokenizer:
    """One token per whitespace-separated word, so counts are checkable by hand."""

    chat_template = None

    def encode(self, text: str) -> list[str]:
        return text.split()


@pytest.fixture
def store(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> StatsStore:
    fresh = StatsStore(path_fn=lambda: tmp_path / "stats.json", clock=lambda: NOW,
                       flush_delay=None)
    monkeypatch.setattr(stats_store, "_store", fresh)
    monkeypatch.setattr(config, "DOCS_DIR", tmp_path / "docs")
    monkeypatch.setattr(config, "AUDIO_CACHE_DIR", tmp_path / "audio")
    monkeypatch.setattr(config, "LLM_CACHE_DIR", tmp_path / "llm")
    return fresh


@pytest.fixture
def model(monkeypatch: pytest.MonkeyPatch) -> FakeModel:
    fake = FakeModel()
    engine = TTSEngine(model_id="fake/kokoro", loader=lambda _id: fake)
    monkeypatch.setattr(tts_routes, "get_engine", lambda: engine)
    return fake


@pytest.fixture
def client(store: StatsStore) -> TestClient:
    app = FastAPI()
    for router in (stats_routes.router, notes_routes.router, tts_routes.router):
        app.include_router(router)
    return TestClient(app)


def batch(**over) -> dict:
    return {"doc_id": DOC, "title": "A paper", "voice": "af_aoede", "seconds": 42.5,
            "sentences": 3, "words": 40, "pages": 1, "progress": 0.5, **over}


def test_stats_routes_are_sync_so_file_io_never_blocks_the_loop() -> None:
    for route in stats_routes.router.routes:
        assert not inspect.iscoroutinefunction(route.endpoint), route.path


def test_a_listen_batch_shows_up_in_the_summary(client: TestClient) -> None:
    assert client.post("/api/stats/listen", json=batch()).json() == {"ok": True}

    out = client.get("/api/stats").json()

    assert out["range"] == "2026"
    assert out["listening"]["seconds"] == 42.5 and out["listening"]["words"] == 40
    assert out["hours"][16] == 42.5
    assert out["top_papers"] == [{"doc_id": DOC, "seconds": 42.5, "title": "A paper"}]
    assert out["favorite_voice"] == "af_aoede"


def test_the_year_query_filters_and_all_spans_everything(client, store) -> None:
    client.post("/api/stats/listen", json=batch())

    assert client.get("/api/stats?year=2025").json()["listening"]["seconds"] == 0
    assert client.get("/api/stats?year=all").json()["listening"]["seconds"] == 42.5
    assert client.get("/api/stats?year=all").json()["range"] == "all"
    assert client.get("/api/stats?year=2026").json()["years"] == [2026]


@pytest.mark.parametrize("year", ["20x6", "26", "../1", "all; drop"])
def test_a_bad_year_is_a_400(client: TestClient, year: str) -> None:
    assert client.get("/api/stats", params={"year": year}).status_code == 400


@pytest.mark.parametrize("bad", [{"seconds": -1}, {"doc_id": "../../etc"}, {"voice": "a b"},
                                 {"progress": 1.5}, {"words": "many"}])
def test_a_malformed_batch_is_rejected_and_records_nothing(client, store, bad) -> None:
    assert client.post("/api/stats/listen", json=batch(**bad)).status_code == 422
    assert client.get("/api/stats").json()["listening"]["seconds"] == 0



@pytest.mark.parametrize("field, value", [("seconds", "NaN"), ("seconds", "Infinity"),
                                          ("seconds", "-Infinity"), ("seconds", "1e400"),
                                          ("progress", "NaN"), ("words", "NaN")])
def test_non_finite_numbers_are_a_422_not_a_500(client, store, field, value) -> None:
    body = json.dumps(batch(**{field: 0})).replace(f'"{field}": 0', f'"{field}": {value}')
    reply = client.post("/api/stats/listen", content=body,
                        headers={"Content-Type": "application/json"})

    assert reply.status_code == 422
    assert client.get("/api/stats").json()["listening"]["seconds"] == 0

def test_reset_needs_the_confirm_word_then_clears(client: TestClient) -> None:
    client.post("/api/stats/listen", json=batch())

    assert client.post("/api/stats/reset", json={}).status_code == 400
    assert client.get("/api/stats").json()["listening"]["seconds"] == 42.5
    reply = client.post("/api/stats/reset", json={"confirm": "reset"}).json()

    assert reply["ok"] is True and reply["since"].startswith("2026-07-04T16:05")
    assert client.get("/api/stats").json()["listening"]["seconds"] == 0


def test_opening_a_paper_counts_once_per_notes_load(client: TestClient) -> None:
    client.get(f"/api/notes/{DOC}")
    client.get(f"/api/notes/{'d' * 40}")

    assert client.get("/api/stats").json()["papers"]["opened"] == 2


def test_highlights_and_note_words_come_from_the_notes_records(client: TestClient) -> None:
    record = {"doc_id": DOC, "title": "Noted", "highlights": [
        {"id": "h1", "page": 1, "text": "x", "note": "one two three",
         "created_at": "2026-07-04T10:00:00+00:00",
         "rects": [{"x": 0.1, "y": 0.1, "w": 0.2, "h": 0.02}]}]}
    assert client.put(f"/api/notes/{DOC}", json=record).status_code == 200

    out = client.get("/api/stats").json()

    assert out["notes"]["highlights"] == 1 and out["notes"]["words"] == 3


def test_tts_counts_a_miss_then_a_cache_hit(client: TestClient, model: FakeModel) -> None:
    query = {"text": "The result is clear.", "voice": "af_heart", "speed": 1.0}
    assert client.get("/api/tts", params=query).status_code == 200
    assert client.get("/api/tts", params=query).status_code == 200

    tts = client.get("/api/stats").json()["tts"]

    assert model.calls == 1
    assert tts["requests"] == 2 and tts["hits"] == 1 and tts["misses"] == 1
    assert tts["chars"] == len(query["text"])
    assert 0 < tts["audio_seconds"] < 2


def test_a_failed_synthesis_records_nothing(client: TestClient, monkeypatch) -> None:
    class Broken:
        model_id = "broken"

        def synthesize(self, *args, **kwargs):
            raise RuntimeError("boom")

    monkeypatch.setattr(tts_routes, "get_engine", lambda: Broken())

    assert client.get("/api/tts", params={"text": "hi"}).status_code == 500
    assert client.get("/api/stats").json()["tts"]["requests"] == 0


def test_llm_tokens_are_counted_with_the_tokenizer_and_cache_hits_count_as_saved(
    client: TestClient,
) -> None:
    output = "x sub i squared"
    normalizer = llm.MlxNormalizer(
        model_id="fake/llm", load_fn=lambda _id: (object(), SplitTokenizer()),
        generate_fn=lambda model, tok, prompt, max_tokens: output)
    text = "x_i^2 is small"
    prompt_tokens = len(llm._build_prompt(SplitTokenizer(), text, "equation").split())

    assert normalizer.refine(text, "equation") == output
    assert normalizer.refine(text, "equation") == output   # served from the disk cache

    assert client.get("/api/stats").json()["llm"] == {
        "calls": 1, "tokens_in": prompt_tokens, "tokens_out": 4,
        "hits": 1, "saved_in": prompt_tokens, "saved_out": 4}


def test_a_tokenizer_that_cannot_encode_still_counts_the_call(client: TestClient) -> None:
    normalizer = llm.MlxNormalizer(
        model_id="fake/llm2", load_fn=lambda _id: (object(), object()),
        generate_fn=lambda model, tok, prompt, max_tokens: "spoken words here")

    normalizer.refine("some text here", "body")

    assert client.get("/api/stats").json()["llm"]["calls"] == 1


def test_after_a_reset_older_highlights_no_longer_count(client: TestClient) -> None:
    record = {"doc_id": DOC, "highlights": [
        {"id": "h1", "page": 1, "text": "x", "note": "old note",
         "created_at": "2026-01-02T10:00:00+00:00",
         "rects": [{"x": 0.1, "y": 0.1, "w": 0.2, "h": 0.02}]}]}
    client.put(f"/api/notes/{DOC}", json=record)
    assert client.get("/api/stats").json()["notes"]["highlights"] == 1

    client.post("/api/stats/reset", json={"confirm": "reset"})

    assert client.get("/api/stats").json()["notes"] == {"highlights": 0, "words": 0}


@pytest.fixture
def broken_store(store: StatsStore, monkeypatch: pytest.MonkeyPatch) -> StatsStore:
    """Every recording method of the live store raises, as a full disk or a bug would."""
    def boom(*args, **kwargs):
        raise RuntimeError("stats on fire")

    for name in ("record_tts", "record_llm", "record_open", "record_listen"):
        monkeypatch.setattr(store, name, boom)
    return store


def test_tts_still_returns_audio_when_recording_raises(
    client: TestClient, model: FakeModel, broken_store: StatsStore
) -> None:
    reply = client.get("/api/tts", params={"text": "The result is clear."})

    assert reply.status_code == 200
    assert reply.headers["content-type"] == "audio/wav" and reply.content[:4] == b"RIFF"


def test_llm_miss_and_cache_hit_still_return_text_when_recording_raises(
    broken_store: StatsStore,
) -> None:
    calls = []
    output = "x sub i squared"

    def generate(model, tok, prompt, max_tokens):
        calls.append(prompt)
        return output

    normalizer = llm.MlxNormalizer(
        model_id="fake/llm3", load_fn=lambda _id: (object(), SplitTokenizer()),
        generate_fn=generate)

    assert normalizer.refine("x_i^2 is small", "equation") == output   # miss
    assert normalizer.refine("x_i^2 is small", "equation") == output   # disk-cache hit
    assert len(calls) == 1


def test_a_siri_voice_still_records_tts_stats(client: TestClient, monkeypatch) -> None:
    fake = FakeModel()
    siri = TTSEngine(model_id=apple_engine.MODEL_ID, loader=lambda _id: fake)
    monkeypatch.setattr(tts_routes, "get_apple_engine", lambda: siri)
    query = {"text": "The result is clear.", "voice": "siri_nora"}

    assert client.get("/api/tts", params=query).status_code == 200
    assert client.get("/api/tts", params=query).status_code == 200

    tts = client.get("/api/stats").json()["tts"]
    assert fake.calls == 1
    assert tts["requests"] == 2 and tts["hits"] == 1 and tts["chars"] == len(query["text"])
