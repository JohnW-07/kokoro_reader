"""Reading stats: the store (aggregation, persistence, recovery, bounds) and the summary.

Every store here writes under tmp_path with an injected clock; nothing reaches the
user's data dir and no timer thread is started unless a test asks for one.
"""

from __future__ import annotations

import io
import json
import time
import wave
from datetime import datetime
from pathlib import Path

import pytest

from kokoro_reader import stats_store, stats_summary
from kokoro_reader.stats_store import MAX_DAYS, MAX_DOCS, MAX_KEYS_PER_DAY, StatsStore

DOC_A = "a" * 40
DOC_B = "b" * 40
SAMPLE_RATE = 24_000


class Clock:
    """A settable clock; the store reads it on every record."""

    def __init__(self, at: datetime) -> None:
        self.at = at

    def __call__(self) -> datetime:
        return self.at


@pytest.fixture
def clock() -> Clock:
    return Clock(datetime(2026, 3, 14, 9, 30))


@pytest.fixture
def path(tmp_path: Path) -> Path:
    return tmp_path / "stats.json"


@pytest.fixture
def store(path: Path, clock: Clock) -> StatsStore:
    return StatsStore(path_fn=lambda: path, clock=clock, flush_delay=None)


def listen(store: StatsStore, **batch) -> None:
    store.record_listen({"doc_id": DOC_A, "title": "Paper A", "voice": "af_aoede",
                         "seconds": 60.0, "sentences": 4, "words": 50, "pages": 1,
                         "progress": 0.1, **batch})


def summary(store: StatsStore, year: int | None = 2026, records=()) -> dict:
    return stats_summary.summarize(store.snapshot(), year, list(records))


def wav_bytes(seconds: float) -> bytes:
    buffer = io.BytesIO()
    with wave.open(buffer, "wb") as writer:
        writer.setnchannels(1)
        writer.setsampwidth(2)
        writer.setframerate(SAMPLE_RATE)
        writer.writeframes(b"\0\0" * int(seconds * SAMPLE_RATE))
    return buffer.getvalue()


# ── aggregation ──────────────────────────────────────────────────────────────
def test_listen_batches_on_one_day_add_up(store: StatsStore, clock: Clock) -> None:
    listen(store)
    clock.at = clock.at.replace(hour=21)
    listen(store, seconds=30.0, voice="bm_george", doc_id=DOC_B, title="Paper B")

    out = summary(store)

    assert out["listening"] == {"seconds": 90.0, "sentences": 8, "words": 100,
                                "pages": 2, "days": 1}
    assert out["hours"][9] == 60.0 and out["hours"][21] == 30.0 and sum(out["hours"]) == 90.0
    assert out["favorite_voice"] == "af_aoede"
    assert [p["title"] for p in out["top_papers"]] == ["Paper A", "Paper B"]


def test_top_papers_keep_five_and_fall_back_to_the_notes_title(store: StatsStore) -> None:
    for n in range(7):
        listen(store, doc_id=f"{n:x}" * 8, title="", seconds=float(10 + n))

    out = summary(store, records=[{"doc_id": "6" * 8, "title": "From notes"}])

    assert len(out["top_papers"]) == 5
    assert out["top_papers"][0] == {"doc_id": "6" * 8, "seconds": 16.0, "title": "From notes"}
    assert out["top_papers"][1]["title"] == stats_summary.UNTITLED


def test_year_filter_keeps_other_years_out(store: StatsStore, clock: Clock) -> None:
    listen(store, seconds=100.0)
    clock.at = datetime(2025, 12, 31, 23, 0)
    listen(store, seconds=7.0)

    assert summary(store, 2026)["listening"]["seconds"] == 100.0
    assert summary(store, 2025)["listening"]["seconds"] == 7.0
    assert summary(store, None)["listening"]["seconds"] == 107.0
    assert summary(store, None)["years"] == [2026, 2025]
    assert summary(store, 2024)["listening"]["seconds"] == 0


def test_opens_count_distinct_papers(store: StatsStore) -> None:
    store.record_open(DOC_A)
    store.record_open(DOC_A)
    store.record_open(DOC_B)

    assert summary(store)["papers"]["opened"] == 2


def test_a_paper_finishes_once_when_progress_crosses_ninety_percent(
    store: StatsStore, clock: Clock
) -> None:
    listen(store, progress=0.89)
    assert summary(store)["papers"]["finished"] == 0
    listen(store, progress=0.95)
    clock.at = clock.at.replace(day=15)
    listen(store, progress=1.0)

    snap = store.snapshot()
    assert summary(store)["papers"]["finished"] == 1
    assert snap["docs"][DOC_A]["finished"] == "2026-03-14"


