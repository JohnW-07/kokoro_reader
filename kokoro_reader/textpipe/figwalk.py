"""Text printed *inside* a figure: axis ticks, legends, node labels, arrow captions.

None of it is written to be read in sequence, and on a figure whose embedded font carries
no ToUnicode map it is not even text -- PiZero.pdf p1 spoke 22 sentences of glyph soup off
one diagram.

A figure is a *region*, so the walk is geometric: outwards from the caption in page order,
absorbing lines until real prose -- body type running a real measure, set in the page's
text flow -- ends it. Index adjacency cannot do this job. Column ordering carries the right
half of a full-width figure hundreds of lines away from the left half, and only one half is
then adjacent to the caption; that is how PiZero.pdf p1 started speaking eleven blocks of
soup again once two-column ordering landed (J6).

The caption anchor is what makes it safe. Display maths is also short and also small on
occasion, so without an actual figure identified nearby this rule would silence equations
-- the one thing this reader must never do.

Pure functions over the caller's lines; nothing is mutated.
"""

from __future__ import annotations

from collections import Counter
from dataclasses import dataclass, replace
from itertools import count
from typing import Iterable, Sequence

from .. import config
from .types import Line

MIN_FIGURE_RUN = 2        # below this a caption-adjacent run is not a figure interior
CAPTION_SIZE_TOL = 0.4    # pt: type within this of the caption's is the caption's
COLUMN_TOL = 4.0          # pt: a line starting within this of a column's edge starts there
INDENT_EMS = 1.5          # ...or indented at most this many ems, a paragraph's first line
STEP_TOL = 0.25           # a flow line sits within this fraction of the line step of the next
MIN_START_LINES = 3       # a column's edge is where at least this many prose lines start
OVERLAY_KINDS = ("header", "footer", "pagenum")
INTERIOR_KINDS = ("table",)  # already silent, and the grid under a caption is its interior


@dataclass(frozen=True)
class _Page:
    lines: Sequence[Line]
    kinds: Sequence[str | None]
    body_size: float
    line_gap: float
    measure: float
    headings: frozenset[int]
    starts: tuple[float, ...] = ()
    flow_font: str | None = None


def figure_regions(
    lines: Sequence[Line],
    kinds: Sequence[str | None],
    captions: Iterable[Sequence[int]],
    *,
    body_size: float,
    line_gap: float,
    headings: frozenset[int] = frozenset(),
) -> tuple[tuple[int, ...], ...]:
    """Each figure interior found above or below a caption, in the order it was found.

    `kinds` holds what earlier rules claimed each line as (None for a free line); a region
    found here is claimed for the walks after it, as a caption's own figure would be.
    `headings` are the lines shaped like a section title, whatever their width.
    """
    order = sorted(range(len(lines)), key=lambda i: (lines[i].y, lines[i].x0))
    seat = {i: k for k, i in enumerate(order)}
    page = _Page(lines, kinds, body_size, line_gap, _measure(lines), headings)
    stacked = tuple(i for i in range(len(lines)) if _stacked(page, i))
    page = replace(page, starts=_column_starts(page, stacked), flow_font=_flow_font(page, stacked))
    found: list[tuple[int, ...]] = []
    for group in captions:
        head, tail = min(group, key=seat.__getitem__), max(group, key=seat.__getitem__)
        band = (min(lines[i].x0 for i in group), max(lines[i].x1 for i in group))
        steps = (-1,) if _body_type_wrapped(lines, group, body_size) else (-1, 1)
        for seed, step in ((seat[head] if st < 0 else seat[tail], st) for st in steps):
            claimed = frozenset(i for region in found for i in region)
            region = _figure_region(page, order, seed, step, band, claimed)
            if len(region) >= MIN_FIGURE_RUN:
                found.append(region)
    return tuple(found)


def _body_type_wrapped(lines: Sequence[Line], group: Sequence[int], body_size: float) -> bool:
    """A caption wrapped over lines in the body's own type is not walked below.

    Its type is the body's, so type under it smaller than the caption's is as likely the
    page's prose as its figure's: PiZero.pdf p1 sets its abstract at 9pt straight under a
    five-line 10pt `Fig. 1:`, and the walk down read it as the figure. Such a caption sits
    under the figure it describes; the walk up still finds it. A turned caption's lines run
    down the page, so above and below it mean nothing: it is walked both ways.
    """
    head = lines[group[0]]
    return len(group) > 1 and not head.turned and head.size >= body_size - CAPTION_SIZE_TOL


def _measure(lines: Sequence[Line]) -> float:
    """The widest real line: a blank item run across the page is no text measure.

    VLALitReview.pdf p14 carries an empty line from 44 to 490, across both columns.
    Counted, it nearly doubles the page's measure (446pt, not 242pt), and the walk takes
    the short last line of a paragraph, "shown in Fig. 7.", for figure text.
    """
    return max((ln.width for ln in lines if ln.text.strip() and ln.width > 0), default=0.0)


