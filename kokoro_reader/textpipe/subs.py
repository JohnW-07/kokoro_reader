"""User text substitutions: say `groot` where the page prints `GR00T` (T6, D1–D3).

Applied by `pipeline._voice` to its local copy of a block's raw text, before `normalize`,
so `block.text` — which the highlight mapping walks against the page items — never sees
them. All substitutions run in one pass over the original text, so a replacement is never
itself rewritten by a later row (`A → B`, `B → C` does not turn `A` into `C`).
"""

from __future__ import annotations

import re
from functools import lru_cache
from typing import Sequence

from ..config import Substitution

#: A whole word ends where a word character (Unicode letter, digit or `_`) does not follow.
#: Lookarounds rather than `\b`: `\b` needs a word character on one side, so it can never
#: bound a term that starts or ends in punctuation (`C++`, `R&D`). `_` counts as part of a
#: word so `x` does not match inside the subscript `x_t`.
_WORD_BEFORE = r"(?<!\w)"
_WORD_AFTER = r"(?!\w)"

#: Whitespace inside a term matches any run of whitespace: the extractor joins lines and
#: items with single or double spaces, and a phrase can wrap onto the next line.
_INNER_SPACE_RE = re.compile(r"\s+")


def apply(text: str, subs: Sequence[Substitution]) -> str:
    """Return `text` with every whole-word match of every substitution replaced. Pure."""
    if not subs or not text:
        return text
    pattern, replacements = _compile(tuple(subs))
    return pattern.sub(lambda m: replacements[m.lastgroup], text)


def same_find(a: Substitution, b: Substitution) -> bool:
    """Would `a` and `b` claim the same printed word? Such a pair is a duplicate (D3).

    Two case-sensitive rows only collide on the exact spelling; if either ignores case,
    they collide on any spelling that differs only in case.
    """
    if a.ignore_case or b.ignore_case:
        return a.find.lower() == b.find.lower()
    return a.find == b.find


def first_duplicate(subs: Sequence[Substitution]) -> Substitution | None:
    """The first row whose find text an earlier row already claims, or None."""
    for i, sub in enumerate(subs):
        if any(same_find(earlier, sub) for earlier in subs[:i]):
            return sub
    return None


@lru_cache(maxsize=32)
def _compile(subs: tuple[Substitution, ...]) -> tuple[re.Pattern[str], dict[str, str]]:
    """One alternation, longest term first so `GR00T N1` wins over `GR00T` at one spot."""
    ordered = sorted(enumerate(subs), key=lambda pair: -len(pair[1].find))
    alternatives = [f"(?P<s{i}>{_term(sub)})" for i, sub in ordered]
    pattern = re.compile(_WORD_BEFORE + "(?:" + "|".join(alternatives) + ")" + _WORD_AFTER)
    return pattern, {f"s{i}": sub.replace for i, sub in enumerate(subs)}


def _term(sub: Substitution) -> str:
    literal = r"\s+".join(re.escape(part) for part in _INNER_SPACE_RE.split(sub.find.strip()))
    return f"(?i:{literal})" if sub.ignore_case else literal
