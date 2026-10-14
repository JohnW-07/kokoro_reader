"""Rule-based classification of a page's lines into typed blocks.

Pure functions: no I/O, no mutation of the caller's objects. Every decision carries
a `reason`, because the UI must explain why it greyed a region out.
"""

from __future__ import annotations

import re
from collections import Counter
from dataclasses import dataclass
from itertools import count
from statistics import median
from typing import Callable, Iterable, Iterator, Sequence

from .. import config
from . import capwrap, figwalk, headshape, headwrap
from .furniture import (  # noqa: F401  re-exported
    REF_HEADING_RE, compute_doc_stats, furniture_tag, normalize_key)
from .figwalk import CAPTION_SIZE_TOL
from .tablerow import (COLUMN_TOL, MIN_TABLE_COLUMNS, MIN_TABLE_RUN, looks_tabular,
                       numeric_dominant, shared_columns)
from .types import Block, DocStats, Line, PageGeometry, flatten_items

try:  # mathspeak is authored in parallel; the reader must not depend on its arrival.
    from .mathspeak import looks_like_equation, math_density, reads_as_sentence
except ImportError:  # pragma: no cover - only taken while mathspeak is missing
    _MATH_CHARS = frozenset("=+×÷±∓∑∏∫∮√∞≤≥≠≈≡∝∈∉⊂⊆⊃⊇∪∩∀∃∄∇∂⊕⊗→←↔⇒⇔"
                            "αβγδεζηθικλμνξπρστυφχψωΓΔΘΛΞΠΣΦΨΩ^_{}\\<>|")

    def math_density(text: str) -> float:
        glyphs = [c for c in text if not c.isspace()]
        return sum(c in _MATH_CHARS for c in glyphs) / len(glyphs) if glyphs else 0.0

    def looks_like_equation(text: str) -> bool:
        return math_density(text) >= 0.30

    def reads_as_sentence(text: str) -> bool:
        return False


MIN_CODE_RUN = 2
MAX_UNMARKED_NOTE_LINES = 4   # an affiliation or correspondence block is short
NOTE_GAP_MIN = 1.5            # ...pushed below the body by more than a line break
NOTE_GAP_MAX = 4.0            # ...but still attached to it, not adrift on the page
MAX_HEADING_CHARS = 90
MAX_CAPS_HEADING_CHARS = 60
CAPTION_INDENT_TOL = 8.0
EQUATION_CENTRE_TOL = 0.12
EQUATION_WIDTH_RATIO = 0.85
EQUATION_MATH_DENSITY = 0.30
MIN_PROSE_WORDS = 4           # words of 3+ letters, with no notation, make a centred line prose
TITLE_PAGE = 1                # the only page with a byline; elsewhere plain words are labels
ROTATED_PAGE_FRACTION = 0.5   # past this share of turned text lines the page itself is turned
RIGHT_FLUSH_TOL = 8.0
LIST_HANG_MAX_EMS = 2.0       # a bullet's continuation is indented at most this far past it
REF_HEADING_Y_TOL = 0.5       # the client reports the heading's own baseline
PARA_GAP_RATIO = 1.6
TURNED_PITCH_EMS = 1.2 * PARA_GAP_RATIO  # a turned wrap steps ~1.2 em in x0; past 1.6 pitches it breaks
BESIDE_GAP_RATIO = 0.5         # a label within this of the next baseline sits beside it
PARA_INDENT_MIN = 6.0
SHORT_LAST_LINE_RATIO = 0.85
MONO_FONT_HINTS = ("mono", "courier", "consol", "menlo", "cmtt", "typewriter")
BOLD_FONT_HINTS = ("bold", "bd", "black")

_CITATION_LINE_RE = re.compile(r"^\[\d+\]\s")
#: Marks prose never opens with. Superscript digits count; `‖` deliberately does not,
#: because a display norm `‖x‖ ≤ 1` can land in the footnote band.
_FOOTNOTE_SYMBOL_RE = re.compile(r"^[*†‡§¶∗⋆⁰¹²³⁴⁵⁶⁷⁸⁹]")
#: An ASCII digit marker followed by the note itself — `3Unless ...` or `4 We use ...`.
#: A second digit after the marker means this is a number in the text, not a marker.
_FOOTNOTE_DIGIT_RE = re.compile(r"^\d{1,2}\s*(?=[^\d\s]|$)")
_CAPTION_RE = re.compile(
    r"^(?:figure|fig|table|tab|algorithm|alg|listing|eq|equation)\s*\.?\s*"
    r"(?:\d+[a-z]?|[ivxlc]+)\s*[.:)]?(?:\s|$)", re.I)
