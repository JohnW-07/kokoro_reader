"""Linearise a display equation set in two dimensions (N14).

pdf.js reports a display equation's limits, numerators and exponents as lines of their
own: `1` above `μ = n ∑x _i`, and `i` below it. Read top to bottom that is "1 mu equals n,
sum, x sub i, i". Here each small satellite line is put back against the main-line glyph it
sits over, as the notation `mathspeak` already reads:

    under or over a big operator    -> its limits        ∑_{i}
    centred over or under a glyph   -> a fraction        \\frac{1}{n}
    beside a glyph, above or below  -> a script          s^{2}

Display style sets a numerator at text size and a script smaller, which is what tells
`1` over `n` from the `τ` over `A_t`. Anything this cannot place with that confidence --
a bracket piece, a table cell, a line with no relation or big operator -- returns None,
and the caller keeps the block's own text. The result is only ever spoken; `Block.text`
and the highlight mapping are untouched. Pure.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Sequence

from .types import Line

BIG_OPERATORS = frozenset("∑∏∐∫∬∭∮⋃⋂⋁⋀⨁⨂")
#: A limit or numerator sits within this many ems of its line (thinkstats: 1.04); a
#: second row of the equation, or the prose after it, is a full line step (~1.18 em) away.
SATELLITE_MAX_GAP_EMS = 1.1
#: A satellite is a few glyphs: `i`, `i=1`, `2 1 2`; a longer line is a row of its own.
SATELLITE_MAX_CHARS = 8
#: A satellite never reaches more than this far past the ends of its main line.
SATELLITE_OVERHANG_EMS = 1.0
#: Advance of a glyph whose item has no follower to measure against, in ems.
GLYPH_ADVANCE_EMS = 0.5
#: A numerator is set at text size; a script or limit at ~0.7 of it.
FRACTION_SIZE_RATIO = 0.9
SCRIPT_SIZE_RATIO = 0.85
#: A script sits right after its base: its centre within this many ems of the base's end.
SCRIPT_REACH_EMS = 0.75
#: The main line of a display equation relates or sums something.
_RELATION_CHARS = frozenset("=<>≤≥≈≡≠∝∼≃") | BIG_OPERATORS
#: What a limit, numerator or script is made of; a bracket piece or rule is not placed.
_OPERAND_RE = re.compile(r"[\w′'+\-−=*,.]+")

#: The client prefixes a glyph off its line's baseline with `_` or `^`; on a satellite
#: line its role comes from where it sits instead.
_CLIENT_SCRIPT_MARKS = "_^"
_WS_RE = re.compile(r"\s+")
#: A spacing accent set over a glyph marks it (`b` hat), it is not a numerator.
_ACCENTS = frozenset("ˆ¯˜˙")


@dataclass(frozen=True)
class _Token:
    x0: float
    x1: float
    text: str


@dataclass(frozen=True)
class _Mark:
    token: int
    role: str      # "lo"/"hi" limit, "num"/"den" fraction part, "sup"/"sub" script, "acc" accent
    x: float
    text: str


def linearize(lines: Sequence[Line]) -> str | None:
    """The equation as one line of TeX-ish notation, or None when there is nothing to place."""
    if len(lines) < 2:
        return None
    hosts = {ln.idx: _host(ln, lines) for ln in lines}
    mains = [ln for ln in lines if hosts[ln.idx] is None]
    satellites = [ln for ln in lines if hosts[ln.idx] is not None]
    if not satellites or any(hosts[s.idx] not in mains for s in satellites):
        return None
    rendered = []
    for main in sorted(mains, key=lambda ln: ln.y):
        own = [s for s in satellites if hosts[s.idx] is main]
        marks = _place(main, own) if own else []
        if marks is None:
            return None
        rendered.append(_render(_tokens(main), marks))
    return _WS_RE.sub(" ", " ".join(rendered)).strip()


def _em(line: Line) -> float:
    """The line's text size: its largest glyph short of a big operator.

    Not the median: a loss whose terms are mostly subscripted (PiZero p5) has a median at
    script size, and the script-sized marks over it then passed as numerators.
    """
    sizes = [s for t, s in zip(line.item_text, line.item_size)
             if t.strip() and t.strip() not in BIG_OPERATORS and s > 0]
    return max(sizes, default=line.size)


def _glyphs(line: Line) -> list[tuple[float, str, float]]:
    return [(x, t.strip(), s) for x, t, s in zip(line.item_x, line.item_text, line.item_size)
            if t.strip()]


def _host(line: Line, lines: Sequence[Line]) -> Line | None:
    """The nearest line `line` could be a limit, numerator or script of."""
    glyphs = _glyphs(line)
    if not glyphs or sum(len(t) for _, t, _ in glyphs) > SATELLITE_MAX_CHARS:
        return None
    candidates = [m for m in lines if m is not line and len(_glyphs(m)) > len(glyphs)
                  and abs(line.y - m.y) <= SATELLITE_MAX_GAP_EMS * _em(m)
                  and line.x0 >= m.x0 - SATELLITE_OVERHANG_EMS * _em(m)
                  and line.x1 <= m.x1 + SATELLITE_OVERHANG_EMS * _em(m)]
    return min(candidates, key=lambda m: abs(line.y - m.y), default=None)


def _tokens(line: Line) -> list[_Token]:
    """Each item with the x extent it covers: up to the next item, or one glyph's advance."""
    xs, texts = line.item_x, line.item_text
    return [_Token(x, xs[k + 1] if k + 1 < len(xs)
                   else max(line.x1, x + GLYPH_ADVANCE_EMS * _em(line) * len(t)), t)
            for k, (x, t) in enumerate(zip(xs, texts))]