def test_tts_counts_hits_and_misses_and_audio_only_when_generated(store: StatsStore) -> None:
    store.record_tts(40, stats_store.wav_seconds(wav_bytes(2.0)), hit=False)
    store.record_tts(40, 0.0, hit=True)

    tts = summary(store)["tts"]

    assert tts == {"requests": 2, "hits": 1, "misses": 1, "hit_rate": 0.5,
                   "chars": 40, "audio_seconds": pytest.approx(2.0), "tokens": 0,
                   "tokens_saved": 0, "by_voice": []}, "no voice given: totals only"


def test_llm_calls_and_cache_savings_are_kept_apart(store: StatsStore) -> None:
    store.record_llm(120, 30, hit=False)
    store.record_llm(120, 30, hit=True)

    assert summary(store)["llm"] == {"calls": 1, "tokens_in": 120, "tokens_out": 30,
                                     "hits": 1, "saved_in": 120, "saved_out": 30}


def test_wav_seconds_reads_the_header_and_tolerates_junk() -> None:
    assert stats_store.wav_seconds(wav_bytes(1.5)) == pytest.approx(1.5)
    assert stats_store.wav_seconds(b"not a wav") == 0.0


# ── derived numbers ──────────────────────────────────────────────────────────
def test_longest_streak_finds_the_longest_consecutive_run() -> None:
    days = ["2026-01-30", "2026-01-31", "2026-02-01", "2026-02-03", "2026-02-04"]

    assert stats_summary.longest_streak(days) == {
        "days": 3, "start": "2026-01-30", "end": "2026-02-01"}
    assert stats_summary.longest_streak([]) == {"days": 0, "start": None, "end": None}


def test_an_open_without_listening_still_extends_the_streak(
    store: StatsStore, clock: Clock
) -> None:
    listen(store)
    clock.at = clock.at.replace(day=15)
    store.record_open(DOC_B)

    assert summary(store)["longest_streak"]["days"] == 2


def test_busiest_day_is_the_one_with_most_listening(store: StatsStore, clock: Clock) -> None:
    listen(store, seconds=50.0)
    clock.at = clock.at.replace(day=20)
    listen(store, seconds=500.0)

    assert summary(store)["busiest_day"] == {"date": "2026-03-20", "seconds": 500.0}
    assert stats_summary.busiest_day({}) is None


def test_notes_tally_counts_this_years_highlights_and_note_words() -> None:
    records = [{
        "doc_id": DOC_A, "updated_at": "2026-05-01T10:00:00+00:00",
        "highlights": [
            {"created_at": "2026-05-01T10:00:00+00:00", "note": "three little words"},
            {"created_at": "2025-05-01T10:00:00+00:00", "note": "last year"},
        ],
        "blocks": [{"text": "a block of five words"}],
    }]

    assert stats_summary.notes_tally(records, 2026, "2026-01-01T00:00:00+00:00") == {
        "highlights": 1, "words": 8}
    assert stats_summary.notes_tally(records, None, "2026-06-01T00:00:00+00:00") == {
        "highlights": 0, "words": 0}


# ── persistence, recovery, reset, bounds ─────────────────────────────────────
def test_flush_persists_and_a_new_store_reads_it_back(store, path, clock) -> None:
    listen(store)

    assert store.flush() is True
    assert store.flush() is False   # nothing new to write
    reread = StatsStore(path_fn=lambda: path, clock=clock, flush_delay=None)
    assert summary(reread)["listening"]["seconds"] == 60.0


def test_debounced_timer_writes_without_an_explicit_flush(path: Path, clock: Clock) -> None:
    store = StatsStore(path_fn=lambda: path, clock=clock, flush_delay=0.01)
    listen(store)
    deadline = time.monotonic() + 5
    while not path.exists() and time.monotonic() < deadline:
        time.sleep(0.01)

    assert json.loads(path.read_text())["days"]["2026-03-14"]["listen_s"] == 60.0


@pytest.mark.parametrize("content", ["{not json", "[1, 2, 3]", '{"days": 7}', "\xff\xfe"])
def test_a_corrupt_file_is_moved_aside_and_the_store_starts_fresh(
    path: Path, clock: Clock, content: str
) -> None:
    path.write_text(content, encoding="latin-1")
    store = StatsStore(path_fn=lambda: path, clock=clock, flush_delay=None)

    listen(store)

    assert summary(store)["listening"]["seconds"] == 60.0
    assert len(list(path.parent.glob("stats.corrupt-*.json"))) == 1
    assert store.flush() is True and json.loads(path.read_text())["version"] == 1


