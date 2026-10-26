"""Summaries of a page or a section (N9) as Oxford-style notes, cached per text.

A summary is a heading, one line of context and a few bullet key ideas (docs/17 S2); its
flat `spoken` text is what the reader hears.

Two backends. **apple**: Apple's on-device model through `apple_summary.swift`, one `swift`
process per request (nothing stays resident; ~3–5 s for a page, measured 2026-10-09).
**qwen**: the local LLM through llm.py's worker, only when its weights are already here.
The client asks for apple and falls back to qwen only when the reader opted into the LLM.

A summary is cached under `sha1(backend|model|prompt version|text)`, so the same text costs
one model call however often it is asked for, from whichever page.
"""

from __future__ import annotations

import hashlib
import json
import logging
import platform
import re
import subprocess
import threading
from dataclasses import dataclass, field
from pathlib import Path

from kokoro_reader import config, llm, stats_store

log = logging.getLogger(__name__)

BACKENDS = ("apple", "qwen")
PROMPT_VERSION = 2
#: A long section, not a book: ~3–4k tokens, half of the Apple model's 8,192-token context.
MAX_TEXT_CHARS = 12_000
#: A heading, a context line and 7 bullets of ≤ 20 words; 300 cut a page's last bullet (docs/17).
MAX_SUMMARY_TOKENS = 400
APPLE_TIMEOUT_S = 90.0            # swift's compile plus a cold model; a page measured 3.4–4.7 s
APPLE_SCRIPT = Path(__file__).with_name("apple_summary.swift")
APPLE_CMD = ("swift", str(APPLE_SCRIPT))
#: The Apple model ships with the OS, so the OS version names the model in the cache key.
APPLE_MODEL = f"apple-foundation-{platform.mac_ver()[0] or 'none'}"
#: A summary may run a little past a very short page, never far past it.
SUMMARY_SLACK_CHARS = 200
CACHE_SUBDIR = "summary"
LOG_PREVIEW = 60
#: The prompt asks for ≤ 8 words; a longer lone first line is the context, not a heading.
MAX_HEADING_WORDS = 12

INSTRUCTIONS = (
    "You write dense study notes on a passage from a document, Oxford style. Output exactly this "
    "layout and nothing else:\n"
    "First line: a heading for this passage's own topic (not the document's title), at most 8 words.\n"
    "Second line: one sentence of context, at most 25 words: what the passage covers and why it matters.\n"
    "Then 3 to 7 bullet lines, each one key idea in at most 20 words: claims, methods, results, definitions.\n"
    "One heading and one context line only, even when the passage has several sections: the bullets cover them all.\n"
    "Telegraphic style: drop filler words. Keep every number, unit and name exactly as written. "
    "Say what an equation means in words instead of copying it. Never add facts. No bold, no preamble."
)

_THINK_RE = re.compile(r"<think>.*?</think>", re.DOTALL | re.IGNORECASE)
_HEADING_MARK_RE = re.compile(r"^\s*#{1,6}\s+")
#: One or more list markers ("- - " is the Apple model's habit); "-5.7" keeps its minus sign.
_BULLET_RE = re.compile(r"^\s*(?:(?:[-*•]|\d+[.)])\s+)+")
_LABEL_RE = re.compile(r"^(?:heading|title|context|summary)\s*:\s*", re.IGNORECASE)
_SENTENCE_RE = re.compile(r"(?<=[.!?])\s+")
_SENTENCE_END = (".", "!", "?")
_WRAP = "  "   # _strip_marks' tag for an indented line: the bullet above it continues
_INLINE_MARK_RE = re.compile(r"\*\*|__|`")
_REFUSAL_PREFIXES = ("i'm sorry", "i am sorry", "i can't", "i cannot", "sorry", "as an ai")

_call_lock = threading.Lock()   # one model call at a time: two cold models at once is the RAM risk


class SummaryUnavailable(RuntimeError):
    """The backend cannot run on this machine right now (→ 503). The message says why."""


