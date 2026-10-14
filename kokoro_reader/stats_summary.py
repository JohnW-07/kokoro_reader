"""Pure derivation of the "Wrapped" summary from a stats snapshot and the notes records.

No I/O, no clock: everything arrives as arguments, so every number on the page is
reachable from a unit test.
"""

from __future__ import annotations

from collections import Counter
from datetime import date, datetime
from typing import Any, Iterable, Mapping

from .stats_store import LLM_FIELDS, OTHER_KEY, TTS_FIELDS

TOP_PAPERS = 5
HOURS_PER_DAY = 24
UNTITLED = "Untitled paper"


def _in_range(day_key: str, year: int | None) -> bool:
    return year is None or day_key.startswith(f"{year:04d}-")


def years_with_data(days: Mapping[str, Any]) -> list[int]:
    return sorted({int(key[:4]) for key in days if key[:4].isdigit()}, reverse=True)


def _summed_map(rows: Iterable[Mapping], field: str) -> dict:
    total: Counter = Counter()
    for row in rows:
        total.update(row[field])
    return dict(total)


def _section(rows: list[Mapping], name: str, fields: tuple[str, ...]) -> dict:
    return {key: sum(row[name].get(key, 0) for row in rows) for key in fields}


def _is_active(row: Mapping) -> bool:
    return row["listen_s"] > 0 or bool(row["opens"])


def longest_streak(day_keys: Iterable[str]) -> dict:
    """The longest run of consecutive calendar days among ``day_keys``."""
    ordinals = sorted({date.fromisoformat(key).toordinal() for key in day_keys})
    best = {"days": 0, "start": None, "end": None}
    run_start = None
    for index, ordinal in enumerate(ordinals):
        if index == 0 or ordinal != ordinals[index - 1] + 1:
            run_start = ordinal
        length = ordinal - run_start + 1
        if length > best["days"]:
            best = {"days": length, "start": date.fromordinal(run_start).isoformat(),
                    "end": date.fromordinal(ordinal).isoformat()}
    return best


def busiest_day(days: Mapping[str, Mapping]) -> dict | None:
    """The day with the most listening; the earliest wins a tie."""
    listened = [(key, row["listen_s"]) for key, row in sorted(days.items()) if row["listen_s"] > 0]
    if not listened:
        return None
    key, seconds = max(listened, key=lambda item: item[1])
    return {"date": key, "seconds": seconds}


def _ranked(counter: Mapping[str, float]) -> list[tuple[str, float]]:
    return sorted(counter.items(), key=lambda item: (-item[1], item[0]))


def _top_papers(per_doc: Mapping[str, float], docs: Mapping, titles: Mapping[str, str]) -> list:
    ranked = [(doc_id, s) for doc_id, s in _ranked(per_doc) if doc_id != OTHER_KEY]
    return [
        {"doc_id": doc_id, "seconds": seconds,
         "title": (docs.get(doc_id) or {}).get("title") or titles.get(doc_id) or UNTITLED}
        for doc_id, seconds in ranked[:TOP_PAPERS]
    ]


def _tts(rows: list[Mapping]) -> dict:
    tts = _section(rows, "tts", TTS_FIELDS)
    requests, hits, chars, tokens = tts["requests"], tts["hits"], tts["chars"], tts["tokens"]
    return {"requests": requests, "hits": hits, "misses": requests - hits,
            "hit_rate": hits / requests if requests else None,
            "chars": chars, "audio_seconds": tts["audio_s"], "tokens": tokens,
            # An estimate: a hit is never phonemized, so it is priced at the misses' rate.
            "tokens_saved": round(tts["saved_chars"] * tokens / chars) if chars else 0,
            "by_voice": _by_voice(rows)}