#: A section number introducing a title (M2). The separator and what follows it are both
#: load-bearing: `27.5 16x16` is a table row and `M = I + ...` is an equation, and the old
#: pattern -- optional separator, any following character -- called both of them headings.
#: Across 25 real documents this drops 196 such false headings (190 of them maths or table
#: cells that now group with their equation and reach mathspeak) and picks up 5 real
#: appendix headings, at the cost of one genuine `5.3.1. 3D Consistency`-shaped miss.
_NUMBERED_HEADING_RE = re.compile(
    r"^(?:"
    r"\d+(?:\.\d+)*[.)]\s+[A-Za-z0-9]"    # "5.3.1. 3D Consistency"
    r"|\d+(?:\.\d+)*\s+[A-Za-z]"          # "3.1 Method"
    r"|[IVXLCDM]+[.)]\s+[A-Za-z]"          # "D. Inference" -- the separator is required
    r")"
)
_EQ_NUMBER_RE = re.compile(r"\(\d+[a-z]?\)\s*$")
_SENTENCE_END_RE = re.compile(r"[.?!][\"”’)]?$")
# A word, not a glyph or an index: 3+ letters. Shared with pipeline's heading floor.
WORD_RE = re.compile(r"[^\W\d_]{3,}")
_BULLET_RE = re.compile(r"^[•◦▪‣∙–]\s")
_URL_RE = re.compile(r"https?://\S+")
# Byline noise that is not a word: affiliation marks ("^1", "^2,1", a bare "1") and URLs.
_BYLINE_MARK_RE = re.compile(rf"\^\S+|(?<!\S)\d{{1,2}}(?!\S)|{_URL_RE.pattern}")
# A name or word: 2+ letters, joined by hyphens or accents ("Mart´ın-Mart´ın"), then punctuation.
_NAME_WORD_RE = re.compile(r"[^\W\d_]{2,}(?:[-'’´][^\W\d_]+)*[,.;:]?")


#: An appendix ends the bibliography; papers routinely put one after the references.
_APPENDIX_RE = re.compile(
    r"^(appendix|appendices|supplement(ary|al)?(\s+material)?)\b[\s:.]*", re.I)


@dataclass(frozen=True)
class _Tag:
    kind: str
    reason: str
    group: int


@dataclass(frozen=True)
class _Ctx:
    geom: PageGeometry
    stats: DocStats
    page_font: str
    col_width: float
    line_gap: float
    left_margin: float
    right_edge: float
    in_back_half: bool

    @staticmethod
    def build(geom: PageGeometry, stats: DocStats) -> "_Ctx":
        lines = geom.lines
        widths = [ln.width for ln in lines if ln.width > 0]
        return _Ctx(
            geom=geom, stats=stats, page_font=_dominant_font(lines),
            col_width=max(widths) if widths else geom.width,
            line_gap=page_line_gap(geom, stats),
            left_margin=min((ln.x0 for ln in lines), default=0.0),
            right_edge=max((ln.x1 for ln in lines), default=geom.width),
            in_back_half=geom.page * 2 >= stats.num_pages,
        )


def page_line_gap(geom: PageGeometry, stats: DocStats) -> float:
    """The page's usual baseline-to-baseline step: how far down the next line of text sits."""
    gaps = [b.y - a.y for a, b in zip(geom.lines, geom.lines[1:]) if b.y > a.y]
    return median(gaps) if gaps else stats.body_size * 1.2


