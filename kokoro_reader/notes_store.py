"""Per-document highlight/note persistence (R9, R10, R11).

One JSON file per document at ``config.DOCS_DIR / f"{doc_id}.json"``. ``doc_id`` is a
SHA-1 hex digest of the PDF bytes computed by the client, so notes survive renaming and
moving the file.

Everything here is immutable: records are frozen dataclasses and every "mutation" builds
a new value. Writes are atomic (tmp + fsync + ``os.replace``) so a crash mid-write can
never leave a truncated notes file, and ``load`` never raises on bad data -- a file it
cannot parse is renamed aside rather than destroyed.
"""

from __future__ import annotations

import json
import logging
import os
import re
import uuid
from dataclasses import dataclass, field, replace
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterable, Mapping, Sequence

from kokoro_reader import config

log = logging.getLogger(__name__)

HIGHLIGHT_COLORS: tuple[str, ...] = ("yellow", "green", "blue", "pink")
DEFAULT_COLOR = HIGHLIGHT_COLORS[0]

#: A doc_id is a hex digest. This is also the path-traversal guard: no separators,
#: no dots, no absolute paths can survive it.
DOC_ID_RE = re.compile(r"^[a-f0-9]{8,64}$")

MAX_HIGHLIGHTS = 5_000        # bounds file size; oldest beyond this are dropped
MAX_TEXT_CHARS = 100_000      # a selection larger than this is a bug, not a highlight
MAX_NOTE_CHARS = 20_000
MAX_TITLE_CHARS = 500
#: M8 — one rect per selected line. A whole dense page is ~60; a pathological drag
#: selection produced thousands and bloated the notes file. Extra rects are dropped.
MAX_RECTS_PER_HIGHLIGHT = 512
RECT_KEYS: tuple[str, ...] = ("x", "y", "w", "h")
TMP_SUFFIX = ".tmp"
JSON_SUFFIX = ".json"

#: T7 — the per-paper block editor. Mirrors `static/js/blocks.js`; both sides clamp.
BLOCK_TYPES: tuple[str, ...] = (
    "p", "h1", "h2", "h3", "ul", "ol", "todo", "quote", "code", "divider",
)
DEFAULT_BLOCK_TYPE = "p"
MAX_BLOCKS = 2_000
MAX_BLOCK_CHARS = 10_000
MAX_BLOCK_ID_CHARS = 128
#: U8 -- where in the paper a note is pinned: page, a 0..1 y down that page, and the
#: highlight it was made from, if any. Mirrors `static/js/anchors.js`.
ANCHOR_KEYS: tuple[str, ...] = ("page", "y", "hl")
MAX_ANCHOR_PAGE = 10_000      # matches MAX_PAGE in static/js/anchors.js
#: N4: the resume mark keeps this much of the sentence's opening text, enough to find it
#: again after a rebuild renumbers the script. Matches RESUME_TEXT_CHARS in static/js/resume.js.
MAX_RESUME_TEXT_CHARS = 80
#: A run of these is numbered/bulleted together when exporting Markdown.
LIST_BLOCK_TYPES: tuple[str, ...] = ("ul", "ol", "todo")


@dataclass(frozen=True)
class Block:
    """One row of the notes editor. ``checked`` only means anything for ``todo``.

    ``anchor`` is set on the block that *opens* a note and is ``None`` on every block
    that continues it, so a note's place in the paper survives a reload (U8).
    """

    id: str
    type: str = DEFAULT_BLOCK_TYPE
    text: str = ""
    checked: bool = False
    anchor: dict | None = None


@dataclass(frozen=True)
class Highlight:
    id: str
    page: int
    color: str
    text: str
    note: str = ""
    rects: tuple[dict, ...] = ()
    created_at: str = ""
    updated_at: str = ""


@dataclass(frozen=True)
class DocRecord:
    doc_id: str
    title: str = ""
    highlights: tuple[Highlight, ...] = ()
    last_index: int = 0
    options: dict = field(default_factory=dict)
    updated_at: str = ""
    #: T7, added after the fields above on purpose: a record written by an older
    #: client simply has none, and loads as an empty editor.
    blocks: tuple[Block, ...] = ()
    #: N4: ``{page, text}`` of the sentence at `last_index`. A rebuild that joins sentences
    #: over page turns renumbers the script, so the index alone would move the place.
    last_sentence: dict | None = None


# ── helpers ───────────────────────────────────────────────────────────────────


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="microseconds")


