"""Repair math glyphs pdf.js decodes through the wrong encoding (N14).

TeX's CMEX and CMSY fonts carry no Unicode map, so pdf.js reports their code points as
Latin-1: the display summation sign arrives as `Â` and the minus sign as `\\x00` (which
`normalize` also uses as a sentinel, so the minus was read as a full stop). A glyph is
replaced only where its own item is nothing else: a lone `Â` set well above its line is
the operator, while `Â` in a word is a letter. A lone `\\x00` is a minus only where it is
set as one, a space and then a glyph after it and no other unmapped code beside it;
other fonts use the code for a split ligature (Avelo's `\\x00` + `nd`, "find") or a run
of dashes (`\\x00\\x00\\x00`).

Line text and item text change together, so the highlight mapping that walks one against
the other still lines up. Pure; returns new objects.
"""

from __future__ import annotations

import re
from dataclasses import replace

from .types import Line, PageGeometry

#: A big operator is set this much larger than the line it sits on (16.7 pt on 12 pt).
BIG_OPERATOR_SIZE_RATIO = 1.25
_BIG_SUM = ("Â", "∑")
_MINUS = ("\x00", "−")
#: Any other control code on the line means a font with no usable map at all.
_OTHER_CONTROL_RE = re.compile(r"[\x01-\x1f]")


def fix_page(geom: PageGeometry) -> PageGeometry:
    lines = tuple(fix_line(ln) for ln in geom.lines)
    return geom if lines == geom.lines else replace(geom, lines=lines)


def fix_line(line: Line) -> Line:
    if len(line.item_text) != len(line.item_size):
        return line
    fixes = {k: new for k in range(len(line.item_text)) if (new := _replacement(line, k))}
    return _apply(line, fixes) if fixes else line


def _replacement(line: Line, k: int) -> str:
    text, size = line.item_text[k], line.item_size[k]
    if text == _MINUS[0] and _set_as_minus(line, k):
        return _MINUS[1]
    if text == _BIG_SUM[0] and line.size > 0 and size >= line.size * BIG_OPERATOR_SIZE_RATIO:
        return _BIG_SUM[1]
    return ""


def _set_as_minus(line: Line, k: int) -> bool:
    """A space follows it, and neither neighbouring glyph is another unmapped code."""
    items = line.item_text
    if k + 1 >= len(items) or items[k + 1].strip() or _OTHER_CONTROL_RE.search(line.text):
        return False
    left = next((t for t in reversed(items[:k]) if t.strip()), "")
    right = next((t for t in items[k + 1:] if t.strip()), "")
    return bool(right) and _MINUS[0] not in left.strip()[-1:] + right.strip()[:1]


def _apply(line: Line, fixes: dict[int, str]) -> Line:
    """Swap each fixed item's glyph in place in the line text, found by walking the items."""
    pieces, walked, copied = [], 0, 0
    for k, raw in enumerate(line.item_text):
        if not (text := raw.strip()):
            continue  # the client collapses and trims blanks; they anchor nothing
        at = line.text.find(text, walked)
        if at < 0:
            return line  # the text is not the items' concatenation; leave both alone
        walked = at + len(text)
        if k in fixes:
            pieces.append(line.text[copied:at] + fixes[k])
            copied = walked
    pieces.append(line.text[copied:])
    item_text = tuple(fixes.get(k, t) for k, t in enumerate(line.item_text))
    return replace(line, text="".join(pieces), item_text=item_text)