@dataclass(frozen=True)
class _Tagger:
    """Scratch space for one page: which rule claimed which line."""
    lines: tuple[Line, ...]
    ctx: _Ctx
    tags: list[_Tag | None]
    groups: Iterator[int]

    def free(self, i: int) -> bool:
        return self.tags[i] is None

    def untagged(self) -> list[int]:
        return [i for i in range(len(self.lines)) if self.free(i)]

    def mark(self, indices: Iterable[int], kind: str, reason: str) -> None:
        group = next(self.groups)
        for i in indices:
            self.tags[i] = _Tag(kind=kind, reason=reason, group=group)


def _dominant_font(lines: Sequence[Line]) -> str:
    weight = Counter()
    for line in lines:
        if line.font:
            weight[line.font] += len(line.text.strip())
    return weight.most_common(1)[0][0] if weight else ""


def classify_page(geom: PageGeometry, stats: DocStats) -> tuple[Block, ...]:
    """Group a page's lines into typed blocks. Pure; no I/O."""
    if not geom.lines:
        return ()
    ctx = _Ctx.build(geom, stats)
    tagger = _Tagger(geom.lines, ctx, [None] * len(geom.lines), count())
    for rule in (_tag_furniture, _tag_references, _tag_footnotes, _tag_captions,
                 _tag_tables, _tag_code, _tag_figures, _tag_sideways, _tag_headings,
                 _tag_equations):
        rule(tagger)
    return _group_blocks(tagger)


def _tag_furniture(t: _Tagger) -> None:
    height = t.ctx.geom.height
    for i, line in enumerate(t.lines):
        if tag := furniture_tag(line, t.lines, height, t.ctx.stats):
            t.mark([i], *tag)


def _tag_references(t: _Tagger) -> None:
    if _in_bibliography(t):
        t.mark(_bibliography_lines(t), "reference", "bibliography section")
        return
    if not t.ctx.in_back_half:
        return
    for i in t.untagged():
        if _CITATION_LINE_RE.match(t.lines[i].text.strip()):
            t.mark([i], "reference", "numbered citation entry")


def _in_bibliography(t: _Tagger) -> bool:
    """Is any part of this page inside the bibliography span?"""
    stats = t.ctx.stats
    page = t.ctx.geom.page
    if stats.reference_page is None or page < stats.reference_page:
        return False
    end = stats.reference_end_page
    return end is None or page <= end


def _bibliography_lines(t: _Tagger) -> list[int]:
    """The untagged lines this page contributes to the bibliography.

    Bounded at both ends. A two-column paper starts its references mid-page, so the
    conclusion above them must survive; and an appendix after the references is not part
    of them, so everything below its heading must survive too. The start is the heading's
    place in reading order: a heading at a left-column foot is followed by a right column
    that sits higher on the page (U17b). Its baseline is the fallback.
    """
    stats = t.ctx.stats
    page = t.ctx.geom.page
    lines = t.lines

    lo = start = None
    if page == stats.reference_page and stats.reference_y is not None:
        start = _reference_heading_index(lines, stats.reference_y)
        lo = stats.reference_y if start is None else None
    hi = None
    if stats.reference_end_page is not None and page == stats.reference_end_page:
        hi = next((ln.y for ln in lines if _APPENDIX_RE.match(ln.text.strip())), None)
        if hi is None:
            return []

    return [
        i for i in t.untagged()
        if (start is None or i >= start) and (lo is None or lines[i].y >= lo)
        and (hi is None or lines[i].y < hi)
    ]


def _reference_heading_index(lines: Sequence[Line], y: float) -> int | None:
    return next((i for i, ln in enumerate(lines)
                 if abs(ln.y - y) <= REF_HEADING_Y_TOL
                 and REF_HEADING_RE.fullmatch(ln.text.strip())), None)


def _tag_footnotes(t: _Tagger) -> None:
    limit = t.ctx.geom.height * (1.0 - config.FOOTNOTE_BAND)
    max_size = t.ctx.stats.body_size * config.FOOTNOTE_SIZE_RATIO
    small = [i for i in t.untagged()
             if t.lines[i].y >= limit and 0 < t.lines[i].size <= max_size]
    for run in _runs(small, 1):
        first = next((k for k, i in enumerate(run) if _starts_footnote(t.lines[i])), None)
        if first is None:
            unmarked = _unmarked_note(t, run)
            if unmarked:
                t.mark(unmarked, "footnote", "small type set off at the foot of the page")
            continue
        note = run[first:]
        t.mark(note[:_caption_break(t, note)], "footnote", "marked note at the foot of the page")