class SummaryFailed(RuntimeError):
    """The backend ran but gave no usable summary (→ 502)."""


@dataclass(frozen=True)
class Notes:
    heading: str
    context: str
    points: tuple[str, ...] = field(default_factory=tuple)

    @property
    def spoken(self) -> str:
        """Heading, context, then each point, read as one sentence each."""
        return " ".join(_as_sentence(part) for part in (self.heading, self.context, *self.points) if part)


@dataclass(frozen=True)
class Summary:
    notes: Notes
    backend: str
    cached: bool


def cache_key(backend: str, model: str, text: str) -> str:
    return hashlib.sha1(f"{backend}|{model}|{PROMPT_VERSION}|{text}".encode("utf-8")).hexdigest()


def parse_notes(raw: str, source: str, is_cut: bool = False) -> Notes:
    """Heading, context and points from a model reply; raises SummaryFailed when nothing usable is left.

    Tolerates what models do with the layout: markdown, labels, doubled or numbered markers,
    indented wrapped bullets, a second block. A reply with no bullets is prose: its first
    sentence is the context. `is_cut` (the reply hit the token cap) drops its unfinished last point.
    """
    lines = [_strip_marks(line) for line in _INLINE_MARK_RE.sub("", _THINK_RE.sub("", raw or "")).splitlines()]
    lines = [line for line in lines if line]
    flat = " ".join(line.strip() for line in lines)
    if not flat:
        raise SummaryFailed("the model returned an empty summary")
    if flat.lower().startswith(_REFUSAL_PREFIXES):
        raise SummaryFailed("the model declined to summarise this text")
    notes = _notes_of(lines)
    if is_cut:
        notes = Notes(notes.heading, notes.context, notes.points[:-1])
    if len(notes.spoken) > len(source) + SUMMARY_SLACK_CHARS:
        raise SummaryFailed("the model rewrote the text instead of summarising it")
    return notes


def _strip_marks(line: str) -> str:
    """The line without heading marks, tagged: a bullet keeps one "- ", an indented line "  "."""
    line = _HEADING_MARK_RE.sub("", line).rstrip()
    bullet = _BULLET_RE.match(line)
    if bullet:
        return f"- {line[bullet.end():].strip()}"
    return f"{_WRAP}{line.strip()}" if line[:1].isspace() and line.strip() else line.strip()


def _notes_of(lines: list[str]) -> Notes:
    first_bullet = next((i for i, line in enumerate(lines) if line.startswith("- ")), len(lines))
    head = [_LABEL_RE.sub("", line.strip()).rstrip(":").strip() for line in lines[:first_bullet]]
    points = _points(lines[first_bullet:])
    heading = head[0] if head and len(head[0].split()) <= MAX_HEADING_WORDS and (len(head) > 1 or points) else ""
    context = " ".join(head[1:] if heading else head)
    if points:
        return Notes(heading, context, tuple(points))
    sentences = _SENTENCE_RE.split(context)
    return Notes(heading, sentences[0], tuple(sentences[1:]))


def _points(lines: list[str]) -> list[str]:
    """Bullets, each with the indented lines after it (a wrapped bullet) joined on; any other line is its own point."""
    points: list[str] = []
    for line in lines:
        if line.startswith(_WRAP):
            points = [*points[:-1], f"{points[-1]} {line.strip()}"]
        else:
            points = [*points, line.removeprefix("- ")]
    return [point for point in points if point]


def _as_sentence(part: str) -> str:
    part = part.rstrip(" ,;:")
    return part if part.endswith(_SENTENCE_END) else f"{part}."