def _column_starts(page: _Page, stacked: Sequence[int]) -> tuple[float, ...]:
    """Left edges the page's text runs down: where lines stacked one step apart start."""
    xs = sorted(page.lines[i].x0 for i in stacked)
    clusters: list[list[float]] = []
    for x in xs:
        if clusters and x - clusters[-1][0] <= COLUMN_TOL:
            clusters[-1].append(x)
        else:
            clusters.append([x])
    return tuple(c[0] for c in clusters if len(c) >= MIN_START_LINES)


def _flow_font(page: _Page, stacked: Sequence[int]) -> str | None:
    """The font the page's running prose is set in."""
    fonts = Counter(page.lines[i].font for i in stacked if _prose_type(page, page.lines[i]))
    return fonts.most_common(1)[0][0] if fonts else None


def _stacked(page: _Page, i: int) -> bool:
    """A line of text a real measure wide, with another under or over it, one step away,
    starting at the same edge: a paragraph's, a caption's or a list's lines."""
    return _wide(page, page.lines[i]) and any(
        _on_step(page, i, j) and _wide(page, page.lines[j])
        and abs(page.lines[j].x0 - page.lines[i].x0) <= COLUMN_TOL for j in (i - 1, i + 1))


def _on_step(page: _Page, i: int, j: int) -> bool:
    """Line `j` is the next or previous line of `i`'s text: under it, one line step away."""
    if not 0 <= j < len(page.lines):
        return False
    a, b = page.lines[i], page.lines[j]
    step = abs(b.y - a.y)
    return (abs(step - page.line_gap) <= page.line_gap * STEP_TOL
            and abs(a.size - b.size) <= CAPTION_SIZE_TOL
            and a.x0 < b.x1 and b.x0 < a.x1)


def _figure_region(page: _Page, order: Sequence[int], seed: int, step: int,
                   band: tuple[float, float], claimed: frozenset[int]) -> tuple[int, ...]:
    """Lines running away from one caption, up to the text that bounds the figure.

    Only lines under the figure -- overlapping its x-band -- are its business. Page order
    is a single sequence in y, so on a two-column page the other column's prose
    interleaves with this figure's interior: on PiZero.pdf p6 the first line the walk
    meets above `Fig. 5:` is left-column body text, which bounds it on its first step and
    leaves the two rows of robot names above the figure to be read aloud ("Bimanual UR5e
    Bimanual Trossen Bimanual ARX"). Prose in the other column is not this figure's
    boundary and not its interior; it is invisible to the walk.

    The band only ever decides whether a line may *bound* the walk, never whether it may
    be absorbed: a figure is routinely far wider than the caption centred under it --
    PiZero.pdf p4 sets `Fig. 3:` across 49-219 and the diagram over it across 58-524 --
    so a line outside the band is still the figure's interior if it is not prose.
    """
    lines = page.lines
    max_size = page.body_size * config.FIGURE_SIZE_RATIO
    caption = lines[order[seed]].size
    out: list[int] = []
    for k in count(seed + step, step):
        if not 0 <= k < len(order):
            break
        i = order[k]
        mine = _overlaps_band(lines[i], band)
        kind = "figure" if i in claimed else page.kinds[i]
        if kind is not None:
            # A running head or page number is printed over the page, not in the flow:
            # it can land inside a figure's band without being a boundary.
            if kind in OVERLAY_KINDS or kind in INTERIOR_KINDS or not mine:
                continue
            break
        if mine and _titles_section(page, i):
            break
        if _bounds_figure(page, i, caption):
            if not mine:
                continue
            if _in_flow(page, i):
                break
        out.append(i)
    while (out and lines[out[-1]].size > max_size
            and any(lines[i].size <= max_size for i in out)):
        # A wide-font line at the far edge of the walk -- a stub heading, a short equation
        # -- is figure text only when figure text follows it. Nothing follows the last one.
        # When *nothing* in the region is sub-body type there is no figure text for it to
        # follow and the rule has nothing to say: VLALitReview.pdf p8 sets every label in
        # its diagram at the body's own 10pt, and trimming on size alone empties the whole
        # region and reads the diagram aloud ("(2) Latent action generation").
        out.pop()
    return tuple(out)


def _overlaps_band(line: Line, band: tuple[float, float]) -> bool:
    return line.x0 < band[1] and line.x1 > band[0]


