"""Page summaries (N9): POST /api/summary, its cache, and the Apple / Qwen backends.

No model runs here: the Apple path's subprocess and the Qwen worker are faked. The one real
call is opt-in: `KOKORO_LIVE_APPLE=1 pytest tests/test_summary.py -k live`.
"""

from __future__ import annotations

import inspect
import json
import os
import subprocess
import time
from pathlib import Path
from typing import Any

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from kokoro_reader import config, llm, stats_store, summary
from kokoro_reader.routes import summary as summary_routes

DOC = "d" * 40
PAGE_TEXT = (
    "We evaluate the model on 12 benchmarks spanning reasoning, coding and maths. On GSM8K it "
    "reaches 84.2 percent accuracy, within 0.4 points of the much larger baseline. Training ran "
    "for 21 days on 256 accelerators. Removing the curriculum stage costs 5.7 points on average."
)
GOOD = (
    "Benchmark results\n"
    "Evaluates the model on 12 benchmarks against a larger baseline.\n"
    "- GSM8K: 84.2 percent, within 0.4 points of baseline\n"
    "- Training: 21 days on 256 accelerators"
)
#: What the route answers for GOOD: the notes, and their flat text for reading aloud.
GOOD_NOTES = {
    "heading": "Benchmark results",
    "context": "Evaluates the model on 12 benchmarks against a larger baseline.",
    "points": ["GSM8K: 84.2 percent, within 0.4 points of baseline", "Training: 21 days on 256 accelerators"],
    "summary": "Benchmark results. Evaluates the model on 12 benchmarks against a larger baseline. "
               "GSM8K: 84.2 percent, within 0.4 points of baseline. Training: 21 days on 256 accelerators.",
}


class FakeBackend:
    """Stands in for one backend call: counts calls, returns a reply or raises."""

    def __init__(self, reply: str = GOOD, tokens: tuple[int, int] = (120, 30), error: Exception | None = None):
        self.reply, self.tokens, self.error = reply, tokens, error
        self.calls: list[tuple[str, str]] = []

    def __call__(self, instructions: str, text: str) -> tuple[str, int, int]:
        self.calls.append((instructions, text))
        if self.error is not None:
            raise self.error
        return (self.reply, *self.tokens)


