"""Local reading statistics ("Wrapped"): daily-aggregated counters in ``DATA_DIR/stats.json``.

Strictly an enhancement, like ``llm.py``: **recording may never slow or break playback**.
Every public ``record_*`` is O(1) in memory and swallows every exception with one log
line; the disk write is debounced onto a daemon timer, atomic (tmp + fsync +
``os.replace``), and an unreadable file is moved aside rather than crashing the reader.

The store is the single owner of its state. Day and doc entries are replaced, never
mutated, so a summary can work on a shallow snapshot without holding the lock.
"""

from __future__ import annotations

import atexit
import io
import json
import logging
import os
import re
import threading
import uuid
import wave
from datetime import date, datetime
from pathlib import Path
from typing import Any, Callable, Mapping

from . import config

log = logging.getLogger(__name__)

STATS_FILE = "stats.json"
SCHEMA_VERSION = 1
FLUSH_DELAY_S = 5.0              # debounce: at most one disk write per this many seconds
MAX_DAYS = 3660                  # ten years of daily rows; older ones are pruned
MAX_DOCS = 1000                  # per-paper rows; the least recently seen are pruned
MAX_KEYS_PER_DAY = 64            # per-day voice/doc/open maps; the smallest fold into OTHER_KEY
MAX_TITLE_CHARS = 200
MAX_FINISHED_PER_DAY = MAX_DOCS  # a day's finished list keeps the most recent ones
FINISHED_FRACTION = 0.9          # a paper read this far counts as finished
OTHER_KEY = "other"
DAY_FORMAT = "%Y-%m-%d"
DAY_KEY_RE = re.compile(r"\d{4}-\d{2}-\d{2}", re.ASCII)
TMP_SUFFIX = ".tmp"
JSON_SUFFIX = ".json"

#: tokens: Kokoro phoneme tokens synthesised (W2); saved_chars: characters served from the cache.
TTS_FIELDS = ("requests", "hits", "chars", "audio_s", "tokens", "saved_chars")
LLM_FIELDS = ("calls", "tokens_in", "tokens_out", "hits", "saved_in", "saved_out")
LISTEN_FIELDS = ("listen_s", "sentences", "words", "pages")
#: voice_tokens / voice_chars (R8): what each voice synthesised (misses only). Siri has no
#: phoneme tokens, so it shows in voice_chars alone. A file from before R8 reads them as {}.
MAP_FIELDS = ("hours", "voices", "docs", "opens", "voice_tokens", "voice_chars")

Clock = Callable[[], datetime]


# ── pure helpers: every one returns a new value ──────────────────────────────
def empty_day() -> dict:
    return {
        **{name: 0 for name in LISTEN_FIELDS},
        **{name: {} for name in MAP_FIELDS},
        "finished": [],
        "tts": {name: 0 for name in TTS_FIELDS},
        "llm": {name: 0 for name in LLM_FIELDS},
    }


def empty_stats(since: str = "") -> dict:
    """``since`` is empty until the first reset: notes made before stats existed still count."""
    return {"version": SCHEMA_VERSION, "since": since, "days": {}, "docs": {}}


def _number(value: Any) -> float:
    is_number = isinstance(value, (int, float)) and not isinstance(value, bool)
    return value if is_number and value >= 0 else 0


def _capped(counter: dict) -> dict:
    """Keep the biggest keys; fold the rest into OTHER_KEY so a day row stays bounded."""
    if len(counter) <= MAX_KEYS_PER_DAY:
        return counter
    ranked = sorted(counter.items(), key=lambda item: item[1], reverse=True)
    keep = dict(ranked[: MAX_KEYS_PER_DAY - 1])
    rest = sum(value for _, value in ranked[MAX_KEYS_PER_DAY - 1 :])
    return {**keep, OTHER_KEY: keep.get(OTHER_KEY, 0) + rest}


def _bumped(counter: Mapping, key: str, amount: float) -> dict:
    return _capped({**counter, key: counter.get(key, 0) + amount})


def _summed(section: Mapping, patch: Mapping) -> dict:
    return {name: section.get(name, 0) + patch.get(name, 0) for name in section}