def validate_doc_id(doc_id: Any) -> str:
    """Return ``doc_id`` if it is a hex digest; raise ``ValueError`` otherwise."""
    if not isinstance(doc_id, str) or not DOC_ID_RE.match(doc_id):
        raise ValueError("doc_id must be 8-64 lowercase hex characters")
    return doc_id


def _path_for(doc_id: str) -> Path:
    """The on-disk path for a *validated* doc_id. Never called with raw input."""
    return config.DOCS_DIR / f"{validate_doc_id(doc_id)}{JSON_SUFFIX}"


def _clean_str(value: Any, cap: int) -> str:
    return value[:cap] if isinstance(value, str) else ""


def _positive_int(value: Any, default: int = 1) -> int:
    try:
        number = int(value)
    except (TypeError, ValueError):
        return default
    return number if number > 0 else default


def _non_negative_int(value: Any, default: int = 0) -> int:
    try:
        number = int(value)
    except (TypeError, ValueError):
        return default
    return number if number >= 0 else default


def _clamped_unit(value: Any) -> float:
    """Coerce to a float clamped to 0..1. Raises ``ValueError`` if not numeric."""
    number = float(value)
    if number != number:  # NaN
        raise ValueError("rect component is NaN")
    return min(1.0, max(0.0, number))


def _clean_anchor(raw: Any) -> dict | None:
    """An anchor with a real page and a clamped y, or ``None`` if it names no place."""
    if not isinstance(raw, Mapping):
        return None
    try:
        page = int(raw["page"])
        y = _clamped_unit(raw.get("y", 0))
    except (KeyError, TypeError, ValueError, OverflowError):
        return None
    if not 1 <= page <= MAX_ANCHOR_PAGE:
        # No paper has this many pages. Kept rather than clamped, a page beyond the end
        # is an anchor that matches nothing and the note quietly loses its place.
        return None
    return {"page": page, "y": y, "hl": _clean_str(raw.get("hl"), MAX_BLOCK_ID_CHARS)}


def _clean_resume_mark(raw: Any) -> dict | None:
    """``{page, text}`` with a real page and some text, else ``None`` (restore uses the index)."""
    if not isinstance(raw, Mapping):
        return None
    page = _positive_int(raw.get("page"), default=0)
    text = _clean_str(raw.get("text"), MAX_RESUME_TEXT_CHARS)
    if not 1 <= page <= MAX_ANCHOR_PAGE or not text:
        return None
    return {"page": page, "text": text}


def _clean_rect(raw: Any) -> dict | None:
    """A rect with 4 clamped floats, or ``None`` if the input is malformed."""
    if not isinstance(raw, Mapping):
        return None
    try:
        return {key: _clamped_unit(raw[key]) for key in RECT_KEYS}
    except (KeyError, TypeError, ValueError, OverflowError):
        return None


def _clean_rects(raw: Any) -> tuple[dict, ...]:
    if not isinstance(raw, Sequence) or isinstance(raw, (str, bytes)):
        return ()
    cleaned = (_clean_rect(item) for item in raw)
    kept = tuple(rect for rect in cleaned if rect is not None)
    return kept[:MAX_RECTS_PER_HIGHLIGHT]


def _clean_color(raw: Any) -> str:
    return raw if raw in HIGHLIGHT_COLORS else DEFAULT_COLOR


def _highlight_from_json(raw: Any) -> Highlight | None:
    if not isinstance(raw, Mapping):
        return None
    hl_id = _clean_str(raw.get("id"), 128) or uuid.uuid4().hex
    return Highlight(
        id=hl_id,
        page=_positive_int(raw.get("page")),
        color=_clean_color(raw.get("color")),
        text=_clean_str(raw.get("text"), MAX_TEXT_CHARS),
        note=_clean_str(raw.get("note"), MAX_NOTE_CHARS),
        rects=_clean_rects(raw.get("rects")),
        created_at=_clean_str(raw.get("created_at"), 64),
        updated_at=_clean_str(raw.get("updated_at"), 64),
    )


def _deduped(highlights: Iterable[Highlight]) -> tuple[Highlight, ...]:
    """Last write wins per id; first-seen ordering is preserved."""
    by_id: dict[str, Highlight] = {}
    for highlight in highlights:
        by_id[highlight.id] = highlight
    return tuple(by_id.values())


def _clean_highlights(raw: Any) -> tuple[Highlight, ...]:
    if not isinstance(raw, Sequence) or isinstance(raw, (str, bytes)):
        return ()
    parsed = (_highlight_from_json(item) for item in raw)
    kept = _deduped(hl for hl in parsed if hl is not None)
    return kept[-MAX_HIGHLIGHTS:]