def _unmarked_note(t: _Tagger, run: Sequence[int]) -> list[int]:
    """The tail of `run` that is an affiliation or correspondence block, if any.

    Not every note carries a marker. PiZero.pdf p1 ends "Physical Intelligence, San
    Francisco, California, USA. Correspondance to: research@..." with no symbol and no
    superscript, appears on no other page, and so is missed by `_starts_footnote` and by
    both furniture rules alike -- and is read out in full.

    What distinguishes it is not its text but the whitespace above it: a note is pushed
    away from the body by more than a line break, set smaller than the text it follows,
    and runs to the bottom of the page. The candidate band alone is far too wide to act
    on -- an abstract set at 0.90 body sits inside it -- so the split is found by walking
    back to the *last* such break, never by taking the run whole.

    "Bottom of the page" is measured, not read off reading order (J8): column ordering
    reads PiZero p1's whole right column after the note that closes the left one. Nothing
    may sit lower on the page, whatever its column -- a running footer or page number
    below is what keeps a section heading stranded at a column foot (VLALitReview p16
    `VI. DATASETS`) in the voice.
    """
    lines = t.lines
    foot = max((ln.y for ln in lines if ln.text.strip()), default=None)
    if lines[run[-1]].y != foot:
        return []
    starts = [k for k, i in enumerate(run) if _opens_unmarked_note(lines, i)]
    if not starts:
        return []
    note = run[starts[-1]:]
    if len(note) > MAX_UNMARKED_NOTE_LINES or _CAPTION_RE.match(lines[note[0]].text.strip()):
        return []
    return note[:_caption_break(t, note)]


def _opens_unmarked_note(lines: Sequence[Line], i: int) -> bool:
    """Is line `i` pushed off the bottom of the text block above it?

    Measured against the *local* leading -- the gap between the two lines immediately
    above -- not the page median, which a sparse page or a figure's stacked labels
    distorts beyond use. Both bounds carry their weight: below the lower one this is
    just the next line of the paragraph, and above the upper one the small type is a
    separate element adrift on the page (a caption under a figure, a boxed aside), not
    a note hanging off the text.
    """
    if i < 2 or lines[i].size >= lines[i - 1].size:
        return False
    leading = lines[i - 1].y - lines[i - 2].y
    if leading <= 0:
        return False
    return NOTE_GAP_MIN <= (lines[i].y - lines[i - 1].y) / leading <= NOTE_GAP_MAX


def _starts_footnote(line: Line) -> bool:
    """Does this line open a footnote?

    A real marker is typographically distinct: either a symbol prose never begins with,
    or a digit set as a superscript. A bare digit at the line's own size is a number in
    the text — `0 50 100 150 200` on an axis, `30 100 300` under a plot — and accepting
    one deletes every line below it: mml-book.pdf p330 lost 48 words of figure caption
    exactly that way. Requiring the superscript is also what finally catches the arXiv
    style, where the marker is glued to the first word (`3Unless otherwise specified`).
    """
    text = line.text.lstrip()
    if not text:
        return False
    if _FOOTNOTE_SYMBOL_RE.match(text):
        return True
    match = _FOOTNOTE_DIGIT_RE.match(text)
    return match is not None and _is_superscript(line, match.group(0).strip())


def _is_superscript(line: Line, marker: str) -> bool:
    """True when the line's first item is exactly `marker`, set smaller than the line."""
    first = next((k for k, txt in enumerate(line.item_text) if txt.strip()), None)
    if first is None or line.item_text[first].strip() != marker:
        return False
    size = line.item_size[first] if first < len(line.item_size) else line.size
    return 0 < size <= line.size * config.FOOTNOTE_MARKER_SIZE_RATIO


def _caption_break(t: _Tagger, note: Sequence[int]) -> int:
    """How far the footnote run extends before a caption starts.

    Footnotes and captions share the bottom band and the same small type, and this rule
    runs before `_tag_captions`; without the break a footnote swallows the figure caption
    printed underneath it (VJEPA_2.pdf p5).
    """
    return next((k for k, i in enumerate(note[1:], 1)
                 if _CAPTION_RE.match(t.lines[i].text.strip())), len(note))