def _clean_map(raw: Any) -> dict:
    if not isinstance(raw, Mapping):
        return {}
    return _capped({str(k): _number(v) for k, v in raw.items() if _number(v) > 0})


def _clean_day(raw: Any) -> dict:
    """Coerce one stored day row; unknown keys are dropped, junk values become 0."""
    if not isinstance(raw, Mapping):
        return empty_day()
    finished = raw.get("finished")
    return {
        **{name: _number(raw.get(name)) for name in LISTEN_FIELDS},
        **{name: _clean_map(raw.get(name)) for name in MAP_FIELDS},
        "finished": ([d for d in finished if isinstance(d, str)][-MAX_FINISHED_PER_DAY:]
                     if isinstance(finished, list) else []),
        "tts": _clean_section(raw.get("tts"), TTS_FIELDS),
        "llm": _clean_section(raw.get("llm"), LLM_FIELDS),
    }


def _clean_section(raw: Any, fields: tuple[str, ...]) -> dict:
    section = raw if isinstance(raw, Mapping) else {}
    return {name: _number(section.get(name)) for name in fields}


def _clean_doc(raw: Any) -> dict | None:
    if not isinstance(raw, Mapping):
        return None
    return {
        "title": str(raw.get("title") or "")[:MAX_TITLE_CHARS],
        "progress": min(1.0, _number(raw.get("progress"))),
        "finished": raw.get("finished") if isinstance(raw.get("finished"), str) else None,
        "seen": raw.get("seen") if isinstance(raw.get("seen"), str) else "",
    }


def _is_day_key(key: str) -> bool:
    """YYYY-MM-DD naming a real date; anything else would break the summary's date math."""
    if not DAY_KEY_RE.fullmatch(key):
        return False
    try:
        date.fromisoformat(key)
    except ValueError:
        return False
    return True


def clean_stats(raw: Any) -> dict | None:
    """A sanitised copy of a stored file, or None when its shape is not ours at all."""
    if not isinstance(raw, Mapping) or not isinstance(raw.get("days"), Mapping):
        return None
    docs_raw = raw.get("docs") if isinstance(raw.get("docs"), Mapping) else {}
    docs = {str(k): doc for k, doc in ((k, _clean_doc(v)) for k, v in docs_raw.items()) if doc}
    days = {str(k): _clean_day(v) for k, v in raw["days"].items() if _is_day_key(str(k))}
    stored_since = raw.get("since")
    return {
        "version": SCHEMA_VERSION,
        "since": stored_since if isinstance(stored_since, str) else "",
        "days": _pruned_days(days),
        "docs": _pruned_docs(docs),
    }


def _pruned_days(days: dict) -> dict:
    if len(days) <= MAX_DAYS:
        return days
    return dict(sorted(days.items())[-MAX_DAYS:])


def _pruned_docs(docs: dict) -> dict:
    if len(docs) <= MAX_DOCS:
        return docs
    return dict(sorted(docs.items(), key=lambda item: item[1]["seen"])[-MAX_DOCS:])


def wav_seconds(wav: bytes) -> float:
    """Duration of a WAV from its header alone; 0 when it cannot be read."""
    try:
        with wave.open(io.BytesIO(wav)) as reader:
            rate = reader.getframerate()
            return reader.getnframes() / rate if rate else 0.0
    except (wave.Error, EOFError, ValueError) as exc:
        log.debug("stats: unreadable wav header: %s", exc)
        return 0.0


# ── file IO ──────────────────────────────────────────────────────────────────
def _default_path() -> Path:
    return Path(config.DATA_DIR) / STATS_FILE


def _quarantine(path: Path) -> None:
    """Move an unreadable stats file aside: never crash, never silently destroy it."""
    stamp = datetime.now().strftime("%Y%m%dT%H%M%S%f")
    aside = path.with_name(f"{path.stem}.corrupt-{stamp}{JSON_SUFFIX}")
    try:
        os.replace(path, aside)
        log.warning("stats file was unreadable; moved aside to %s, starting fresh", aside.name)
    except OSError as exc:
        log.warning("could not quarantine the stats file: %s", exc)