def _block_from_json(raw: Any) -> Block | None:
    if not isinstance(raw, Mapping):
        return None
    block_type = raw.get("type")
    if block_type not in BLOCK_TYPES:
        block_type = DEFAULT_BLOCK_TYPE
    return Block(
        id=_clean_str(raw.get("id"), MAX_BLOCK_ID_CHARS) or uuid.uuid4().hex,
        type=block_type,
        text="" if block_type == "divider" else _clean_str(raw.get("text"), MAX_BLOCK_CHARS),
        checked=block_type == "todo" and raw.get("checked") is True,
        anchor=_clean_anchor(raw.get("anchor")),
    )


def _clean_blocks(raw: Any) -> tuple[Block, ...]:
    """Never raises: a record with unusable blocks loads as an empty editor."""
    if not isinstance(raw, Sequence) or isinstance(raw, (str, bytes)):
        return ()
    parsed = (_block_from_json(item) for item in raw)
    return tuple(block for block in parsed if block is not None)[:MAX_BLOCKS]


def from_json(d: Any) -> DocRecord:
    """Tolerant parse of an untrusted record. Only a bad ``doc_id`` is fatal."""
    if not isinstance(d, Mapping):
        raise ValueError("record must be a JSON object")
    options = d.get("options")
    return DocRecord(
        doc_id=validate_doc_id(d.get("doc_id")),
        title=_clean_str(d.get("title"), MAX_TITLE_CHARS),
        highlights=_clean_highlights(d.get("highlights")),
        last_index=_non_negative_int(d.get("last_index")),
        options=dict(options) if isinstance(options, Mapping) else {},
        updated_at=_clean_str(d.get("updated_at"), 64),
        blocks=_clean_blocks(d.get("blocks")),
        last_sentence=_clean_resume_mark(d.get("last_sentence")),
    )


def to_json(record: DocRecord) -> dict:
    """Plain-dict form of a record; the wire and on-disk shape are the same."""
    return {
        "doc_id": record.doc_id,
        "title": record.title,
        "highlights": [
            {
                "id": hl.id,
                "page": hl.page,
                "color": hl.color,
                "text": hl.text,
                "note": hl.note,
                "rects": [dict(rect) for rect in hl.rects],
                "created_at": hl.created_at,
                "updated_at": hl.updated_at,
            }
            for hl in record.highlights
        ],
        "last_index": record.last_index,
        "last_sentence": dict(record.last_sentence) if record.last_sentence else None,
        "options": dict(record.options),
        "updated_at": record.updated_at,
        "blocks": [
            {
                "id": b.id, "type": b.type, "text": b.text, "checked": b.checked,
                "anchor": dict(b.anchor) if b.anchor else None,
            }
            for b in record.blocks
        ],
    }


def _quarantine(path: Path) -> None:
    """Move an unparseable file aside so the user's data is not silently destroyed."""
    stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%S%f")
    aside = path.with_name(f"{path.stem}.corrupt-{stamp}{JSON_SUFFIX}")
    try:
        os.replace(path, aside)
        log.warning("notes file for %s was unreadable; moved aside", path.stem)
    except OSError as exc:
        log.warning("could not quarantine notes file for %s: %s", path.stem, exc)


# ── public API ────────────────────────────────────────────────────────────────


def load(doc_id: str) -> DocRecord:
    """The stored record, or an empty one. Never raises except on a bad ``doc_id``."""
    path = _path_for(doc_id)
    try:
        raw = json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError:
        return DocRecord(doc_id=doc_id)
    except (OSError, UnicodeDecodeError, json.JSONDecodeError) as exc:
        log.warning("notes for %s could not be read: %s", doc_id, exc)
        _quarantine(path)
        return DocRecord(doc_id=doc_id)
    try:
        return from_json({**raw, "doc_id": doc_id} if isinstance(raw, Mapping) else raw)
    except (ValueError, TypeError) as exc:
        log.warning("notes for %s had an unexpected shape: %s", doc_id, exc)
        _quarantine(path)
        return DocRecord(doc_id=doc_id)


def _tmp_path(path: Path) -> Path:
    """A tmp name unique to this writer — the same defect as H4 in the audio cache.

    Two saves of one document race routinely: the debounced note save and the periodic
    position save both target `<doc_id>.json.tmp`. One writer's `os.replace` moves the
    file the other is still writing into, so the second `os.replace` raises ENOENT and
    the save is lost — reproduced by three concurrent PUTs in
    `tests/test_audio_route_budgets.py`. A per-writer name keeps the rename atomic.
    """
    return path.with_name(f"{path.name}.{os.getpid()}.{uuid.uuid4().hex}{TMP_SUFFIX}")


