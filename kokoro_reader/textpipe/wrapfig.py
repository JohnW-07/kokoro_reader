"""Separate prose from a figure set beside it (a wrapped figure) before classification.

pdf.js hands the client items, and the client joins items that share a baseline into one
`Line`. Next to a wrapped figure that join runs straight across the gutter: GR00TN1.pdf p2
prints "for generalist humanoid robots. The GR00T N1" at 62-283 and the figure label
"Real-World Data" at 351 on the same baseline, and the merged line was centred enough to
read as display maths, cutting "We introduce GR00T N1, an open foundation model" off from
the rest of its sentence. Five more rows glued `Figure 1:` and its caption onto the prose.

The tell is the prose itself: beside the figure it is justified to a narrower measure, so
most of its lines end at one x (the gutter). Where a run of left-flow lines keeps to that
measure and some of them carry items starting past the gutter, those items are a separate
column: each such line is cut at the gutter, and the side column -- cut-off tails plus
the side lines interleaved with the run -- is moved out of the prose to the next sentence
end, which is where a reader would look at the figure.

Pages without such a run are returned unchanged, object for object. When lines are cut,
every line is re-indexed by its new position, so `line_ids` stay unique; nothing outside
the server reads them.
"""

from __future__ import annotations

from collections import Counter
from dataclasses import dataclass, replace
from statistics import median
from typing import Sequence

from .types import DocStats, Line, PageGeometry

GUTTER_TOL = 4.0            # prose lines ending within this of each other share a measure
MIN_GUTTER = 8.0            # whitespace between the measure and the side column
MIN_MEASURE_INSET = 0.15    # the measure stops at least this fraction of the page short
MIN_MEASURE_LINES = 4       # lines that must end at the measure before it is believed
MIN_MEASURE_SHARE = 0.5     # ...and the share of the run's lines that do, cut rows counted
MIN_CUT_LINES = 2           # rows that must cross the gutter: one is a coincidence
SIZE_TOL = 0.4              # body type, within this many points
INDENT_EMS = 1.5            # a prose line starts within this of the left margin
MAX_HEAD_OVERRUN = 1.3      # text before a cut is at most this many measures' worth
_SENTENCE_END = (".", "?", "!")


@dataclass(frozen=True)
class _Measure:
    """The narrow text column beside a figure: where it starts, ends, and how much fits."""
    left: float
    indent: float
    gutter: float
    max_chars: float

    def starts(self, line: Line) -> bool:
        return line.x0 <= self.left + self.indent

    def holds(self, line: Line) -> bool:
        return abs(line.x1 - self.gutter) <= GUTTER_TOL


def unwrap_page(geom: PageGeometry, stats: DocStats) -> PageGeometry:
    """`geom` with every wrapped-figure run split into prose and side column."""
    lines = geom.lines
    measure = _measure(lines, stats, geom.width)
    if measure is None:
        return geom
    runs = [run for run in _runs(lines, measure) if _is_wrap(lines[run[0]:run[1]], measure)]
    if not runs:
        return geom
    out = list(lines)
    for start, end in reversed(runs):  # later runs first, so earlier indices hold
        out = _unwrap_run(out, start, end, measure)
    return replace(geom, lines=tuple(replace(ln, idx=k) for k, ln in enumerate(out)))


def _measure(lines: Sequence[Line], stats: DocStats, width: float) -> _Measure | None:
    """The x most margin-aligned body lines stop at, well short of the page's right edge."""
    left = min((ln.x0 for ln in lines), default=0.0)
    right = max((ln.x1 for ln in lines), default=width)
    indent = INDENT_EMS * stats.body_size
    body = [ln for ln in lines if _is_body(ln, stats) and ln.x0 <= left + indent
            and ln.x1 < right - MIN_MEASURE_INSET * (right - left)]
    ends = Counter(round(ln.x1 / GUTTER_TOL) for ln in body)
    if not ends:
        return None
    bucket, hits = ends.most_common(1)[0]
    if hits < MIN_MEASURE_LINES:
        return None
    held = [ln for ln in body if abs(ln.x1 / GUTTER_TOL - bucket) <= 1]
    return _Measure(left=left, gutter=max(ln.x1 for ln in held), indent=indent,
                    max_chars=MAX_HEAD_OVERRUN * median(len(ln.text) for ln in held))


def _is_body(line: Line, stats: DocStats) -> bool:
    return abs(line.size - stats.body_size) <= SIZE_TOL and bool(line.text.strip())