def load_file(path: Path) -> dict:
    try:
        raw = json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError:
        return empty_stats()
    except (OSError, UnicodeDecodeError, ValueError, RecursionError) as exc:
        log.warning("stats file could not be read: %s", exc)
        _quarantine(path)
        return empty_stats()
    cleaned = clean_stats(raw)
    if cleaned is None:
        log.warning("stats file had an unexpected shape")
        _quarantine(path)
        return empty_stats()
    return cleaned


def _atomic_write(path: Path, payload: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(f"{path.name}.{os.getpid()}.{uuid.uuid4().hex}{TMP_SUFFIX}")
    try:
        with open(tmp, "w", encoding="utf-8") as fh:
            fh.write(payload)
            fh.flush()
            os.fsync(fh.fileno())
        os.replace(tmp, path)
    except OSError:
        tmp.unlink(missing_ok=True)
        raise


# ── the store ────────────────────────────────────────────────────────────────
class StatsStore:
    """In-memory counters with a debounced, atomic flush. Thread-safe."""

    def __init__(
        self,
        path_fn: Callable[[], Path] = _default_path,
        clock: Clock = datetime.now,
        flush_delay: float | None = FLUSH_DELAY_S,
    ) -> None:
        self._path_fn = path_fn
        self._clock = clock
        self._flush_delay = flush_delay
        self._lock = threading.Lock()          # guards _data / _dirty / _timer
        self._write_lock = threading.Lock()    # orders flushes; never held by a record
        self._data: dict | None = None
        self._dirty = False
        self._timer: threading.Timer | None = None

    # ── recording ────────────────────────────────────────────────────────────
    def record_tts(self, chars: int, audio_s: float, hit: bool, voice: str = "") -> None:
        patch = {"requests": 1, "hits": int(hit), "chars": 0 if hit else chars,
                 "audio_s": 0 if hit else audio_s, "saved_chars": chars if hit else 0}

        def bump(day: dict) -> dict:
            out = {**day, "tts": _summed(day["tts"], patch)}
            if hit or not voice:
                return out
            return {**out, "voice_chars": _bumped(day["voice_chars"], voice, chars)}

        self._update_day(bump)

    def record_tokens(self, tokens: int, voice: str = "") -> None:
        def bump(day: dict) -> dict:
            out = {**day, "tts": _summed(day["tts"], {"tokens": tokens})}
            if not voice:
                return out
            return {**out, "voice_tokens": _bumped(day["voice_tokens"], voice, tokens)}

        self._update_day(bump)

    def record_llm(self, tokens_in: int, tokens_out: int, hit: bool) -> None:
        patch = ({"hits": 1, "saved_in": tokens_in, "saved_out": tokens_out} if hit
                 else {"calls": 1, "tokens_in": tokens_in, "tokens_out": tokens_out})
        self._update_day(lambda day: {**day, "llm": _summed(day["llm"], patch)})

    def record_open(self, doc_id: str) -> None:
        self._update_day(lambda day: {**day, "opens": _bumped(day["opens"], doc_id, 1)})
        self._touch_doc(doc_id)

    def record_listen(self, batch: Mapping) -> None:
        seconds = _number(batch.get("seconds"))
        added = {"listen_s": seconds, **{name: _number(batch.get(name))
                                         for name in ("sentences", "words", "pages")}}
        doc_id, voice = batch.get("doc_id") or "", batch.get("voice") or ""
        hour = str(self._clock().hour)

        def bump(day: dict) -> dict:
            out = {**day, **{name: day[name] + added[name] for name in LISTEN_FIELDS}}
            if not seconds:
                return out
            out = {**out, "hours": _bumped(day["hours"], hour, seconds)}
            if voice:
                out = {**out, "voices": _bumped(day["voices"], voice, seconds)}
            if doc_id:
                out = {**out, "docs": _bumped(day["docs"], doc_id, seconds)}
            return out

        self._update_day(bump)
        if doc_id:
            self._touch_doc(doc_id, str(batch.get("title") or ""), _number(batch.get("progress")))

    def reset(self) -> str:
        """Forget everything recorded so far; returns the new ``since`` stamp."""
        since = self._now_iso()
        with self._lock:
            self._data = empty_stats(since)
            self._dirty = True
        self.flush()
        return since

    # ── reading ──────────────────────────────────────────────────────────────
    def snapshot(self) -> dict:
        """A shallow copy safe to read without the lock (entries are never mutated)."""
        with self._lock:
            data = self._loaded()
            return {**data, "days": dict(data["days"]), "docs": dict(data["docs"])}

    def today(self) -> datetime:
        return self._clock()

    # ── persistence ──────────────────────────────────────────────────────────
    def flush(self) -> bool:
        """Write pending changes now. True if a write happened."""
        with self._write_lock:
            with self._lock:
                self._timer = None
                if not self._dirty or self._data is None:
                    return False
                payload = json.dumps(self._data, ensure_ascii=False, separators=(",", ":"))
                self._dirty = False
            try:
                _atomic_write(self._path_fn(), payload)
            except OSError as exc:
                log.warning("stats could not be saved: %s", exc)
                with self._lock:
                    self._dirty = True
                return False
        return True

    # ── internals ────────────────────────────────────────────────────────────
    def _now_iso(self) -> str:
        return self._clock().astimezone().isoformat(timespec="seconds")

    def _loaded(self) -> dict:
        """Caller holds ``_lock``."""
        if self._data is None:
            self._data = load_file(self._path_fn())
        return self._data

    def _update_day(self, change: Callable[[dict], dict]) -> None:
        key = self._clock().strftime(DAY_FORMAT)
        with self._lock:
            days = self._loaded()["days"]
            is_new = key not in days
            days[key] = change(days.get(key) or empty_day())
            if is_new and len(days) > MAX_DAYS:
                self._data = {**self._data, "days": _pruned_days(days)}
            self._schedule()

    def _touch_doc(self, doc_id: str, title: str = "", progress: float = 0.0) -> None:
        today = self._clock().strftime(DAY_FORMAT)
        with self._lock:
            data = self._loaded()
            prior = data["docs"].get(doc_id) or {"title": "", "progress": 0.0,
                                                  "finished": None, "seen": today}
            best = max(prior["progress"], min(1.0, progress))
            newly_finished = prior["finished"] is None and best >= FINISHED_FRACTION
            data["docs"][doc_id] = {
                "title": title[:MAX_TITLE_CHARS] or prior["title"],
                "progress": best,
                "finished": today if newly_finished else prior["finished"],
                "seen": today,
            }
            if newly_finished:
                day = data["days"].get(today) or empty_day()
                finished = [*day["finished"], doc_id][-MAX_FINISHED_PER_DAY:]
                data["days"][today] = {**day, "finished": finished}
            if len(data["docs"]) > MAX_DOCS:
                self._data = {**data, "docs": _pruned_docs(data["docs"])}
            self._schedule()

    def _schedule(self) -> None:
        """Caller holds ``_lock``. Arms one daemon timer per quiet period."""
        self._dirty = True
        if self._timer is not None or self._flush_delay is None:
            return
        self._timer = threading.Timer(self._flush_delay, self.flush)
        self._timer.daemon = True
        self._timer.start()


# ── process-wide singleton + never-raising facade ────────────────────────────
_store: StatsStore | None = None
_store_lock = threading.Lock()


def get_store() -> StatsStore:
    global _store
    if _store is None:
        with _store_lock:
            if _store is None:
                _store = StatsStore()
                atexit.register(_store.flush)
    return _store


def _safe(what: str, action: Callable[[], None]) -> None:
    try:
        action()
    except Exception as exc:  # noqa: BLE001 - stats must never reach a caller
        log.warning("stats: %s not recorded: %s", what, exc)


def record_tts(chars: int, wav: bytes, hit: bool, voice: str = "") -> None:
    _safe("tts", lambda: get_store().record_tts(
        chars, 0.0 if hit else wav_seconds(wav), hit, voice))


def record_tokens(tokens: int, voice: str = "") -> None:
    if tokens > 0:
        _safe("tokens", lambda: get_store().record_tokens(tokens, voice))


def record_llm(tokens_in: int, tokens_out: int, hit: bool = False) -> None:
    _safe("llm", lambda: get_store().record_llm(tokens_in, tokens_out, hit))


def record_open(doc_id: str) -> None:
    _safe("open", lambda: get_store().record_open(doc_id))


def record_listen(batch: Mapping) -> None:
    _safe("listen", lambda: get_store().record_listen(batch))
