"""Does a line look like a table row, and which columns does a run of rows share?

Split out of `classify` (U31) unchanged. These predicates read only a line's own items
(their x, size and text), never the page around it, so they stand apart from the tagging
rules that call them.

Pure functions over the caller's lines; nothing is mutated.
"""

from __future__ import annotations

import re
from statistics import median
from typing import Sequence

from .types import Line

COLUMN_TOL = 4.0              # x positions within this belong to the same column
MIN_COLUMN_GAP = 8.0          # absolute whitespace floor for a column gutter
COLUMN_GAP_EMS = 1.2          # ...also expressed relative to the line's font size
COLUMN_GAP_RATIO = 2.5        # ...and relative to the line's own word spacing
COLUMN_SUPPORT_FRACTION = 0.75
CHAR_ADVANCE_RATIO = 0.5      # rough per-glyph advance, in font-size units
MIN_TABLE_COLUMNS = 3
MIN_TABLE_RUN = 3
MIN_TABLE_TOKENS = 3
NUMERIC_TOKEN_FRACTION = 0.40
SHORT_ITEM_CHARS = 8
MIN_SHORT_ITEMS = 4

_NUMERIC_TOKEN_RE = re.compile(
    r"^[(\[]?[+\-−±]?[$€£]?\d[\d,.]*\s*%?[)\]]?[*†‡]?$|^[-–—±]$")


def looks_tabular(line: Line) -> bool:
    if len(_column_starts(line)) >= MIN_TABLE_COLUMNS:
        return True
    return numeric_dominant(line) or _short_item_row(line)


def column_count(line: Line) -> int:
    """How many gutter-separated columns the line's items fall into."""
    return len(_column_starts(line))


def _column_starts(line: Line) -> tuple[float, ...]:
    """x of every item that begins a new column, per the gap rules."""
    xs = line.item_x
    if not xs:
        return ()
    gaps = _item_gaps(line)
    if not gaps:
        return (xs[0],)
    threshold = _column_threshold(gaps, line.size)
    return (xs[0], *(xs[k + 1] for k, gap in enumerate(gaps) if gap > threshold))


def _column_threshold(gaps: Sequence[float], size: float) -> float:
    """How much whitespace starts a new column.

    "2.5x the median gap" only discriminates when the line has word spacing to
    measure; one item per cell is all gutters, so its median is already a gutter.
    """
    floor = max(MIN_COLUMN_GAP, COLUMN_GAP_EMS * (size or 10.0))
    baseline = median(gaps)
    return floor if baseline >= floor else max(floor, COLUMN_GAP_RATIO * baseline)


def _item_gaps(line: Line) -> tuple[float, ...]:
    """Whitespace between items: `Line` has no widths, so a raw x-delta is pitch,
    and subtracting an estimated advance recovers the gutter whitespace."""
    xs = line.item_x
    if len(xs) < 2:
        return ()
    sizes = _padded(line.item_size, len(xs), line.size)
    texts = _padded(line.item_text, len(xs), "")
    advances = [len(t.rstrip()) * (s or line.size) * CHAR_ADVANCE_RATIO
                for s, t in zip(sizes, texts)]
    return tuple(max(0.0, b - a - adv) for a, b, adv in zip(xs, xs[1:], advances))


def shared_columns(rows: Sequence[Line]) -> list[float]:
    """Column x positions that recur across the run, within COLUMN_TOL."""
    marks = sorted((x, i) for i, row in enumerate(rows) for x in _column_starts(row))
    clusters: list[tuple[float, set[int]]] = []
    for x, owner in marks:
        if clusters and x - clusters[-1][0] <= COLUMN_TOL:
            clusters[-1][1].add(owner)
            continue
        clusters.append((x, {owner}))
    needed = max(MIN_TABLE_RUN, round(COLUMN_SUPPORT_FRACTION * len(rows)))
    return [x for x, owners in clusters if len(owners) >= needed]


def numeric_dominant(line: Line) -> bool:
    tokens = line.text.split()
    if len(tokens) < MIN_TABLE_TOKENS:
        return False
    hits = sum(1 for tok in tokens if _NUMERIC_TOKEN_RE.match(tok))
    return hits / len(tokens) > NUMERIC_TOKEN_FRACTION


def _short_item_row(line: Line) -> bool:
    texts = [t.strip() for t in line.item_text if t.strip()]
    if len(texts) < MIN_SHORT_ITEMS:
        return False
    return sum(len(t) for t in texts) / len(texts) < SHORT_ITEM_CHARS


def _padded(seq: Sequence, size: int, fill):  # type: ignore[no-untyped-def]
    return [seq[i] if i < len(seq) else fill for i in range(size)]
