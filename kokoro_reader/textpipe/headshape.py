"""Heading shapes that need no font name (N3).

pdf.js names fonts `g_d0_f2`, so "bold" never appears in a font name and a heading set at
body size was read as the first words of the paragraph after it. Two shapes give such a
heading away without one:

    small caps        `I. I` + `NTRODUCTION`: each word's capital at text size, the rest as
                      smaller capitals, and no lower case on the line (IEEE section titles)
    run-in title      a few capitalised words in one run, with a word of 4+ letters, no
                      number token, punctuated at most by a section number,
                      ending well short of the measure, in a face of their own, over a
                      capitalised prose line (lower-case words, past the title's width cap,
                      no column shared with the title) at the same margin
                      (GR00TN1 p3 "State and Action Encoders")

Pure.
"""

from __future__ import annotations

import re

from .tablerow import COLUMN_TOL, column_count
from .types import Line

#: A small capital is set at ~0.7-0.8 of the capital before it.
SMALL_CAPS_SIZE_RATIO = 0.9
#: A run-in title is a few words...
MAX_TITLE_WORDS = 8
#: ...and stops well short of the column's measure.
TITLE_WIDTH_RATIO = 0.6
#: A title is words: no clause or sentence break, and none of the brackets, colons,
#: straight quotes, `=` or `_` of a code line (`In [5]: import numpy as np`) or a receipt field.
_TITLE_RE = re.compile(r"[^\W_](?:[^\W_]|[\s'’‘()&/?-]|\.(?=\S))*")
#: Past this share of digits a short line is a table row or value, not a title.
MAX_TITLE_DIGIT_SHARE = 0.3
#: A title has a real word; `ViT-L` or `Q1` is a label.
_TITLE_WORD_RE = re.compile(r"[^\W\d_]{4,}")
#: Prose has lower-case words; a list of names or a table row has none.
_PROSE_WORD_RE = re.compile(r"(?<!\S)[a-z]{3,}(?=[\s,.;:]|$)")


def is_small_caps(line: Line) -> bool:
    if any(c.islower() for c in line.text):
        return False
    pairs = zip(line.item_text, line.item_size, line.item_text[1:], line.item_size[1:])
    return any(a[-1:].isupper() and b[:1].isupper() and 0 < sb <= sa * SMALL_CAPS_SIZE_RATIO
               for a, sa, b, sb in pairs)


def is_run_in_title(line: Line, nxt: Line | None, col_width: float) -> bool:
    text = line.text.strip()
    if nxt is None or not text[:1].isupper() or not _reads_as_title(line, text):
        return False
    return (len(text.split()) <= MAX_TITLE_WORDS
            and line.width <= col_width * TITLE_WIDTH_RATIO
            and nxt.font != line.font
            and nxt.y > line.y
            and nxt.width >= col_width * TITLE_WIDTH_RATIO
            and not _aligned_columns(line, nxt)
            and abs(nxt.x0 - line.x0) <= COLUMN_TOL
            and nxt.text.strip()[:1].isupper()
            and bool(_PROSE_WORD_RE.search(nxt.text)))


def _aligned_columns(line: Line, nxt: Line) -> bool:
    """An item past the first starts where one of the next line's does: a table header."""
    def starts(ln: Line) -> list[float]:
        return [x for x, t in zip(ln.item_x, ln.item_text) if t.strip()][1:]
    return any(abs(a - b) <= COLUMN_TOL for a in starts(line) for b in starts(nxt))


def _reads_as_title(line: Line, text: str) -> bool:
    """Words in one run: not a table cell, a number, a label or a header split by a gutter.

    Contents falls back to detected headings (N7); `False 10256`, `Type  Description` and
    `ViT-L` would be listed as sections.
    """
    tokens = text.split()
    chars = "".join(tokens)
    return (bool(_TITLE_RE.fullmatch(text)) and bool(_TITLE_WORD_RE.search(text))
            and not any(tok.isdigit() for tok in tokens)
            and sum(c.isdigit() for c in chars) <= MAX_TITLE_DIGIT_SHARE * len(chars)
            and column_count(line) == 1)