def save(record: DocRecord) -> DocRecord:
    """Atomically persist ``record``. Returns a NEW record; never mutates the argument."""
    path = _path_for(record.doc_id)
    saved = replace(record, updated_at=_now_iso())
    payload = json.dumps(to_json(saved), ensure_ascii=False, indent=2, sort_keys=True)
    config.DOCS_DIR.mkdir(parents=True, exist_ok=True)
    tmp = _tmp_path(path)
    try:
        with open(tmp, "w", encoding="utf-8") as fh:
            fh.write(payload)
            fh.flush()
            os.fsync(fh.fileno())
        os.replace(tmp, path)
    except OSError:
        tmp.unlink(missing_ok=True)
        raise
    return saved


def delete(doc_id: str) -> bool:
    """True if a record existed and was removed."""
    path = _path_for(doc_id)
    try:
        path.unlink()
        return True
    except FileNotFoundError:
        return False
    except OSError as exc:
        log.warning("could not delete notes for %s: %s", doc_id, exc)
        return False


def _summary(record: DocRecord) -> dict:
    return {
        "doc_id": record.doc_id,
        "title": record.title,
        "count": len(record.highlights),
        "updated_at": record.updated_at,
    }


def list_docs() -> list[dict]:
    """``[{doc_id, title, count, updated_at}]``, newest first. Never raises."""
    try:
        paths = sorted(config.DOCS_DIR.glob(f"*{JSON_SUFFIX}"))
    except OSError as exc:
        log.warning("could not list notes directory: %s", exc)
        return []
    summaries = [_summary(load(p.stem)) for p in paths if DOC_ID_RE.match(p.stem)]
    return sorted(summaries, key=lambda d: (d["updated_at"], d["doc_id"]), reverse=True)


def _highlight_markdown(highlight: Highlight) -> list[str]:
    quoted = highlight.text.strip() or "(no text)"
    lines = [f"> {line}" for line in quoted.splitlines()]
    if highlight.note.strip():
        lines += ["", f"*{highlight.note.strip()}*"]
    return lines + ["", f"({highlight.color})", ""]


NOTES_HEADING = "## Notes"
# Note headings sit under NOTES_HEADING, so they are demoted to nest beneath it.
_HEADING_PREFIX = {"h1": "### ", "h2": "#### ", "h3": "##### "}


def _block_markdown(block: Block, ordinal: int) -> list[str]:
    """One block as Markdown lines. ``ordinal`` numbers a run of ``ol`` items."""
    text = block.text.strip()
    if block.type == "divider":
        return ["---"]
    if block.type in _HEADING_PREFIX:
        return [f"{_HEADING_PREFIX[block.type]}{text}"]
    if block.type == "ul":
        return [f"- {text}"]
    if block.type == "ol":
        return [f"{ordinal}. {text}"]
    if block.type == "todo":
        return [f"- [{'x' if block.checked else ' '}] {text}"]
    if block.type == "quote":
        return [f"> {line}" for line in text.splitlines() or [""]]
    if block.type == "code":
        return ["```", *text.splitlines(), "```"]
    return [text]


def _blocks_markdown(blocks: Sequence[Block]) -> list[str]:
    """The `## Notes` section, or nothing at all when the editor is empty."""
    kept = [b for b in blocks if b.type == "divider" or b.text.strip()]
    if not kept:
        return []
    lines = [NOTES_HEADING, ""]
    ordinal = 0
    for index, block in enumerate(kept):
        ordinal = ordinal + 1 if block.type == "ol" else 0
        lines += _block_markdown(block, ordinal)
        following = kept[index + 1] if index + 1 < len(kept) else None
        same_list = (
            following is not None
            and block.type in LIST_BLOCK_TYPES
            and following.type == block.type
        )
        if not same_list:
            lines.append("")
    return lines


def export_markdown(doc_id: str) -> str:
    """Deterministic Markdown: a title, the written notes, then highlights by page."""
    record = load(doc_id)
    lines = [f"# {record.title.strip() or record.doc_id}", ""]
    lines += _blocks_markdown(record.blocks)
    pages = sorted({hl.page for hl in record.highlights})
    if not pages:
        return "\n".join(lines + ["*No highlights yet.*", ""])
    for page in pages:
        lines += [f"## Page {page}", ""]
        for highlight in record.highlights:
            if highlight.page == page:
                lines += _highlight_markdown(highlight)
    return "\n".join(lines)