def _by_voice(rows: list[Mapping]) -> list[dict]:
    """R8: per voice, most characters first. tokens is None where none were counted (Siri)."""
    tokens = _summed_map(rows, "voice_tokens")
    chars = _summed_map(rows, "voice_chars")
    return [{"voice": v, "tokens": tokens.get(v), "chars": n} for v, n in _ranked(chars)]


def paper(snapshot: Mapping, doc_id: str) -> dict | None:
    """One paper's listening over all time and its furthest progress (N11), whatever the period."""
    if not doc_id:
        return None
    doc = snapshot["docs"].get(doc_id) or {}
    return {"doc_id": doc_id, "title": doc.get("title", ""),
            "seconds": sum(row["docs"].get(doc_id, 0) for row in snapshot["days"].values()),
            "progress": doc.get("progress", 0.0), "finished": doc.get("finished")}


def _parsed(stamp: Any) -> datetime | None:
    try:
        parsed = datetime.fromisoformat(stamp)
    except (TypeError, ValueError):
        return None
    return parsed.astimezone()   # a naive stamp is taken as local time


def _counts(stamp: Any, year: int | None, since: datetime | None) -> bool:
    moment = _parsed(stamp)
    if moment is None:
        return False
    return (year is None or moment.year == year) and (since is None or moment >= since)


def _words(text: Any) -> int:
    return len(text.split()) if isinstance(text, str) else 0


def notes_tally(records: Iterable[Mapping], year: int | None, since: str) -> dict:
    """Highlights made and note words written in range, from notes_store JSON records.

    Highlights carry ``created_at``; editor blocks carry no date, so a paper's blocks
    count towards the period its record was last updated in. Nothing before the last
    stats reset counts.
    """
    floor = _parsed(since)
    highlights = 0
    words = 0
    for record in records:
        made = [h for h in record.get("highlights", ()) if _counts(h.get("created_at"), year, floor)]
        highlights += len(made)
        words += sum(_words(h.get("note")) for h in made)
        if _counts(record.get("updated_at"), year, floor):
            words += sum(_words(b.get("text")) for b in record.get("blocks", ()))
    return {"highlights": highlights, "words": words}


def summarize(snapshot: Mapping, year: int | None, records: list[Mapping],
              doc_id: str = "") -> dict:
    """The whole page's numbers for ``year`` (None = all time), and ``doc_id``'s if given."""
    days = {key: row for key, row in snapshot["days"].items() if _in_range(key, year)}
    rows = list(days.values())
    voices = _summed_map(rows, "voices")
    voice_list = [{"voice": v, "seconds": s} for v, s in _ranked(voices) if v != OTHER_KEY]
    titles = {r.get("doc_id"): r.get("title") for r in records if r.get("title")}
    hours = _summed_map(rows, "hours")
    return {
        "range": "all" if year is None else str(year),
        "years": years_with_data(snapshot["days"]),
        "since": snapshot["since"],
        "listening": {"seconds": sum(r["listen_s"] for r in rows),
                      "sentences": sum(r["sentences"] for r in rows),
                      "words": sum(r["words"] for r in rows),
                      "pages": sum(r["pages"] for r in rows),
                      "days": sum(1 for r in rows if r["listen_s"] > 0)},
        "papers": {"opened": len({d for r in rows for d in r["opens"] if d != OTHER_KEY}),
                   "finished": len({d for r in rows for d in r["finished"]})},
        "notes": notes_tally(records, year, snapshot["since"]),
        "voices": voice_list,
        "favorite_voice": voice_list[0]["voice"] if voice_list else None,
        "top_papers": _top_papers(_summed_map(rows, "docs"), snapshot["docs"], titles),
        "busiest_day": busiest_day(days),
        "longest_streak": longest_streak(k for k, r in days.items() if _is_active(r)),
        "hours": [hours.get(str(h), 0) for h in range(HOURS_PER_DAY)],
        "tts": _tts(rows),
        "llm": _section(rows, "llm", LLM_FIELDS),
        "paper": paper(snapshot, doc_id),
    }