def _place(main: Line, satellites: Sequence[Line]) -> list[_Mark] | None:
    if not _RELATION_CHARS & set(main.text):
        return None
    tokens, em = _tokens(main), _em(main)
    marks = []
    for sat in satellites:
        for x, marked, size in _glyphs(sat):
            text = marked.lstrip(_CLIENT_SCRIPT_MARKS) or marked
            centre = x + GLYPH_ADVANCE_EMS * size * len(text) / 2
            mark = _mark(tokens, centre, sat.y < main.y, text, size, em)
            if mark is None or not _OPERAND_RE.fullmatch(text):
                return None
            marks.append(mark)
    return marks


def _mark(tokens: Sequence[_Token], centre: float, above: bool, text: str,
          size: float, em: float) -> _Mark | None:
    """Where one satellite glyph goes, judged by what it sits over and its relative size."""
    under = next((k for k, tok in enumerate(tokens) if tok.x0 <= centre < tok.x1), None)
    if under is not None and tokens[under].text.strip() in BIG_OPERATORS:
        return _Mark(under, "hi" if above else "lo", centre, text)
    if under is not None and tokens[under].text.strip():
        if above and text in _ACCENTS:
            return _Mark(under, "acc", centre, text)
        if size < FRACTION_SIZE_RATIO * em:
            return None
        return _Mark(under, "num" if above else "den", centre, text)
    before = [k for k, tok in enumerate(tokens) if tok.text.strip() and tok.x0 < centre]
    if (not before or size > SCRIPT_SIZE_RATIO * em
            or centre - tokens[before[-1]].x1 > SCRIPT_REACH_EMS * em):
        return None
    return _Mark(before[-1], "sup" if above else "sub", centre, text)


def _render(tokens: Sequence[_Token], marks: Sequence[_Mark]) -> str:
    def part(k: int, role: str) -> str:
        return "".join(m.text for m in sorted(marks, key=lambda m: m.x)
                       if m.token == k and m.role == role)

    out = []
    for k, tok in enumerate(tokens):
        num, den, base = part(k, "num"), part(k, "den"), tok.text + part(k, "acc")
        if num or den:
            base = rf"\frac{{{num or base}}}{{{den or base}}}"
            if _next_glyph(tokens, k) in BIG_OPERATORS:
                base += ","  # "1 over n, the sum over i": the pause the fraction ends on
        for role, sign in (("lo", "_"), ("hi", "^"), ("sub", "_"), ("sup", "^")):
            if script := part(k, role):
                base += f"{sign}{{{script}}}"
        out.append(base + (" " if tok.text.strip() in BIG_OPERATORS else ""))
    return "".join(out)


def _next_glyph(tokens: Sequence[_Token], k: int) -> str:
    return next((tok.text.strip() for tok in tokens[k + 1:] if tok.text.strip()), "")
