"""Spoken summaries of a page or a section (N9), cached per text.

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
from dataclasses import dataclass
from pathlib import Path

from kokoro_reader import config, llm, stats_store

log = logging.getLogger(__name__)

BACKENDS = ("apple", "qwen")
PROMPT_VERSION = 1
#: A long section, not a book: ~3–4k tokens, half of the Apple model's 8,192-token context.
MAX_TEXT_CHARS = 12_000
MAX_SUMMARY_TOKENS = 300          # six spoken sentences with room to spare
APPLE_TIMEOUT_S = 90.0            # swift's compile plus a cold model; a page measured 3.4–4.7 s
APPLE_SCRIPT = Path(__file__).with_name("apple_summary.swift")
APPLE_CMD = ("swift", str(APPLE_SCRIPT))
#: The Apple model ships with the OS, so the OS version names the model in the cache key.
APPLE_MODEL = f"apple-foundation-{platform.mac_ver()[0] or 'none'}"
#: A summary may run a little past a very short page, never far past it.
SUMMARY_SLACK_CHARS = 200
CACHE_SUBDIR = "summary"
LOG_PREVIEW = 60

INSTRUCTIONS = (
    "You summarise a passage from a document for someone who will hear the summary read aloud. "
    "Write 3 to 6 plain spoken sentences of prose. Keep every number, unit and name exactly as "
    "written. Never add facts. No markdown, no lists, no headings, no preamble: output only the summary."
)

_THINK_RE = re.compile(r"<think>.*?</think>", re.DOTALL | re.IGNORECASE)
_LINE_MARK_RE = re.compile(r"^\s*(?:#{1,6}|[-*•]|\d+[.)])\s+", re.MULTILINE)
_INLINE_MARK_RE = re.compile(r"\*\*|__|`")
_REFUSAL_PREFIXES = ("i'm sorry", "i am sorry", "i can't", "i cannot", "sorry", "as an ai")

_call_lock = threading.Lock()   # one model call at a time: two cold models at once is the RAM risk


class SummaryUnavailable(RuntimeError):
    """The backend cannot run on this machine right now (→ 503). The message says why."""


class SummaryFailed(RuntimeError):
    """The backend ran but gave no usable summary (→ 502)."""


@dataclass(frozen=True)
class Summary:
    text: str
    backend: str
    cached: bool


def cache_key(backend: str, model: str, text: str) -> str:
    return hashlib.sha1(f"{backend}|{model}|{PROMPT_VERSION}|{text}".encode("utf-8")).hexdigest()


def clean_summary(raw: str, source: str) -> str:
    """Plain spoken prose from a model reply; raises SummaryFailed when nothing usable is left."""
    text = _INLINE_MARK_RE.sub("", _LINE_MARK_RE.sub("", _THINK_RE.sub("", raw or "")))
    text = " ".join(text.split())
    if not text:
        raise SummaryFailed("the model returned an empty summary")
    if text.lower().startswith(_REFUSAL_PREFIXES):
        raise SummaryFailed("the model declined to summarise this text")
    if len(text) > len(source) + SUMMARY_SLACK_CHARS:
        raise SummaryFailed("the model rewrote the text instead of summarising it")
    return text


def summarize(text: str, backend: str) -> Summary:
    """The summary of `text` from `backend`, from the cache when it has been made before."""
    model = _model_of(backend)
    path = _cache_dir() / f"{cache_key(backend, model, text)}.json"
    cached = _cache_read(path)
    if cached is not None:
        stats_store.record_llm(cached["tokens_in"], cached["tokens_out"], hit=True)
        return Summary(cached["summary"], backend, cached=True)
    with _call_lock:
        raw, tokens_in, tokens_out = _caller(backend)(INSTRUCTIONS, text)
    stats_store.record_llm(tokens_in, tokens_out)
    result = clean_summary(raw, text)
    _cache_write(path, {"summary": result, "backend": backend, "model": model,
                        "tokens_in": tokens_in, "tokens_out": tokens_out})
    return Summary(result, backend, cached=False)


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
    if not isinstance(entry, dict) or not isinstance(entry.get("summary"), str):
        return None
    return {"summary": entry["summary"], "tokens_in": _count(entry.get("tokens_in")),
            "tokens_out": _count(entry.get("tokens_out"))}


def _cache_write(path: Path, entry: dict) -> None:
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        tmp = path.with_suffix(".tmp")
        tmp.write_text(json.dumps(entry), encoding="utf-8")
        tmp.replace(path)
    except OSError as exc:
        log.warning("summary: could not cache %s: %s", path.name, exc)