def _runs(lines: Sequence[Line], m: _Measure) -> list[tuple[int, int]]:
    """Maximal index ranges where every line is in-measure, side-column, or cuttable."""
    runs, start = [], None
    for k, line in enumerate([*lines, None]):
        fits = line is not None and (line.x1 <= m.gutter + GUTTER_TOL
                                     or line.x0 >= m.gutter + MIN_GUTTER
                                     or _cut_at(line, m) is not None)
        if fits and start is None:
            start = k
        elif not fits and start is not None:
            runs.append((start, k))
            start = None
    return runs


def _is_wrap(run: Sequence[Line], m: _Measure) -> bool:
    """Whether `run` is prose kept to the measure with a column beside it.

    A cut row keeps the measure too -- its prose half ends at the gutter, the join with
    the side column is what hides that -- so it counts towards the share alongside the
    rows that were never joined. Counting only untouched rows would make a figure harder
    to spot the more baselines it merges with the prose.
    """
    flow = [ln for ln in run if ln.x0 < m.gutter]
    in_measure = sum(m.starts(ln) and m.holds(ln) for ln in flow)
    cuts = sum(_cut_at(ln, m) is not None for ln in flow)
    return (in_measure >= MIN_MEASURE_LINES and cuts >= MIN_CUT_LINES
            and in_measure + cuts >= MIN_MEASURE_SHARE * len(flow))


def _cut_at(line: Line, m: _Measure) -> int | None:
    """Index of the first item past the gutter, on a prose line that could fill the measure.

    Items past the gutter on a line whose text before them is far longer than the
    measure holds belong to a full-width line -- an italic word, a trailing "It".
    """
    xs = line.item_x
    if (len(xs) < 2 or len(xs) != len(line.item_text) or not m.starts(line)
            or line.x1 < m.gutter + MIN_GUTTER):
        return None
    cut = next((k for k, x in enumerate(xs) if x >= m.gutter + MIN_GUTTER), None)
    if cut is None or len("".join(line.item_text[:cut]).strip()) > m.max_chars:
        return None
    return cut


def _unwrap_run(lines: list[Line], start: int, end: int, m: _Measure) -> list[Line]:
    flow: list[Line] = []
    side: list[Line] = []
    for line in lines[start:end]:
        if line.x0 >= m.gutter:
            side.append(line)
            continue
        cut = _cut_at(line, m)
        if cut is None:
            flow.append(line)
            continue
        head, tail = _split(line, cut, m.gutter)
        flow.append(head)
        side.append(tail)
    merged = [*flow, *lines[end:]]
    at = next((k + 1 for k in range(len(flow) - 1, len(merged))
               if merged[k].text.rstrip().endswith(_SENTENCE_END)), len(merged))
    return [*lines[:start], *merged[:at], *side, *merged[at:]]


def _split(line: Line, cut: int, gutter: float) -> tuple[Line, Line]:
    """Two lines from one: items before `cut`, and the rest, each with its own extent."""
    at = _text_offset(line.text, sum(len("".join(t.split())) for t in line.item_text[:cut]))
    sizes = line.item_size if len(line.item_size) == len(line.items) else ()
    head = replace(line, text=line.text[:at].rstrip(), x1=_head_x1(line, cut, gutter),
                   items=line.items[:cut], item_x=line.item_x[:cut],
                   item_text=line.item_text[:cut], item_size=sizes[:cut],
                   size=_modal(sizes[:cut], line.size))
    tail = replace(line, text=line.text[at:].strip(), x0=line.item_x[cut],
                   items=line.items[cut:], item_x=line.item_x[cut:],
                   item_text=line.item_text[cut:], item_size=sizes[cut:],
                   size=_modal(sizes[cut:], line.size))
    return head, tail


def _head_x1(line: Line, cut: int, gutter: float) -> float:
    """Where the kept items end: the last one starts at a known x and runs on from there.

    pdf.js gives no item width, so the last item's width is its character count times the
    mean advance of the items before it. A short head must not be reported as reaching the
    gutter -- the ragged-end and centring tests downstream read that as a filled measure.
    """
    kept, last = line.item_x[:cut], line.item_text[cut - 1]
    chars = len("".join(line.item_text[:cut - 1]))
    span = kept[-1] - kept[0]
    if chars <= 0 or span <= 0:
        return min(line.x1, gutter)
    return min(gutter, kept[-1] + span / chars * len(last))


def _text_offset(text: str, glyphs: int) -> int:
    """Offset in `text` just past its first `glyphs` non-space characters."""
    seen = 0
    for k, ch in enumerate(text):
        if seen == glyphs:
            return k
        seen += not ch.isspace()
    return len(text)


def _modal(sizes: Sequence[float], fallback: float) -> float:
    if not sizes:
        return fallback
    return round(Counter(round(s, 1) for s in sizes).most_common(1)[0][0], 1)
