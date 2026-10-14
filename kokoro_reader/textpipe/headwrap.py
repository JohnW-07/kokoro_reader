"""Group heading lines so a heading wrapped over several lines is one heading (U12).

The classifier tags headings line by line, so GR00TN1.pdf's two-line title became two
headings: the voice stopped after "...for Generalist." and the notes' section view grew
a bogus "Humanoid Robots" section. A wrapped heading keeps its font and size, sits one of
its own line steps below, and is set to the same edge (flush left), the same axis
(centred), or under the text after its number (a hanging indent). Each of those tests is
what keeps something apart: the author line under a title is smaller; figure labels that
happen to be large are not aligned; two separate headings are further apart; and a
subsection under its section, or the next entry of a table of contents, opens with its
own number.

The rest of a wrapped heading need not look like a heading on its own: VLAW's "5.2. Can
we learn an accurate action-conditioned world" / "model for contact-rich tasks?" is set
at the body size in a font with no bold hint, so only the numbered first line is one. Such
a line joins only when it cannot be anything else -- it starts in lower case, so it opens
no heading and no paragraph, and the line above it has not ended its sentence.

Pure functions over the caller's lines; nothing is mutated.
"""

from __future__ import annotations

import re
from typing import Iterator, Sequence

from .types import Line

SIZE_TOL = 0.4      # pt: a wrapped line keeps its heading's size...
WRAP_EMS = 1.5      # ...sits at most this many ems below it...
ALIGN_TOL = 4.0     # ...and starts, or centres, within this many pt of it
MAX_REST_CHARS = 90  # the rest of a heading is heading-length (classify.MAX_HEADING_CHARS)

#: The number a heading opens with, and the space after it: "5.2. ", "3.1 ", "III. ",
#: "A. ", "A.1 ". Wider than `classify._NUMBERED_HEADING_RE`, which decides what IS a
#: heading and so must not match "A" the article; this only decides where one ends, and
#: a lettered subsection under its section ("III. METHOD" / "A. Problem Setup") is the
#: case it exists for. A bare number is one or two digits: a title that wraps onto
#: "1000 Tasks and Beyond" is still one title.
SECTION_NUMBER_RE = re.compile(
    r"^(?:\d{1,2}(?:\.\d+)*[.)]?|[A-Z](?:\.\d+)+[.)]?|[A-Z][.)]|[IVXLCDM]+[.)])\s+(?=\S)")
_SENTENCE_END = (".", "?", "!")


def heading_runs(
    lines: Sequence[Line], hits: Sequence[int], free: Sequence[int]
) -> Iterator[list[int]]:
    """`hits` (indices of heading lines, ascending) grouped into one run per heading.

    A run grows one adjacent line at a time: another hit that `wraps_into` it, or a line
    in `free` (not yet claimed by any rule) that `rest_of` says finishes it.
    """
    is_hit, spare = frozenset(hits), frozenset(free) - frozenset(hits)
    end = -1
    for first in hits:
        if first <= end:
            continue
        run = [first]
        while _joins(lines, run[-1] + 1, is_hit, spare):
            run = [*run, run[-1] + 1]
        end = run[-1]
        yield run


def _joins(lines: Sequence[Line], i: int, is_hit: frozenset[int], spare: frozenset[int]) -> bool:
    if i in is_hit:
        return wraps_into(lines[i - 1], lines[i])
    return i in spare and rest_of(lines[i - 1], lines[i])


def wraps_into(upper: Line, lower: Line) -> bool:
    """Is heading line `lower` the rest of heading line `upper`, set on the next line?"""
    return _set_as_one(upper, lower) and not SECTION_NUMBER_RE.match(lower.text.strip())


def rest_of(upper: Line, lower: Line) -> bool:
    """Is `lower`, no heading on its own, the end of the heading `upper` wraps from?"""
    text = lower.text.strip()
    return (_set_as_one(upper, lower)
            and text[:1].islower()
            and len(text) < MAX_REST_CHARS
            and not text.endswith("."))


def _set_as_one(upper: Line, lower: Line) -> bool:
    step = lower.y - upper.y
    return (lower.font == upper.font
            and abs(lower.size - upper.size) <= SIZE_TOL
            and 0 < step <= WRAP_EMS * upper.size
            and not upper.text.strip().endswith(_SENTENCE_END)
            and _aligned(upper, lower))


def _aligned(upper: Line, lower: Line) -> bool:
    same_edge = abs(lower.x0 - upper.x0) <= ALIGN_TOL
    same_axis = abs((lower.x0 + lower.x1) - (upper.x0 + upper.x1)) / 2.0 <= ALIGN_TOL
    return same_edge or same_axis or _hangs_under_text(upper, lower)


def _hangs_under_text(upper: Line, lower: Line) -> bool:
    """`lower` starts right of `upper`'s number and no further in than its text does.

    The text's x is estimated from the number's share of the characters, which runs wide
    (digits are narrow), so the test is a range and not a match: VLAW's "5.3. " estimates
    78.6pt against a real 72.9pt.
    """
    text = upper.text.strip()
    number = SECTION_NUMBER_RE.match(text)
    if not number or upper.width <= 0:
        return False
    text_x = upper.x0 + upper.width * number.end() / len(text)
    return upper.x0 + ALIGN_TOL < lower.x0 <= text_x + ALIGN_TOL
