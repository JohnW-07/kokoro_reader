"""Page furniture: running heads and feet, page numbers, stamps, browser print chrome.

Split out of `classify.py`, which applies `furniture_tag` to each line. Also the
document-level stats pass the furniture rules read (`compute_doc_stats`), the server-side
twin of the client's `docstats.js`. Pure functions, no I/O.
"""

from __future__ import annotations

import re
from collections import Counter
from typing import Sequence

from .. import config
from .types import DocStats, Line, PageGeometry

MIN_REPEAT_PAGES = 4          # below this a repeated-line sample is not trustworthy
MAX_FURNITURE_CHARS = 140

_PUNCT_RE = re.compile(r"[^\w\s]", re.UNICODE)
_DIGIT_RUN_RE = re.compile(r"\d+")
_WS_RE = re.compile(r"\s+")
_PAGENUM_RE = re.compile(r"\d{1,4}|[ivxlcdm]{1,7}|\d+\s*(?:of|/)\s*\d+", re.I)
REF_HEADING_RE = re.compile(
    r"(?:(?:\d+(?:\.\d+)*|[ivxlcdm]+)\s*[.)]?\s+)?"
    r"(?:references?|bibliography|works\s+cited|literature\s+cited)\s*[.:]?", re.I)
_VENUE_RE = r"\b(?:neurips|nips|icml|iclr|cvpr|eccv|iccv|acl|emnlp|aaai)\s*'?\d{2,4}\b"
_FURNITURE_RES: tuple[tuple[re.Pattern[str], str], ...] = (
    # The side stamp's own shape: an id in a reference or a sentence is not the stamp (U17c).
    (re.compile(r"^arxiv:\s*\d{4}\.\d{4,5}v\d+\s*\[[\w.\-]+\]", re.I), "arXiv stamp"),
    (re.compile(r"^preprint\b(?![,\s]+arxiv)", re.I), "preprint stamp"),
    (re.compile(r"\bunder review as a conference paper\b", re.I), "submission stamp"),
    (re.compile(r"\bpublished as a conference paper\b", re.I), "publication stamp"),
    (re.compile(r"\bproceedings of the\b", re.I), "proceedings stamp"),
    (re.compile(r"\bdoi:\s*\S", re.I), "DOI stamp"),
    (re.compile(r"©|\(c\)\s*\d{4}|\bcopyright\b", re.I), "copyright notice"),
    (re.compile(_VENUE_RE, re.I), "venue stamp"),
    (re.compile(r"^vol\.?\s*\d+\b.*\b(?:no\.?|pp\.?)\s*\d+", re.I), "journal stamp"),
)
#: A browser's print date and time: Safari "7/23/26, 9:30 PM", Chrome "23.07.26, 21:30".
_PRINT_STAMP = (r"\d{1,2}[/.]\d{1,2}[/.]\d{2,4},?\s+\d{1,2}:\d{2}(?::\d{2})?"
                r"(?:\s*[ap]\.?m\.?)?")
#: The header opens or closes with the stamp; the page title fills the rest (N10).
_PRINT_HEADER_RE = re.compile(rf"^{_PRINT_STAMP}(?:\s|$)|\s{_PRINT_STAMP}$", re.I)
#: The footer opens with the page's address, or closes with "Page 1 of 3".
_PRINT_FOOTER_RE = re.compile(r"^(?:https?|file)://\S|\bpage\s+\d+\s*(?:of|/)\s*\d+$", re.I)


def normalize_key(text: str) -> str:
    """Lowercase, strip punctuation, collapse digit runs — the repeated-line key."""
    stripped = _PUNCT_RE.sub(" ", text.lower())
    return _WS_RE.sub(" ", _DIGIT_RUN_RE.sub("#", stripped)).strip()


def _bands(line: Line, height: float) -> tuple[bool, bool]:
    """(in the header band, in the footer band)."""
    return (line.y <= height * config.HEADER_BAND,
            line.y >= height * (1.0 - config.FOOTER_BAND))


def _outer_bands(line: Line, height: float) -> tuple[bool, bool]:
    """(in the outer top band, in the outer bottom band) where a browser prints its chrome."""
    return (line.y <= height * config.PRINT_CHROME_BAND,
            line.y >= height * (1.0 - config.PRINT_CHROME_BAND))


def compute_doc_stats(pages: Sequence[PageGeometry]) -> DocStats:
    """Server-side equivalent of the client's stats pass; used by tests."""
    if not pages:
        return DocStats()
    body_size = _modal_size(pages)
    return DocStats(
        body_size=body_size,
        num_pages=len(pages),
        repeated=_repeated_furniture(pages, body_size),
        reference_page=_find_reference_page(pages),
    )


def _modal_size(pages: Sequence[PageGeometry]) -> float:
    """Modal font size weighted by character count, not by line count."""
    weight: Counter[float] = Counter()
    for page in pages:
        for line in page.lines:
            runs = (list(zip(line.item_size, line.item_text)) if line.item_size
                    and len(line.item_size) == len(line.item_text)
                    else [(line.size, line.text)])
            for size, text in runs:
                if text.strip() and size > 0:
                    weight[round(size, 1)] += len(text.strip())
    if not weight:
        return DocStats().body_size
    return max(weight.items(), key=lambda kv: (kv[1], -kv[0]))[0]