def _tag_captions(t: _Tagger) -> None:
    for i in t.untagged():
        if t.free(i) and _CAPTION_RE.match(t.lines[i].text.strip()):
            t.mark([i, *_caption_continuation(t, i)], "caption", "figure/table caption")


def _caption_continuation(t: _Tagger, start: int) -> list[int]:
    """Wrapped caption lines: by type when it is distinct, else by block (see `capwrap`)."""
    head = t.lines[start]
    def joinable(j: int) -> bool:
        return t.free(j) and not _CAPTION_RE.match(t.lines[j].text.strip())
    if head.turned:
        return _turned_caption_rest(t, start, joinable)
    if head.size >= t.ctx.stats.body_size - CAPTION_SIZE_TOL:
        return capwrap.caption_rest(t.lines, start, joinable)
    run: list[int] = []
    for j in range(start + 1, len(t.lines)):
        line = t.lines[j]
        if not joinable(j):
            break
        if abs(line.size - head.size) > CAPTION_SIZE_TOL:
            break
        if abs(line.x0 - head.x0) > CAPTION_INDENT_TOL or looks_tabular(line):
            break
        run.append(j)
    return run


def _turned_caption_rest(t: _Tagger, start: int, joinable: Callable[[int], bool]) -> list[int]:
    """A turned caption wraps across the page: each line one pitch from the last, in its type.

    A turned line's x0 is its baseline, so the pitch is the step in x0; the rest of the same
    turned line, clustered apart by its top, steps zero. The figure's own turned labels
    follow in smaller type or further off, and stay for `_tag_sideways`.
    """
    head, run = t.lines[start], []
    for j in range(start + 1, len(t.lines)):
        line, prev = t.lines[j], t.lines[run[-1] if run else start]
        if not (line.turned and joinable(j)) or abs(line.size - head.size) > CAPTION_SIZE_TOL:
            break
        if abs(line.x0 - prev.x0) > TURNED_PITCH_EMS * head.size:
            break
        run.append(j)
    return run


def _tag_figures(t: _Tagger) -> None:
    """Text printed inside a figure, walked out from each caption (see `figwalk`)."""
    groups: dict[int, list[int]] = {}
    for i, tag in enumerate(t.tags):
        if tag is not None and tag.kind == "caption":
            groups.setdefault(tag.group, []).append(i)
    kinds = tuple(tag.kind if tag else None for tag in t.tags)
    headings = frozenset(i for i in t.untagged() if _heading_at(t, i))
    for region in figwalk.figure_regions(t.lines, kinds, groups.values(),
                                         body_size=t.ctx.stats.body_size,
                                         line_gap=t.ctx.line_gap, headings=headings):
        t.mark(region, "figure", "text printed inside a figure")


def _tag_tables(t: _Tagger) -> None:
    candidates = [i for i in t.untagged() if looks_tabular(t.lines[i])]
    for run in _runs(candidates, MIN_TABLE_RUN):
        rows = [t.lines[i] for i in run]
        columns = shared_columns(rows)
        if len(columns) >= MIN_TABLE_COLUMNS:
            t.mark(run, "table",
                   f"{len(columns)} aligned columns across {len(run)} lines")
        elif all(numeric_dominant(row) for row in rows):
            t.mark(run, "table", f"numeric grid of {len(run)} lines")


def _tag_code(t: _Tagger) -> None:
    mono = [i for i in t.untagged() if _has_hint(t.lines[i].font, MONO_FONT_HINTS)]
    for run in _runs(mono, MIN_CODE_RUN):
        t.mark(run, "code", "monospaced font run")


def _has_hint(font: str, hints: Sequence[str]) -> bool:
    return any(hint in font.lower() for hint in hints)


