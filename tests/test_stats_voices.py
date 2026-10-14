"""R8: Kokoro phoneme tokens and characters voiced, broken down per voice.

Siri has no phoneme tokens, so it records characters only and its tokens read as None.
Runs a real TTSEngine on the fake Kokoro from test_stats_eta_tokens; nothing loads a model.
"""

from __future__ import annotations

import io
import json
import wave
from pathlib import Path

from fastapi import FastAPI
from fastapi.testclient import TestClient

from kokoro_reader import apple_engine, stats_store, stats_summary
from kokoro_reader.apple_engine import AppleModel
from kokoro_reader.routes import stats as stats_routes
from kokoro_reader.routes import tts as tts_routes
from kokoro_reader.stats_store import StatsStore
from kokoro_reader.tts_engine import TTSEngine
from tests.test_stats_eta_tokens import NOW, PADS, TEXT, FakeKokoro, store  # noqa: F401

SIRI = "siri_nora"
OTHER_TEXT = "Another one."


def short_wav() -> bytes:
    buf = io.BytesIO()
    with wave.open(buf, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(24_000)
        w.writeframes(b"\x01\x00" * 2400)
    return buf.getvalue()


class WavHost:
    """apple_host.swift as AppleModel sees it: writes a WAV to the requested path."""

    def ask(self, request: dict) -> dict:
        Path(request["out"]).write_bytes(short_wav())
        return {"ok": True}


def client(monkeypatch, siri: TTSEngine | None = None) -> TestClient:
    kokoro = TTSEngine(model_id="fake/kokoro", loader=lambda _id: FakeKokoro())
    monkeypatch.setattr(tts_routes, "get_engine", lambda: kokoro)
    if siri is not None:
        monkeypatch.setattr(tts_routes, "get_apple_engine", lambda: siri)
    app = FastAPI()
    for router in (stats_routes.router, tts_routes.router):
        app.include_router(router)
    return TestClient(app)


def by_voice(c: TestClient) -> list[dict]:
    return c.get("/api/stats").json()["tts"]["by_voice"]


def say(c: TestClient, text: str, voice: str) -> None:
    assert c.get("/api/tts", params={"text": text, "voice": voice}).status_code == 200


def test_each_kokoro_voice_gets_its_own_tokens_and_characters(store, monkeypatch) -> None:
    c = client(monkeypatch)
    say(c, TEXT, "af_aoede")
    say(c, OTHER_TEXT, "bm_george")
    say(c, OTHER_TEXT, "af_aoede")

    rows = {row["voice"]: row for row in by_voice(c)}
    assert rows["af_aoede"] == {"voice": "af_aoede", "tokens": len(TEXT) + len(OTHER_TEXT) + 2 * PADS,
                                "chars": len(TEXT) + len(OTHER_TEXT)}
    assert rows["bm_george"] == {"voice": "bm_george", "tokens": len(OTHER_TEXT) + PADS,
                                 "chars": len(OTHER_TEXT)}
    tts = c.get("/api/stats").json()["tts"]
    assert sum(r["tokens"] for r in rows.values()) == tts["tokens"], "the rows add up to the total"
    assert sum(r["chars"] for r in rows.values()) == tts["chars"]


def test_the_rows_are_ranked_by_characters_voiced(store, monkeypatch) -> None:
    c = client(monkeypatch)
    say(c, "Hi.", "bm_george")
    say(c, TEXT, "af_aoede")
    assert [r["voice"] for r in by_voice(c)] == ["af_aoede", "bm_george"]


def test_a_cache_hit_adds_nothing_to_its_voice(store, monkeypatch) -> None:
    c = client(monkeypatch)
    say(c, TEXT, "af_aoede")
    say(c, TEXT, "af_aoede")
    assert by_voice(c) == [{"voice": "af_aoede", "tokens": len(TEXT) + PADS, "chars": len(TEXT)}]


def test_siri_counts_characters_and_has_no_tokens(store, monkeypatch) -> None:
    siri = TTSEngine(model_id=apple_engine.MODEL_ID, loader=lambda _id: AppleModel(host=WavHost()))
    c = client(monkeypatch, siri)
    say(c, TEXT, SIRI)
    assert by_voice(c) == [{"voice": SIRI, "tokens": None, "chars": len(TEXT)}]


def test_the_store_keeps_both_maps_per_day(tmp_path: Path) -> None:
    s = StatsStore(path_fn=lambda: tmp_path / "s.json", clock=lambda: NOW, flush_delay=None)
    s.record_tts(10, 1.0, hit=False, voice="af_aoede")
    s.record_tts(10, 0.0, hit=True, voice="af_aoede")
    s.record_tts(5, 1.0, hit=False)
    s.record_tokens(12, "af_aoede")
    s.record_tokens(3)
    day = s.snapshot()["days"][NOW.strftime(stats_store.DAY_FORMAT)]
    assert day["voice_chars"] == {"af_aoede": 10}
    assert day["voice_tokens"] == {"af_aoede": 12}
    assert day["tts"]["chars"] == 15 and day["tts"]["tokens"] == 15, "totals still count everything"


def test_the_facades_pass_the_voice_through(store) -> None:
    stats_store.record_tts(4, short_wav(), hit=False, voice="af_aoede")
    stats_store.record_tokens(6, "af_aoede")
    day = store.snapshot()["days"][NOW.strftime(stats_store.DAY_FORMAT)]
    assert (day["voice_chars"], day["voice_tokens"]) == ({"af_aoede": 4}, {"af_aoede": 6})


def test_a_stats_file_from_before_r8_keeps_every_total(tmp_path: Path) -> None:
    old_day = {"listen_s": 60, "sentences": 4, "words": 40, "pages": 1,
               "hours": {"16": 60}, "voices": {"af_aoede": 60}, "docs": {}, "opens": {},
               "finished": [], "tts": {"requests": 3, "hits": 1, "chars": 40, "audio_s": 2.0,
                                       "tokens": 44, "saved_chars": 20},
               "llm": {"calls": 0, "tokens_in": 0, "tokens_out": 0, "hits": 0,
                       "saved_in": 0, "saved_out": 0}}
    path = tmp_path / "stats.json"
    path.write_text(json.dumps({"version": 1, "since": "", "days": {"2026-07-04": old_day},
                                "docs": {}}))

    s = StatsStore(path_fn=lambda: path, clock=lambda: NOW, flush_delay=None)
    summary = stats_summary.summarize(s.snapshot(), None, [])

    assert summary["tts"]["tokens"] == 44 and summary["tts"]["chars"] == 40
    assert summary["tts"]["requests"] == 3 and summary["listening"]["seconds"] == 60
    assert summary["voices"] == [{"voice": "af_aoede", "seconds": 60}]
    assert summary["tts"]["by_voice"] == []
    s.record_tokens(5, "af_aoede")
    s.flush()
    saved = json.loads(path.read_text())["days"]["2026-07-04"]
    assert saved["tts"]["tokens"] == 49 and saved["voice_tokens"] == {"af_aoede": 5}
    assert saved["listen_s"] == 60 and saved["voices"] == {"af_aoede": 60}


def test_junk_in_the_new_maps_is_dropped_on_load() -> None:
    day = {"voice_tokens": {"af_aoede": 7, "bad": -1, "worse": "x"}, "voice_chars": "nope"}
    clean = stats_store.clean_stats({"days": {"2026-07-04": day}})
    row = clean["days"]["2026-07-04"]
    assert row["voice_tokens"] == {"af_aoede": 7} and row["voice_chars"] == {}