def test_junk_values_inside_a_valid_file_are_coerced_not_fatal(path, clock) -> None:
    path.write_text(json.dumps({"days": {"2026-03-14": {"listen_s": "lots", "hours": {"9": -4},
                                                        "tts": [], "finished": "x"}},
                                "docs": {DOC_A: "nope"}}))
    store = StatsStore(path_fn=lambda: path, clock=clock, flush_delay=None)

    out = summary(store)

    assert out["listening"]["seconds"] == 0 and out["hours"][9] == 0
    assert not list(path.parent.glob("stats.corrupt-*.json"))



def test_day_keys_that_are_not_real_dates_are_dropped_on_load(path, clock) -> None:
    junk = ["garbage", "2026-13-45", "2026-3-14", "2026-03-14\n", "\uff12026-03-14", "../x",
            "20260314", "2026-W11-6"]   # fromisoformat accepts these two; the regex must not
    path.write_text(json.dumps({"days": {**{key: {"listen_s": 5} for key in junk},
                                         "2026-03-14": {"listen_s": 3}}}))
    store = StatsStore(path_fn=lambda: path, clock=clock, flush_delay=None)

    assert list(store.snapshot()["days"]) == ["2026-03-14"]
    assert summary(store, year=None)["listening"]["seconds"] == 3
    assert not list(path.parent.glob("stats.corrupt-*.json"))


def test_a_file_nested_too_deep_to_parse_is_moved_aside(path, clock) -> None:
    depth = 100_000
    path.write_text("[" * depth + "]" * depth)
    store = StatsStore(path_fn=lambda: path, clock=clock, flush_delay=None)

    listen(store)

    assert summary(store)["listening"]["seconds"] == 60.0
    assert len(list(path.parent.glob("stats.corrupt-*.json"))) == 1


def test_a_days_finished_list_keeps_only_the_most_recent(store, monkeypatch) -> None:
    cap = 3
    monkeypatch.setattr(stats_store, "MAX_FINISHED_PER_DAY", cap)
    docs = [f"{n:08x}" for n in range(cap + 2)]
    for doc in docs:
        listen(store, doc_id=doc, progress=1.0)

    assert store.snapshot()["days"]["2026-03-14"]["finished"] == docs[-cap:]

def test_reset_clears_everything_and_moves_since_forward(store, path, clock) -> None:
    listen(store)
    store.record_tts(10, 1.0, hit=False)
    clock.at = clock.at.replace(hour=12)

    since = store.reset()

    out = summary(store)
    assert out["listening"]["seconds"] == 0 and out["tts"]["requests"] == 0
    assert out["since"] == since and since.startswith("2026-03-14T12:")
    assert json.loads(path.read_text())["days"] == {}


def test_the_file_stays_bounded(store: StatsStore, clock: Clock) -> None:
    start = datetime(2015, 1, 1).toordinal()
    for offset in range(MAX_DAYS + 40):
        clock.at = datetime.fromordinal(start + offset).replace(hour=8)
        store.record_open(DOC_A)
    for n in range(MAX_KEYS_PER_DAY * 2):
        listen(store, doc_id=f"{n:08x}", voice=f"v{n}", progress=0.0)

    snap = store.snapshot()
    today = snap["days"][clock.at.strftime("%Y-%m-%d")]
    assert len(snap["days"]) == MAX_DAYS
    assert len(today["docs"]) <= MAX_KEYS_PER_DAY and len(today["voices"]) <= MAX_KEYS_PER_DAY
    assert sum(today["docs"].values()) == pytest.approx(60.0 * MAX_KEYS_PER_DAY * 2)


def test_the_paper_table_stays_bounded(store: StatsStore, clock: Clock) -> None:
    for n in range(MAX_DOCS + 5):
        store.record_open(f"{n:08x}")

    assert len(store.snapshot()["docs"]) == MAX_DOCS


def test_the_facade_never_raises(monkeypatch: pytest.MonkeyPatch) -> None:
    def broken() -> StatsStore:
        raise RuntimeError("disk on fire")

    monkeypatch.setattr(stats_store, "get_store", broken)

    stats_store.record_tts(1, b"", hit=False)
    stats_store.record_llm(1, 1)
    stats_store.record_open(DOC_A)
    stats_store.record_listen({"seconds": 1})


def test_an_unwritable_file_keeps_the_counts_for_the_next_flush(tmp_path, clock) -> None:
    blocked = tmp_path / "not-a-dir"
    blocked.write_text("a file where a directory should be")
    store = StatsStore(path_fn=lambda: blocked / "stats.json", clock=clock, flush_delay=None)
    listen(store)

    assert store.flush() is False
    assert summary(store)["listening"]["seconds"] == 60.0