def _bounds_figure(page: _Page, i: int, caption: float) -> bool:
    """Where the figure may end: type at or above the caption's, running a real measure.

    Sub-caption type is the figure's own -- that is the premise this rule has always
    rested on. Type at the caption's size or larger is either the caption's own wrapped
    text or the prose around it, *unless* it is far too narrow to be either, which is a
    label the figure happened to set in a big font (PiZero.pdf p1 sets one at 10.7pt
    against a 10.0pt body, 11.7pt wide).

    Body type bounds the figure whatever the caption is set in: a caption set *larger*
    than the body -- bold, or a point up -- would otherwise leave no prose on the page
    able to stop the walk at all.

    Vetoing on the *text* looking like maths was tried here and reverted. Glyph soup off
    a figure with no ToUnicode map scores higher on `math_density` than real display
    maths does, so the veto handed PiZero.pdf p1 back its 16 blocks of soup (measured
    2026-09-13 over the 11-paper corpus: soup 70 -> 109). The equation's protection is
    the caption anchor and the trailing-size trim, not a text test.
    """
    line = page.lines[i]
    return _wide(page, line) and (line.size >= page.body_size - CAPTION_SIZE_TOL
                                  or abs(line.size - caption) <= CAPTION_SIZE_TOL)


def _wide(page: _Page, line: Line) -> bool:
    return line.width > page.measure * config.FIGURE_PROSE_WIDTH_RATIO


def _prose_type(page: _Page, line: Line) -> bool:
    return _wide(page, line) and line.size >= page.body_size - CAPTION_SIZE_TOL


def _in_flow(page: _Page, i: int) -> bool:
    """Set in the page's text, not in a figure under a caption as wide as the page (U16).

    A caption that spans both columns puts every line on the page inside its band, so a
    wide label in bounding type must still prove it is prose before it ends the walk --
    VLALitReview.pdf p2, p8 and p17 and VLAW.pdf p5 and p6 spoke their diagrams when any
    wide line did. The proof depends on the line's type:

    - below the body's size: flush at a column's edge, or `_set_with` a line of prose;
    - in the font the page's prose is set in: always prose;
    - at the body's size in another font: at a column's edge or a paragraph indent in;
    - larger (a heading's or caption's type): flush at an edge, or `_stacked` in a block.

    A label is centred on its box and sits at the box's spacing, so it passes none of these.
    """
    line = page.lines[i]
    if not page.starts:
        return True
    if line.size < page.body_size - CAPTION_SIZE_TOL:
        return _at_edge(page, i, indent=0.0) or _set_with(page, i)
    if line.font == page.flow_font:
        return True
    if abs(line.size - page.body_size) <= CAPTION_SIZE_TOL:
        return _at_edge(page, i)
    return _at_edge(page, i, indent=0.0) or _stacked(page, i)


def _set_with(page: _Page, i: int) -> bool:
    """Set one leading from a line of prose before or after it: the rest of its paragraph,
    flush at a column's edge, or the next line of a centred block (PI0_6.pdf p1's authors).

    A table's cells are neither. Its columns start inside the page's, and a narrow cell
    can sit centred on the one beside it by accident: VLALitReview.pdf p23 read half of
    `TABLE 2.` aloud when either was taken for a paragraph.
    """
    a = page.lines[i]
    step = page.line_gap * a.size / page.body_size
    return any(0 <= j < len(page.lines)
               and abs(abs(page.lines[j].y - a.y) - step) <= step * STEP_TOL
               and _wide(page, page.lines[j])
               and (_at_edge(page, j, indent=0.0) or _centred(a, page.lines[j]))
               for j in (i - 1, i + 1))


def _centred(a: Line, b: Line) -> bool:
    return abs(a.x0 + a.x1 - b.x0 - b.x1) / 2 <= COLUMN_TOL


def _titles_section(page: _Page, i: int) -> bool:
    """A section title set flush at a column's edge, in type too big to be a figure's own.

    Such a title can be as narrow as a label, and set in neither the body's font nor its
    size: Cosmos.pdf p5 heads its section "2.2. Current Cosmos" at 12pt, 115pt wide, right
    over a diagram whose labels are body-size, and the walk up from `Figure 4:` read through
    it. Flush means flush: labels shaped like titles sit indented inside their boxes (PSI.pdf
    p9 "Single Frame", GR00TN1.pdf p21 "GR00T-N1-2B"), and a 4pt print timestamp inside an
    SVG (VLAW.pdf p2) is figure type whatever its shape.
    """
    line = page.lines[i]
    return (i in page.headings and line.size > page.body_size * config.FIGURE_SIZE_RATIO
            and _at_edge(page, i, indent=0.0))


def _at_edge(page: _Page, i: int, indent: float = INDENT_EMS) -> bool:
    line = page.lines[i]
    return any(start - COLUMN_TOL <= line.x0 <= start + COLUMN_TOL + indent * line.size
               for start in page.starts)
