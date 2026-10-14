"""The rest of a caption set in the body's own type (U16).

A caption in small type is followed line by line on its size alone. One set at the body's
size cannot be: its wrapped lines look exactly like the prose after it, so the classifier
used to stop at the caption's first line and hand the rest to the body. PiZero.pdf p4
then read "Fig. 3: ... both our own dexterous" as a caption and "manipulation datasets and
open-source data." as a paragraph of its own; GR00TN1.pdf p7 did the same to `Figure 5:`.

What still sets such a caption apart is its block: every wrapped line starts at the
caption's edge, runs its full measure, and sits one line step below the last, until a
short line ends the paragraph. Prose after it is a paragraph away, or set in a column that
stops short of a caption spanning both.

Pure functions over the caller's lines; nothing is mutated.
"""

from __future__ import annotations

import re
from typing import Callable, Sequence

from .types import Line

SIZE_TOL = 0.4    # pt: a wrapped line keeps the caption's size...
EDGE_TOL = 8.0    # ...starts and ends within this of the caption's edges (a full line)...
WRAP_EMS = 1.5    # ...and sits at most this many ems below the line before it

#: A caption names its figure and then punctuates or titles it ("Fig. 3:", "Figure 10.",
#: "Algorithm 1 RL ..."). A line that runs on in lower case is prose that matched the
#: caption pattern: "Figure 14 shows examples ..." (VJEPA_2.pdf p37), "Table 4 and Table 5
#: present ..." (GR00TN1.pdf p20), "Figure 4 (Left) compares ..." (VJEPA_2.pdf p6), or
#: "algorithmic and an ..." (Cosmos p7, read as "algorithm ic"). Following it would call
#: the whole paragraph a caption.
_PROSE_RE = re.compile(r"^(?:[a-z]|\w+\.?\s*\w+\s+[a-z(])")


def caption_rest(lines: Sequence[Line], start: int, joinable: Callable[[int], bool]) -> list[int]:
    """Indices after `start` that finish the caption opened by `lines[start]`.

    `joinable(j)` says whether line `j` is still free to join (not claimed, not a caption
    of its own). The run ends after the first line that stops short of the caption's
    right edge -- a paragraph's last line -- and never extends past a short head. A head
    that is itself the next line of a paragraph opens no caption block at all: VJEPA_2.pdf
    p13 wraps a sentence onto "Figure 10. Start and goal frames for all ...", and following
    it would call the rest of that paragraph a caption.
    """
    head = lines[start]
    if _PROSE_RE.match(head.text.strip()):
        return []
    if start > 0 and _runs_full(head, lines[start - 1]) and _wraps(head, lines[start - 1], head):
        return []
    run: list[int] = []
    upper = head
    for j in range(start + 1, len(lines)):
        if not _runs_full(head, upper) or not joinable(j) or not _wraps(head, upper, lines[j]):
            break
        run = [*run, j]
        upper = lines[j]
    return run


def _runs_full(head: Line, line: Line) -> bool:
    return line.x1 >= head.x1 - EDGE_TOL


def _wraps(head: Line, upper: Line, lower: Line) -> bool:
    return (abs(lower.size - head.size) <= SIZE_TOL
            and abs(lower.x0 - head.x0) <= EDGE_TOL
            and lower.x1 <= head.x1 + EDGE_TOL
            and 0 < lower.y - upper.y <= head.size * WRAP_EMS)