def summarize(text: str, backend: str) -> Summary:
    """The summary of `text` from `backend`, from the cache when it has been made before."""
    model = _model_of(backend)
    path = _cache_dir() / f"{cache_key(backend, model, text)}.json"
    cached = _cache_read(path)
    if cached is not None:
        stats_store.record_llm(cached["tokens_in"], cached["tokens_out"], hit=True)
        return Summary(cached["notes"], backend, cached=True)
    with _call_lock:
        raw, tokens_in, tokens_out = _caller(backend)(INSTRUCTIONS, text)
    stats_store.record_llm(tokens_in, tokens_out)
    notes = parse_notes(raw, text, is_cut=tokens_out >= MAX_SUMMARY_TOKENS)
    _cache_write(path, {"heading": notes.heading, "context": notes.context, "points": list(notes.points),
                        "backend": backend, "model": model, "tokens_in": tokens_in, "tokens_out": tokens_out})
    return Summary(notes, backend, cached=False)


# ── backends ─────────────────────────────────────────────────────────────────

def _model_of(backend: str) -> str:
    return APPLE_MODEL if backend == "apple" else config.LLM_MODEL


def _caller(backend: str):
    """Looked up per call, so tests can replace one backend."""
    return {"apple": _ask_apple, "qwen": _ask_qwen}[backend]


def _ask_apple(instructions: str, text: str) -> tuple[str, int, int]:
    request = json.dumps({"instructions": instructions, "text": text, "max_tokens": MAX_SUMMARY_TOKENS})
    try:
        done = subprocess.run(APPLE_CMD, input=request, capture_output=True, text=True,
                              timeout=APPLE_TIMEOUT_S, check=False)
    except OSError as exc:
        raise SummaryUnavailable(f"Apple summaries need macOS with swift installed ({exc})") from exc
    except subprocess.TimeoutExpired as exc:
        raise SummaryFailed(f"the Apple model took longer than {APPLE_TIMEOUT_S:.0f} s") from exc
    try:
        reply = json.loads(done.stdout.strip().splitlines()[-1])
    except (IndexError, ValueError) as exc:
        log.warning("summary: apple host gave no JSON (code %s): %s", done.returncode, done.stderr[-LOG_PREVIEW:])
        raise SummaryFailed("the Apple model host did not answer") from exc
    if not reply.get("ok"):
        error = str(reply.get("error") or "unknown error")
        raise (SummaryUnavailable(error) if reply.get("unavailable") else SummaryFailed(error))
    return str(reply.get("summary", "")), _count(reply.get("tokens_in")), _count(reply.get("tokens_out"))


def _ask_qwen(instructions: str, text: str) -> tuple[str, int, int]:
    normalizer = llm.get_normalizer(True)
    complete = getattr(normalizer, "complete", None)
    if not callable(complete) or not normalizer.available():
        raise SummaryUnavailable("the local Qwen model is not installed or is turned off")
    reply = complete(instructions, text, MAX_SUMMARY_TOKENS)
    if reply is None:
        raise SummaryFailed("the local Qwen model failed or timed out")
    return reply


def _count(value: object) -> int:
    return value if isinstance(value, int) and value > 0 else 0


# ── cache (failures degrade to "no cache", never raise) ──────────────────────

def _cache_dir() -> Path:
    return Path(config.CACHE_DIR) / CACHE_SUBDIR


def _cache_read(path: Path) -> dict | None:
    try:
        entry = json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError:
        return None
    except (OSError, ValueError) as exc:
        log.warning("summary: unreadable cache entry %s: %s", path.name, exc)
        return None
    if not isinstance(entry, dict) or not _is_notes(entry):
        return None
    notes = Notes(entry["heading"], entry["context"], tuple(entry["points"]))
    return {"notes": notes, "tokens_in": _count(entry.get("tokens_in")), "tokens_out": _count(entry.get("tokens_out"))}


def _is_notes(entry: dict) -> bool:
    points = entry.get("points")
    return (isinstance(entry.get("heading"), str) and isinstance(entry.get("context"), str)
            and isinstance(points, list) and all(isinstance(point, str) for point in points))


def _cache_write(path: Path, entry: dict) -> None:
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        tmp = path.with_suffix(".tmp")
        tmp.write_text(json.dumps(entry), encoding="utf-8")
        tmp.replace(path)
    except OSError as exc:
        log.warning("summary: could not cache %s: %s", path.name, exc)