@pytest.fixture(autouse=True)
def isolated(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> list[tuple[int, int, bool]]:
    """Own cache dir, and LLM token records captured instead of written."""
    monkeypatch.setattr(config, "CACHE_DIR", tmp_path / "cache")
    recorded: list[tuple[int, int, bool]] = []
    monkeypatch.setattr(stats_store, "record_llm", lambda tin, tout, hit=False: recorded.append((tin, tout, hit)))
    llm.reset_normalizers()
    yield recorded
    llm.reset_normalizers()


@pytest.fixture
def apple(monkeypatch: pytest.MonkeyPatch) -> FakeBackend:
    fake = FakeBackend()
    monkeypatch.setattr(summary, "_ask_apple", fake)
    return fake


@pytest.fixture
def client() -> TestClient:
    app = FastAPI()
    app.include_router(summary_routes.router)
    return TestClient(app)


def body(**over: Any) -> dict:
    return {"doc_id": DOC, "page": 3, "text": PAGE_TEXT, "backend": "apple", **over}


# ── the route ────────────────────────────────────────────────────────────────

def test_summary_route_is_sync_so_a_model_call_never_blocks_the_loop() -> None:
    for route in summary_routes.router.routes:
        assert not inspect.iscoroutinefunction(route.endpoint), route.path


@pytest.mark.parametrize("over", [
    {"backend": "gpt"},                                   # not in the enum
    {"text": ""},
    {"text": "   \n "},
    {"text": "x" * (summary.MAX_TEXT_CHARS + 1)},
    {"doc_id": "../../etc"},
    {"page": 0},
    {"page": "two"},
])
def test_bad_input_is_a_422_and_never_reaches_a_model(client: TestClient, apple: FakeBackend, over: dict) -> None:
    assert client.post("/api/summary", json=body(**over)).status_code == 422
    assert apple.calls == []


def test_a_summary_is_made_once_then_served_from_the_cache(
    client: TestClient, apple: FakeBackend, isolated: list, tmp_path: Path
) -> None:
    first = client.post("/api/summary", json=body()).json()
    second = client.post("/api/summary", json=body(page=9)).json()   # same text elsewhere: same summary

    assert first == {**GOOD_NOTES, "backend": "apple", "cached": False}
    assert second == {**GOOD_NOTES, "backend": "apple", "cached": True}
    assert len(apple.calls) == 1
    assert len(list((tmp_path / "cache" / summary.CACHE_SUBDIR).glob("*.json"))) == 1
    assert isolated == [(120, 30, False), (120, 30, True)]   # a hit counts as tokens saved


def test_the_prompt_asks_for_oxford_notes_that_keep_numbers_and_names(apple: FakeBackend, client: TestClient) -> None:
    client.post("/api/summary", json=body())
    instructions, text = apple.calls[0]
    assert text == PAGE_TEXT
    for phrase in ("heading", "context", "bullet", "3 to 7", "number", "name", "Never add facts"):
        assert phrase in instructions


def test_the_cache_key_covers_backend_model_prompt_version_and_text() -> None:
    base = summary.cache_key("apple", "m", PAGE_TEXT)
    assert len({base, summary.cache_key("qwen", "m", PAGE_TEXT), summary.cache_key("apple", "m2", PAGE_TEXT),
                summary.cache_key("apple", "m", PAGE_TEXT + "!")}) == 4
    assert base == summary.cache_key("apple", "m", PAGE_TEXT)


def test_an_unavailable_backend_is_a_503_with_its_reason_and_nothing_is_cached(
    client: TestClient, monkeypatch: pytest.MonkeyPatch, tmp_path: Path, isolated: list
) -> None:
    reason = "Apple Intelligence is turned off in System Settings"
    monkeypatch.setattr(summary, "_ask_apple", FakeBackend(error=summary.SummaryUnavailable(reason)))

    res = client.post("/api/summary", json=body())

    assert res.status_code == 503
    assert res.json()["detail"] == reason
    assert not (tmp_path / "cache" / summary.CACHE_SUBDIR).exists()
    assert isolated == []


def test_a_failed_or_timed_out_call_is_a_502_and_the_next_request_tries_again(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(summary, "_ask_apple", FakeBackend(error=summary.SummaryFailed("timed out after 60 s")))
    res = client.post("/api/summary", json=body())
    assert res.status_code == 502 and "timed out" in res.json()["detail"]

    monkeypatch.setattr(summary, "_ask_apple", FakeBackend())
    assert client.post("/api/summary", json=body()).json()["cached"] is False


@pytest.mark.parametrize("raw", ["", "   ", "I'm sorry, but I can't help with that.", "As an AI, I cannot summarise."])
def test_an_unusable_reply_is_a_502_and_is_not_cached(
    client: TestClient, monkeypatch: pytest.MonkeyPatch, raw: str, tmp_path: Path
) -> None:
    monkeypatch.setattr(summary, "_ask_apple", FakeBackend(reply=raw))
    assert client.post("/api/summary", json=body()).status_code == 502
    assert not list((tmp_path / "cache").rglob("*.json"))


def test_markdown_and_think_blocks_are_stripped_from_a_reply(client: TestClient, monkeypatch: pytest.MonkeyPatch) -> None:
    raw = "<think>hmm</think>## **Results**\nScores on the test set.\n- The model scored **84.2 percent**.\n- Training took `21` days."
    monkeypatch.setattr(summary, "_ask_apple", FakeBackend(reply=raw))
    got = client.post("/api/summary", json=body()).json()
    assert (got["heading"], got["context"]) == ("Results", "Scores on the test set.")
    assert got["points"] == ["The model scored 84.2 percent.", "Training took 21 days."]


@pytest.mark.parametrize("raw, heading, context, points", [
    # The Apple model's habits, measured 2026-10-13 (docs/17): bold heading, doubled markers.
    ("**Topic**  \nWhy it matters.\n- - First idea  \n- - Second idea", "Topic", "Why it matters.", ["First idea", "Second idea"]),
    ("Topic:\nWhy.\n1. One\n2) Two\n* Three\n• Four", "Topic", "Why.", ["One", "Two", "Three", "Four"]),
    ("Heading: Topic\nContext: Why it matters.\n- One", "Topic", "Why it matters.", ["One"]),
    # A bullet the model wrapped onto a second line is one idea, not a stray line.
    ("Topic\nWhy.\n- One idea that\n  runs on\n- Two", "Topic", "Why.", ["One idea that runs on", "Two"]),
    # A second block (sub-heading, context) after the bullets stays apart: never glued onto a point.
    ("Topic\nWhy.\n- One\nSecond section\nIt covers more.\n- Two", "Topic", "Why.",
     ["One", "Second section", "It covers more.", "Two"]),
    # A minus sign is content, not a marker.
    ("Topic\nWhy.\n- -5.7 points without the curriculum", "Topic", "Why.", ["-5.7 points without the curriculum"]),
    # Bullets alone: no heading or context to show.
    ("- One\n- Two", "", "", ["One", "Two"]),
    # Prose (the model ignored the layout): its first sentence is the context, the rest the points.
    ("It was tested on 12 benchmarks. It scored 84.2 percent. Training took 21 days.", "",
     "It was tested on 12 benchmarks.", ["It scored 84.2 percent.", "Training took 21 days."]),
])
def test_a_reply_is_read_as_heading_context_and_points(raw, heading, context, points) -> None:
    notes = summary.parse_notes(raw, PAGE_TEXT)
    assert (notes.heading, notes.context, list(notes.points)) == (heading, context, points)


def test_a_point_cut_off_by_the_token_cap_is_dropped(client: TestClient, monkeypatch: pytest.MonkeyPatch) -> None:
    cut = f"{GOOD}\n- Ablation: removing the curric"
    monkeypatch.setattr(summary, "_ask_apple", FakeBackend(reply=cut, tokens=(120, summary.MAX_SUMMARY_TOKENS)))
    assert client.post("/api/summary", json=body()).json()["points"] == GOOD_NOTES["points"]


def test_a_reply_under_the_token_cap_keeps_every_point(client: TestClient, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(summary, "_ask_apple", FakeBackend(tokens=(120, summary.MAX_SUMMARY_TOKENS - 1)))
    assert client.post("/api/summary", json=body()).json()["points"] == GOOD_NOTES["points"]


def test_a_first_line_too_long_for_a_heading_is_the_context() -> None:
    first = "This page sets out " + "a long account of the method " * 6
    notes = summary.parse_notes(f"{first}\n- One", PAGE_TEXT + " " + first)
    assert (notes.heading, notes.context) == ("", first.strip())


def test_the_spoken_text_reads_heading_context_then_each_point_as_a_sentence() -> None:
    notes = summary.parse_notes("Topic\nWhy it matters\n- One!\n- Two?\n- Three", PAGE_TEXT)
    assert notes.spoken == "Topic. Why it matters. One! Two? Three."


def test_a_reply_longer_than_the_page_is_rejected(client: TestClient, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(summary, "_ask_apple", FakeBackend(reply=PAGE_TEXT + " " + "More words. " * 40))
    assert client.post("/api/summary", json=body()).status_code == 502


# ── Apple backend: the swift subprocess ──────────────────────────────────────

def fake_run(stdout: str = "", error: Exception | None = None):
    seen: dict = {}

    def run(cmd, **kwargs):
        seen.update(cmd=cmd, **kwargs)
        if error is not None:
            raise error
        return subprocess.CompletedProcess(cmd, 0, stdout=stdout, stderr="")
    return run, seen


def test_apple_sends_one_json_request_with_a_timeout_and_reads_the_usage(monkeypatch: pytest.MonkeyPatch) -> None:
    run, seen = fake_run(json.dumps({"ok": True, "summary": GOOD, "tokens_in": 209, "tokens_out": 121}))
    monkeypatch.setattr(summary.subprocess, "run", run)

    assert summary._ask_apple("be brief", PAGE_TEXT) == (GOOD, 209, 121)
    assert seen["timeout"] == summary.APPLE_TIMEOUT_S
    assert seen["cmd"][-1].endswith("apple_summary.swift")
    assert json.loads(seen["input"]) == {"instructions": "be brief", "text": PAGE_TEXT,
                                         "max_tokens": summary.MAX_SUMMARY_TOKENS}


@pytest.mark.parametrize("stdout, error, expected", [
    ('{"ok": false, "unavailable": true, "error": "model is still downloading"}', None, summary.SummaryUnavailable),
    ("", FileNotFoundError("swift"), summary.SummaryUnavailable),
    ("", subprocess.TimeoutExpired("swift", 60), summary.SummaryFailed),
    ('{"ok": false, "unavailable": false, "error": "guardrail"}', None, summary.SummaryFailed),
    ("error: no such module 'FoundationModels'", None, summary.SummaryFailed),
])
def test_apple_failures_map_to_unavailable_or_failed(monkeypatch, stdout: str, error, expected) -> None:
    run, _ = fake_run(stdout, error)
    monkeypatch.setattr(summary.subprocess, "run", run)
    with pytest.raises(expected):
        summary._ask_apple("be brief", PAGE_TEXT)


# ── Qwen backend: llm.py's worker ────────────────────────────────────────────

class SplitTokenizer:
    chat_template = None

    def encode(self, text: str) -> list[str]:
        return text.split()


def test_qwen_runs_on_the_llm_worker_with_its_own_validation(client: TestClient, monkeypatch, isolated: list) -> None:
    short = "Twelve benchmarks, 84.2 percent."      # far under refine's 0.3x length floor: fine for a summary
    prompts: list[str] = []

    def generate(_m, _t, prompt: str, max_tokens: int) -> str:
        prompts.append(prompt)
        return short
    normalizer = llm.MlxNormalizer(model_id="fake/qwen", generate_fn=generate,
                                   load_fn=lambda _id: (object(), SplitTokenizer()))
    monkeypatch.setattr(llm, "get_normalizer", lambda _use: normalizer)

    got = client.post("/api/summary", json=body(backend="qwen")).json()

    assert got == {"heading": "", "context": short, "points": [], "summary": short, "backend": "qwen", "cached": False}
    assert summary.INSTRUCTIONS in prompts[0] and PAGE_TEXT in prompts[0]
    assert isolated[0][1] == len(short.split()) and isolated[0][0] > len(PAGE_TEXT.split())


def test_qwen_unavailable_is_a_503(client: TestClient, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(llm, "get_normalizer", lambda _use: llm.NullNormalizer())
    res = client.post("/api/summary", json=body(backend="qwen"))
    assert res.status_code == 503 and "Qwen" in res.json()["detail"]


def test_qwen_timeout_is_a_502(client: TestClient, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(config, "LLM_TIMEOUT_S", 0.05)
    normalizer = llm.MlxNormalizer(model_id="fake/slow", generate_fn=lambda *_a: time.sleep(0.5) or GOOD,
                                   load_fn=lambda _id: (object(), SplitTokenizer()))
    monkeypatch.setattr(llm, "get_normalizer", lambda _use: normalizer)
    assert client.post("/api/summary", json=body(backend="qwen")).status_code == 502


# ── live (opt-in) ────────────────────────────────────────────────────────────

@pytest.mark.skipif(os.environ.get("KOKORO_LIVE_APPLE") != "1", reason="needs macOS 26+ with Apple Intelligence; opt-in")
def test_live_apple_summary() -> None:
    started = time.monotonic()
    try:
        text, tokens_in, tokens_out = summary._ask_apple(summary.INSTRUCTIONS, PAGE_TEXT)
    except summary.SummaryUnavailable as exc:
        pytest.skip(f"Apple model unavailable: {exc}")
    elapsed = time.monotonic() - started
    print(f"\nlive apple: {elapsed:.2f} s, {len(text)} chars, tokens {tokens_in}/{tokens_out}: {text}")
    notes = summary.parse_notes(text, PAGE_TEXT)
    assert notes.points and len(notes.spoken) <= len(PAGE_TEXT) + summary.SUMMARY_SLACK_CHARS
    assert elapsed < summary.APPLE_TIMEOUT_S