def _repeated_furniture(pages: Sequence[PageGeometry], body_size: float) -> frozenset[str]:
    """Keys of edge lines repeated on many pages. Mirrors `computeRepeated` in docstats.js.

    A document shorter than `MIN_REPEAT_PAGES` is sampled too thinly for its own text to
    count, but small type in the outermost band repeating on two of its pages is the
    furniture of a printed web page (N10).
    """
    short = len(pages) < MIN_REPEAT_PAGES
    if short and len(pages) < config.MIN_SMALL_EDGE_REPEAT_PAGES:
        return frozenset()
    seen: Counter[str] = Counter()
    for page in pages:
        band = {normalize_key(ln.text) for ln in page.lines
                if any(_bands(ln, page.height))
                and (not short or _is_small_edge(ln, page.height, body_size))}
        seen.update(key for key in band if key.strip("# "))
    threshold = max(config.MIN_SMALL_EDGE_REPEAT_PAGES,
                    config.REPEAT_PAGE_FRACTION * len(pages))
    return frozenset(key for key, hits in seen.items() if hits >= threshold)


def _is_small_edge(line: Line, height: float, body_size: float) -> bool:
    return (any(_outer_bands(line, height))
            and 0 < line.size <= body_size * config.SMALL_EDGE_SIZE_RATIO)


def _find_reference_page(pages: Sequence[PageGeometry]) -> int | None:
    """First bibliography heading sitting in the back half of the document."""
    for ordinal, page in enumerate(pages):
        if ordinal * 2 < len(pages):
            continue
        for line in page.lines:
            if REF_HEADING_RE.fullmatch(line.text.strip()):
                return page.page
    return None


def furniture_tag(line: Line, lines: Sequence[Line], height: float,
                  stats: DocStats) -> tuple[str, str] | None:
    """(kind, reason) when `line` is page furniture, else None."""
    text = line.text.strip()
    if not text:
        return None
    top, bottom = _bands(line, height)
    edge_kind = "header" if top else "footer"
    if (top or bottom) and _PAGENUM_RE.fullmatch(text):
        return "pagenum", "page number in the margin"
    if stamp := _furniture_stamp(text):
        return ("header" if line.y < height / 2 else "footer"), stamp
    if (top or bottom) and normalize_key(text) in stats.repeated:
        return edge_kind, f"repeats in the {edge_kind} of many pages"
    if (top or bottom) and _at_repeated_position(line, text, lines, stats):
        return edge_kind, f"sits where every page's {edge_kind} sits"
    if kind := _print_chrome(line, text, lines, height, stats):
        return kind, f"browser print {kind}"
    return None


def _print_chrome(line: Line, text: str, lines: Sequence[Line], height: float,
                  stats: DocStats) -> str:
    """"header" or "footer" when `line` is the chrome a browser prints on a saved page (N10).

    One page is enough: the signature is the outermost line, in the outer band, in type no
    larger than the body, reading as a title with a date and time or as an address with a
    page count. A saved web page is 1-3 pages, too few for any repetition rule.
    """
    top, bottom = _outer_bands(line, height)
    if not (top or bottom) or line.size > stats.body_size * config.PRINT_CHROME_SIZE_RATIO:
        return ""
    if not (_PRINT_HEADER_RE.search(text) or _PRINT_FOOTER_RE.search(text)):
        return ""
    tol = config.REPEAT_Y_TOLERANCE
    ys = [ln.y for ln in lines if ln.text.strip()]
    if top and min(ys) >= line.y - tol:
        return "header"
    if bottom and max(ys) <= line.y + tol:
        return "footer"
    return ""


def _at_repeated_position(line: Line, text: str, lines: Sequence[Line],
                          stats: DocStats) -> bool:
    """A short, solitary edge line at a y the whole document reserves for its running head.

    Catches a running head whose text changes with the section — "2.4 Vector Spaces 35" —
    which text repetition alone cannot see.

    The "solitary" and "first-or-last line" tests are load-bearing, not belt-and-braces.
    Two-column papers share baselines across the gutter with constant leading, so *every*
    y in the edge band recurs on every page; without these guards this rule deletes whole
    paragraphs as furniture.
    """
    if not stats.repeated_y or len(text) > config.MAX_RUNNING_HEAD_CHARS:
        return False
    tol = config.REPEAT_Y_TOLERANCE
    if not any(abs(line.y - y) <= tol for y in stats.repeated_y):
        return False

    usable = [ln for ln in lines if ln.text.strip()]
    if len(usable) < 3 or line not in (usable[0], usable[-1]):
        return False
    if sum(1 for ln in usable if abs(ln.y - line.y) <= tol) != 1:
        return False
    return _is_set_off_from_body(line, usable)


def _is_set_off_from_body(line: Line, usable: Sequence[Line]) -> bool:
    """True when more whitespace separates `line` from the text than separates body lines.

    The last line of a paragraph sitting in the footer band is otherwise indistinguishable
    from a running foot, and dropping it loses a real sentence per page.
    """
    ys = sorted({round(ln.y, 1) for ln in usable})
    gaps = [b - a for a, b in zip(ys, ys[1:])]
    if len(gaps) < 2:
        return False
    own = gaps[0] if round(line.y, 1) == ys[0] else gaps[-1]
    rest = sorted(gaps[1:] if round(line.y, 1) == ys[0] else gaps[:-1])
    body_gap = rest[len(rest) // 2]
    return body_gap > 0 and own >= config.RUNNING_HEAD_GAP_RATIO * body_gap


def _furniture_stamp(text: str) -> str:
    if len(text) > MAX_FURNITURE_CHARS:
        return ""
    return next((why for rx, why in _FURNITURE_RES if rx.search(text)), "")