def _tag_sideways(t: _Tagger) -> None:
    """Text turned 90° on an upright page is a figure's axis or row label.

    PSI_Paper.pdf p28 set its row labels "Factual", "Hypothetical" at 14.7pt, and size alone
    made them headings. The margin stamp is furniture already. On a page that is itself
    turned (a landscape table or appendix) the turned lines are the page's text. Blank lines
    and the page's own furniture (running head, number, margin stamp) hold no orientation.
    """
    text = [line for line, tag in zip(t.lines, t.tags) if line.text.strip()
            and not (tag and tag.kind in figwalk.OVERLAY_KINDS)]
    if sum(line.turned for line in text) > ROTATED_PAGE_FRACTION * len(text):
        return
    for run in _runs([i for i in t.untagged() if t.lines[i].turned], 1):
        t.mark(run, "figure", "sideways text: a figure label")


def _tag_headings(t: _Tagger) -> None:
    hits = [i for i in t.untagged() if _heading_at(t, i)]
    for run in headwrap.heading_runs(t.lines, hits, t.untagged()):
        t.mark(run, "heading", "short emphasised section title")


def _heading_at(t: _Tagger, i: int) -> bool:
    return _is_heading(t.lines[i], t.ctx, t.lines[i + 1] if i + 1 < len(t.lines) else None)


def _is_heading(line: Line, ctx: _Ctx, nxt: Line | None = None) -> bool:
    text = line.text.strip()
    if not text or len(text) >= MAX_HEADING_CHARS or text.endswith("."):
        return False
    if not any(c.isalpha() for c in text):
        return False
    if line.size >= ctx.stats.body_size * config.HEADING_SIZE_RATIO:
        return True
    if _has_hint(line.font, BOLD_FONT_HINTS):
        return True
    if headshape.is_small_caps(line) or headshape.is_run_in_title(line, nxt, ctx.col_width):
        return True
    shaped = bool(_NUMBERED_HEADING_RE.match(text)) or (
        text.isupper() and len(text) < MAX_CAPS_HEADING_CHARS)
    return shaped and line.font != ctx.page_font


def _tag_equations(t: _Tagger) -> None:
    hits = [i for i in t.untagged()
            if _is_equation(t.lines[i], t.lines[i - 1] if i else None, t.ctx)]
    for run in _runs(hits, 1):
        t.mark(run, "equation", "display math")


def _is_equation(line: Line, above: Line | None, ctx: _Ctx) -> bool:
    text = line.text.strip()
    if not text or (ctx.geom.page == TITLE_PAGE and _is_byline(text)):
        return False
    if (_is_centred(line, ctx) and not _is_ragged_line(line, above, ctx)
            and not _reads_as_prose(text)):
        return True
    if _EQ_NUMBER_RE.search(text) and line.x1 >= ctx.right_edge - RIGHT_FLUSH_TOL:
        return True
    if _ends_wrapped_sentence(line, above, ctx):
        return False
    return looks_like_equation(text) or math_density(text) >= EQUATION_MATH_DENSITY


def _ends_wrapped_sentence(line: Line, above: Line | None, ctx: _Ctx) -> bool:
    """The last words of a sentence run onto a short flush-left line, notation and all (N14).

    thinkstats p84 ends "...has to be less than" / "z − x."; once its minus was decoded
    the short line was dense enough to read as math, and the sentence lost its end. A
    line above that is itself math keeps its tail ("V(X) =" / "μ.").
    """
    return (above is not None and _is_ragged_line(line, above, ctx)
            and bool(_SENTENCE_END_RE.search(line.text.strip()))
            and not _SENTENCE_END_RE.search(above.text.strip())
            and not _is_equation(above, None, ctx))


def _reads_as_prose(text: str) -> bool:
    """A centred sentence, or a run of words with no notation, is set prose (N3, U17d).

    Position alone read an inset abstract and a short bullet near the page centre as
    display math, which also cut their sentences at every line it took.
    """
    return reads_as_sentence(text) or (
        math_density(text) == 0 and len(WORD_RE.findall(text)) >= MIN_PROSE_WORDS)


def _is_byline(text: str) -> bool:
    """Only names and words once affiliation marks and URLs are gone: not math (N3).

    Position read a centred author block as display math, and its "^1" marks alone
    carried `math_density` past the threshold.
    """
    words = _BYLINE_MARK_RE.sub(" ", text).split()
    if not words:
        return bool(_URL_RE.search(text))
    return math_density(" ".join(words)) == 0 and all(_NAME_WORD_RE.fullmatch(w) for w in words)


def _is_centred(line: Line, ctx: _Ctx) -> bool:
    if line.width <= 0 or line.width >= ctx.col_width * EQUATION_WIDTH_RATIO:
        return False
    centre = (line.x0 + line.x1) / 2.0
    return abs(centre - ctx.geom.width / 2.0) <= ctx.geom.width * EQUATION_CENTRE_TOL


def _is_ragged_line(line: Line, above: Line | None, ctx: _Ctx) -> bool:
    """A short line flush-left under a wider one is prose running out, not centred math.

    `_is_centred` measures against the page centre with a wide tolerance, so a paragraph's
    last line that happens to end near the middle of the page passed it, and the sentence
    was read as two chunks either side of an "equation" (T2). On the 11-paper corpus,
    body sentences cut off before an equation that continues them fell from 290 to 104.
    A centred display equation is inset from the prose above it; this line is not, unless
    the line above is itself centred (an inset abstract keeps its ragged last line).
    """
    return (above is not None
            and not _is_centred(above, ctx)
            and abs(line.x0 - above.x0) <= COLUMN_TOL
            and above.x1 - line.x1 > RIGHT_FLUSH_TOL
            and 0 < line.y - above.y <= PARA_GAP_RATIO * ctx.line_gap)


def _group_blocks(t: _Tagger) -> tuple[Block, ...]:
    page, blocks, i = t.ctx.geom.page, [], 0
    while i < len(t.lines):
        tag = t.tags[i]
        if tag is None:
            end = _paragraph_end(t, i)
            blocks.append(_make_block("body", t.lines[i:end], page, "prose"))
        else:
            end = i + 1
            while end < len(t.lines) and _in_group(t.tags, end, tag.group):
                end += 1
            blocks.append(_make_block(tag.kind, t.lines[i:end], page, tag.reason))
        i = end
    return tuple(blocks)


def _paragraph_end(t: _Tagger, start: int) -> int:
    end = start
    while end < len(t.lines) and t.free(end):
        current = t.lines[end]
        end += 1
        nxt = t.lines[end] if end < len(t.lines) and t.free(end) else None
        if nxt is None or _breaks_paragraph(current, nxt, t.ctx):
            break
    return end


def _breaks_paragraph(current: Line, nxt: Line, ctx: _Ctx) -> bool:
    if nxt.y - current.y > PARA_GAP_RATIO * ctx.line_gap:
        return True
    if (current.x0 > nxt.x1 and current.size < nxt.size  # a figure label beside the line
            and nxt.y - current.y < BESIDE_GAP_RATIO * ctx.line_gap):
        return True
    if (nxt.x0 > current.x0 + PARA_INDENT_MIN
            and nxt.x0 > ctx.left_margin + PARA_INDENT_MIN
            and not _hangs_from_bullet(current, nxt)):
        return True
    finished = current.text.rstrip().endswith((".", "?", "!"))
    return finished and current.width < ctx.col_width * SHORT_LAST_LINE_RATIO


def _hangs_from_bullet(current: Line, nxt: Line) -> bool:
    """`nxt` is the hanging-indent second line of the list item `current` opens (U17e)."""
    return (_BULLET_RE.match(current.text.strip()) is not None
            and nxt.x0 - current.x0 <= LIST_HANG_MAX_EMS * current.size)


def _make_block(kind: str, lines: Sequence[Line], page: int, reason: str) -> Block:
    return Block(
        kind=kind, page=page, reason=reason, items=flatten_items(lines),
        text=" ".join(ln.text.strip() for ln in lines if ln.text.strip()),
        line_ids=tuple(ln.idx for ln in lines),
    )


def _runs(indices: Sequence[int], minimum: int) -> Iterator[list[int]]:
    run: list[int] = []
    for i in indices:
        if run and i == run[-1] + 1:
            run.append(i)
            continue
        if len(run) >= minimum:
            yield run
        run = [i]
    if len(run) >= minimum:
        yield run


def _in_group(tags: Sequence[_Tag | None], i: int, group: int) -> bool:
    return tags[i] is not None and tags[i].group == group  # type: ignore[union-attr]

