"""Prose normalisation for the read-aloud pipeline.

pdf.js hands us text-layer artefacts — ligature glyphs, words split across a line
break with a hyphen, inline citations, abbreviations, paragraph-long run-ons.
Spoken verbatim they make Kokoro sound broken. This module cleans prose only;
math notation is the job of ``mathspeak``. Every function here is pure.
"""

from __future__ import annotations

import re
import unicodedata

from .. import config

__all__ = [
    "normalize",
    "strip_citations",
    "dehyphenate",
    "expand_abbreviations",
    "fix_ligatures",
    "split_sentences",
    "is_speakable",
]

# ── Glyph repair ──────────────────────────────────────────────────────────────

#: Presentation-form ligatures and typographic glyphs that TTS mispronounces.
_GLYPH_MAP: dict[str, str] = {
    "ﬀ": "ff", "ﬁ": "fi", "ﬂ": "fl", "ﬃ": "ffi",
    "ﬄ": "ffl", "ﬅ": "st", "ﬆ": "st",
    "‘": "'", "’": "'", "‚": "'", "‛": "'", "′": "'",
    "“": '"', "”": '"', "„": '"', "‟": '"', "″": '"',
    "–": "-",           # en dash → plain hyphen (keeps citation ranges intact)
    "―": "—",      # horizontal bar → em dash
    "‐": "-", "‑": "-",
    "…": "...",
    " ": " ", " ": " ", " ": " ", " ": " ",
    "­": "", "​": "", "‌": "", "‍": "", "﻿": "",
}
_GLYPH_RE = re.compile("|".join(re.escape(k) for k in _GLYPH_MAP))

#: Mathematical Alphanumeric Symbols (U+1D400-U+1D7FF) that fold to plain letters, digits
#: and Greek. A paper sets its inline variables there -- Cosmos p12's `H/s_HW` is all
#: Mathematical Italic -- and `mathspeak`'s identifier class is ASCII plus Greek, so every
#: subscript, fraction and function rule steps straight over them and the raw codepoints
#: reach the voice. 547 characters over 81 spoken blocks of the 11-paper corpus.
#: The script (U+1D49C-U+1D4CF) and double-struck (U+1D538-U+1D56B) sub-blocks and the
#: letterlike symbols are EXCLUDED: `mathspeak` reads those as the sets and names they
#: stand for (`ℝ` is "the reals", `𝒪` is big-O), and a blanket NFKC would flatten them to
#: bare capitals first. Neither sub-block appears in the corpus's spoken text.
_MATH_ALNUM_RE = re.compile(
    r"[\U0001d400-\U0001d49b\U0001d4d0-\U0001d537\U0001d56c-\U0001d7ff]"
)
#: Em dashes are kept, but always spaced so they read as a clause break.
_EM_DASH_RE = re.compile(r"\s*—\s*")

# ── De-hyphenation ────────────────────────────────────────────────────────────

#: Fragment before the hyphen: starts with a letter, at least two characters.
_HYPHEN_HEAD = r"(?<!\w)([A-Za-z]\w+)-"
#: Only ever rejoin onto a lowercase continuation — never a capital or a digit.
_HYPHEN_TAIL = r"([a-z]\w*)"
_HYPHEN_LINEBREAK_RE = re.compile(_HYPHEN_HEAD + r"[ \t]*\r?\n[ \t]*" + _HYPHEN_TAIL)
_HYPHEN_SPACE_RE = re.compile(_HYPHEN_HEAD + r"[ \t]+" + _HYPHEN_TAIL)

# ── Citations ─────────────────────────────────────────────────────────────────

#: A bracket is a citation only if its whole content is digits and separators.
_BRACKET_CITE = r"\[[\d,;\s–-]*\d[\d,;\s–-]*\]"
#: `[12], [15]` — a run of bracket citations joined by commas or semicolons.
_BRACKET_RUN_RE = re.compile(_BRACKET_CITE + r"(?:\s*[,;]\s*" + _BRACKET_CITE + r")*")
#: ...but a bibliography numbers from 1, so a zero entry means this is maths: `[0, 1]` is
#: an interval and `[1, 0, 0]` a vector. Of 1,194 bracket groups across 13 real PDFs, all
#: 46 carrying a zero were maths and none of the other 1,148 was.
_ZERO_ENTRY_RE = re.compile(r"(?<!\d)0(?!\d)")
#: `(ak)k∈[15]`, `p ⊆ [1, 5]`, `in the interval [1, 2]` — index notation, never a citation.
_MATH_LEAD_RE = re.compile(r"(?:[∈∉⊂⊆⊃⊇∼]|\b(?:interval|range)\s?)\s*$", re.I)
#: 1500–2099, the only years a bibliography realistically carries.
_YEAR = r"(?:1[5-9]\d{2}|20\d{2})"
#: A parenthetical is a citation only if it carries a year or `et al`.
_PAREN_CITE_RE = re.compile(
    r"\s*\((?=[^()]*(?:\bet\.?\s+al\b|\b" + _YEAR + r"\b))[^()]*\)"
)
#: Leftover `, 2020)` after an opening paren was lost in extraction.
_YEAR_FRAGMENT_RE = re.compile(r"\s*,\s*" + _YEAR + r"\s*\)")

# ── Spacing repair ────────────────────────────────────────────────────────────

_SPACE_BEFORE_PUNCT_RE = re.compile(r"[ \t]+([,.;:!?)\]])")
_SPACE_AFTER_OPEN_RE = re.compile(r"([(\[])[ \t]+")
_MULTI_SPACE_RE = re.compile(r"[ \t]{2,}")
_ALL_WHITESPACE_RE = re.compile(r"\s+")

# ── Abbreviations ─────────────────────────────────────────────────────────────

#: Abbreviations whose trailing period may genuinely end a sentence.
_TERMINAL_ABBREVS: tuple[tuple[str, str], ...] = (
    (r"\bet\.?\s+al\.", "and others"),
    (r"\betc\.", "et cetera"),
)
#: The abbreviation ends a sentence when a capital or the string end follows.
_SENTENCE_FOLLOWS = r"(?=\s+[A-Z]|\s*$)"

#: Plain word-boundary-safe expansions, applied in order (longest first).
_ABBREV_RULES: tuple[tuple[re.Pattern[str], str], ...] = tuple(
    (re.compile(pattern, re.IGNORECASE), replacement)
    for pattern, replacement in (
        (r"\bw\.\s?r\.\s?t\.", "with respect to"),
        (r"\bs\.\s?t\.", "such that"),
        (r"\be\.\s?g\.", "for example"),
        (r"\bi\.\s?e\.", "that is"),
        (r"\bet\s+al\b", "and others"),
        (r"\bcf\.", "compare"),
        (r"\bvs\.", "versus"),
        (r"\bapprox\.", "approximately"),
        (r"\bresp\.", "respectively"),
        (r"\bfig\.", "figure"),
        (r"\beq\.", "equation"),
        (r"\bsec\.", "section"),
        (r"\bref\.", "reference"),
        (r"\btab\.", "table"),
        (r"\bapp\.", "appendix"),
        (r"\bthm\.", "theorem"),
        (r"\bdef\.", "definition"),
        (r"\blem\.", "lemma"),
        (r"\bprop\.", "proposition"),
        (r"\bcor\.", "corollary"),
        (r"\balg\.", "algorithm"),
    )
)

#: Symbols and units TTS mangles. Order matters: °C before the bare degree sign.
_SYMBOL_RULES: tuple[tuple[re.Pattern[str], str], ...] = (
    (re.compile(r"%"), " percent"),
    # `Pick-&-Place` is one hyphenated compound: spacing the `and` would leave
    # `Pick- and -Place`, which `dehyphenate` then glues into `Pickand` on a second pass.
    (re.compile(r"(?<=-)&(?=-)"), "and"),
    (re.compile(r"&"), " and "),
    (re.compile(r"#"), " number "),
    (re.compile(r"~(?=\s*\d)"), "approximately "),
    (re.compile(r"°\s*C\b"), " degrees Celsius"),
    (re.compile(r"°\s*F\b"), " degrees Fahrenheit"),
    (re.compile(r"°"), " degrees"),
    (re.compile(r"(?<=\d)\s*[µμ]s\b"), " microseconds"),
    (re.compile(r"(?<=\d)\s*ms\b"), " milliseconds"),
    (re.compile(r"(?<=\d)\s*ns\b"), " nanoseconds"),
    (re.compile(r"(?<=\d)\s*kHz\b"), " kilohertz"),
    (re.compile(r"(?<=\d)\s*MHz\b"), " megahertz"),
    (re.compile(r"(?<=\d)\s*GHz\b"), " gigahertz"),
    (re.compile(r"(?<=\d)\s*Hz\b"), " hertz"),
)
#: `3x4` → `3 by 4`, but never inside a hex literal such as `0x1F`.
#: `224x224` is a dimension; `2x1` in an equation is 2 times x-sub-1. Only treat a bare
#: ASCII `x` as "by" when it is spaced or both operands are multi-digit — otherwise a
#: linear-algebra paper reads "lambda 1x1 + lambda 2x2" as "lambda 1 by 1 plus lambda 2 by 2".
_DIMENSION_RE = re.compile(
    r"\b0[xX][0-9a-fA-F]+\b"                 # leave hex alone
    r"|(?<=\d)\s*×\s*(?=\d)"                # × is unambiguous
    r"|(?<=\d)\s+[xX]\s+(?=\d)"             # "3 x 4"
    r"|(?<=\d\d)[xX](?=\d\d)"               # "224x224"
)

# ── Sentence splitting ────────────────────────────────────────────────────────

#: Periods are swapped for this while splitting, then swapped back.
_SENTINEL = "\x00"

_PROTECTED_ABBREVS: tuple[str, ...] = (
    "w.r.t.", "s.t.", "e.g.", "i.e.", "et al.", "etc.", "cf.", "vs.",
    "Fig.", "Eq.", "Sec.", "Ref.", "Tab.", "App.", "approx.", "resp.",
    "Thm.", "Def.", "Lem.", "Prop.", "Cor.", "Alg.",
    "Dr.", "Mr.", "Mrs.", "Ms.", "Prof.", "St.", "No.", "Vol.", "pp.", "al.",
)
_ABBREV_PERIOD_RE = re.compile(
    r"\b(?:" + "|".join(re.escape(a) for a in _PROTECTED_ABBREVS) + r")",
    re.IGNORECASE,
)
_DECIMAL_PERIOD_RE = re.compile(r"(?<=\d)\.(?=\d)")
_INITIAL_PERIOD_RE = re.compile(r"\b[A-Z]\.(?=\s*[A-Z]\.|\s+[A-Z][a-z])")
_ELLIPSIS_RE = re.compile(r"\.{2,}")
_SENTENCE_END_RE = re.compile(r'(?<=[.!?])["\'”’)\]]*\s+')

#: Clause boundaries used to hard-wrap a runaway sentence.
_CLAUSE_PUNCT_RE = re.compile(r"[;:,](?=\s)")
_CLAUSE_WORD_RE = re.compile(
    r"\s+(?:—|and|but|or|nor|yet|so|which|while|because|although|whereas"
    r"|however|therefore|thus)\s+"
)

_LETTER_RE = re.compile(r"[^\W\d_]")
#: A complete thought too short for the length floor: `It fails.`, `We do not.`
_SHORT_SENTENCE_RE = re.compile(r"^[A-Z][^\W\d_]*(?:[^\w]+[^\W\d_]+)+\s*[.!?]$")


# ── Public API ────────────────────────────────────────────────────────────────


def fix_ligatures(text: str) -> str:
    """Replace ligature glyphs, smart punctuation, exotic spaces and math letters with ASCII."""
    if not text:
        return ""
    out = _GLYPH_RE.sub(lambda m: _GLYPH_MAP[m.group(0)], text)
    out = _MATH_ALNUM_RE.sub(lambda m: unicodedata.normalize("NFKC", m.group(0)), out)
    return _EM_DASH_RE.sub(" — ", out)


def dehyphenate(text: str) -> str:
    """Rejoin words broken by a line-break hyphen (``informa-\\ntion``).

    Genuine compounds (``state-of-the-art``, ``non-linear``) are left alone, and
    a hyphen followed by a capital or a digit is never joined. A compound broken
    across the line keeps its hyphen — see ``_join_hyphenated``.
    """
    if not text:
        return ""
    out = _HYPHEN_LINEBREAK_RE.sub(_join_hyphenated, text)
    return _HYPHEN_SPACE_RE.sub(_join_hyphenated, out)


def strip_citations(text: str) -> str:
    """Remove inline citations, leaving non-citation brackets and prose intact.

    A bracket qualifies only when its entire content is digits and separators,
    so ``[MASK]`` survives; and only when no entry is zero and no set-membership
    glyph precedes it, so the interval ``[0, 1]`` and the index set ``k∈[15]``
    survive too. A parenthetical qualifies only when it carries a 4-digit year
    or ``et al``, so ``(x + 1)`` and ``(as shown below)`` survive.
    """
    if not text:
        return ""
    out = _PAREN_CITE_RE.sub("", text)
    out = _YEAR_FRAGMENT_RE.sub("", out)
    out = _BRACKET_RUN_RE.sub(lambda m: "" if _is_citation_run(m) else m.group(0), out)
    return _repair_spacing(out)


def expand_abbreviations(text: str) -> str:
    """Spell out academic abbreviations, units and symbols that TTS mangles."""
    if not text:
        return ""
    out = text
    for pattern, replacement in _TERMINAL_ABBREVS:
        out = re.sub(pattern + _SENTENCE_FOLLOWS, replacement + ".", out)
        out = re.sub(pattern, replacement, out)
    for compiled, replacement in _ABBREV_RULES:
        out = compiled.sub(lambda m, r=replacement: _match_case(r, m.group(0)), out)
    out = _DIMENSION_RE.sub(_expand_dimension, out)
    for compiled, replacement in _SYMBOL_RULES:
        out = compiled.sub(replacement, out)
    return out


def normalize(text: str) -> str:
    """Full prose clean-up: glyphs, hyphens, citations, abbreviations, spacing.

    Idempotent — ``normalize(normalize(t)) == normalize(t)``. Stage order is what makes
    that true, and it was not true before: the whitespace collapse used to run *after*
    ``_repair_spacing``, so a newline became a space the first pass never got to inspect
    and the second pass then cleaned up. Verified across all 27,245 blocks of the
    13-document corpus, which is where the three counterexamples in
    ``tests/test_normalize.py::IDEMPOTENCE_SAMPLES`` came from.
    """
    if not text:
        return ""
    out = fix_ligatures(text)
    out = dehyphenate(out)                      # the only stage that needs line breaks
    out = _ALL_WHITESPACE_RE.sub(" ", out)      # ...so flatten before anything reads spacing
    out = strip_citations(out)
    out = expand_abbreviations(out)
    out = _repair_spacing(out)
    return out.strip()


def split_sentences(text: str, max_chars: int = config.SENTENCE_MAX_CHARS) -> list[str]:
    """Split prose into sentences, then hard-wrap anything over ``max_chars``.

    Periods inside abbreviations, initials, decimals and ellipses are not
    treated as boundaries. Blank entries are dropped.
    """
    if not text or not text.strip():
        return []
    masked = _mask_inner_periods(text)
    sentences: list[str] = []
    for chunk in _split_on_terminals(masked):
        restored = chunk.replace(_SENTINEL, ".").strip()
        if restored:
            sentences.extend(_wrap_long(restored, max_chars))
    return [s for s in sentences if s.strip()]


def is_speakable(text: str) -> bool:
    """True when the text is worth sending to the TTS engine.

    The length floor exists to drop the fragments a column or line break leaves behind
    (`In this`, `such that`, `We can` — 613 of them across the 25-document corpus, none
    a complete thought). It also dropped genuinely short complete sentences, so one is
    kept regardless of length: a capitalised run of at least two words ending in terminal
    punctuation. Reading a stray `MIT Press.` is a far cheaper mistake than silently
    skipping `It fails.` (M3).
    """
    if not text:
        return False
    cleaned = normalize(text)
    if _LETTER_RE.search(cleaned) is None:
        return False
    if len(cleaned) >= config.MIN_SPEAKABLE_CHARS:
        return True
    return _SHORT_SENTENCE_RE.match(cleaned) is not None


# ── Internals ─────────────────────────────────────────────────────────────────


def _join_hyphenated(match: re.Match[str]) -> str:
    """Rejoin a broken word, keeping the hyphen when the break was inside a compound.

    A hyphen immediately before the fragment says the parts either side are whole words
    — `vision-language- action`, `state-of-the- art` — and dropping it there produces
    `vision-languageaction`, which no voice can say. 32 such splits appear across the
    13-PDF corpus and 28 are of this shape; the other 4 are genuine word breaks that
    happen to follow a hyphen (`high-dimen- sional`) and keep a hyphen they did not want.
    Separating those needs a dictionary this module does not have, and the failure that
    remains is audible as the right words rather than as a non-word.
    """
    head, tail = match.group(1), match.group(2)
    inside_compound = match.start() > 0 and match.string[match.start() - 1] == "-"
    return f"{head}-{tail}" if inside_compound else f"{head}{tail}"


def _is_citation_run(match: re.Match[str]) -> bool:
    """Is this bracket run a citation, or notation that happens to be all digits?"""
    if _ZERO_ENTRY_RE.search(match.group(0)):
        return False
    return not _MATH_LEAD_RE.search(match.string[: match.start()])


def _repair_spacing(text: str) -> str:
    """Undo the doubled spaces and orphaned punctuation stripping leaves behind."""
    out = _SPACE_BEFORE_PUNCT_RE.sub(r"\1", text)
    out = _SPACE_AFTER_OPEN_RE.sub(r"\1", out)
    return _MULTI_SPACE_RE.sub(" ", out)


def _match_case(replacement: str, matched: str) -> str:
    """Capitalise the expansion when the abbreviation itself was capitalised."""
    if matched[:1].isupper():
        return replacement[:1].upper() + replacement[1:]
    return replacement


def _expand_dimension(match: re.Match[str]) -> str:
    """``3x4`` → ``3 by 4``; a hex literal is returned untouched."""
    token = match.group(0)
    return token if token[:1] == "0" else " by "


def _mask_inner_periods(text: str) -> str:
    """Hide every period that is not a sentence boundary behind a sentinel."""
    out = _ABBREV_PERIOD_RE.sub(_mask_periods, text)
    out = _ELLIPSIS_RE.sub(_mask_periods, out)
    out = _DECIMAL_PERIOD_RE.sub(_SENTINEL, out)
    return _INITIAL_PERIOD_RE.sub(_mask_periods, out)


def _mask_periods(match: re.Match[str]) -> str:
    return match.group(0).replace(".", _SENTINEL)


def _split_on_terminals(text: str) -> list[str]:
    chunks: list[str] = []
    start = 0
    for match in _SENTENCE_END_RE.finditer(text):
        chunks.append(text[start : match.end()])
        start = match.end()
    chunks.append(text[start:])
    return chunks


def _wrap_long(sentence: str, max_chars: int) -> list[str]:
    """Break an over-long sentence at clause boundaries so no piece exceeds max."""
    if max_chars <= 0 or len(sentence) <= max_chars:
        return [sentence]
    pieces: list[str] = []
    rest = sentence
    while len(rest) > max_chars:
        cut = _clause_cut(rest, max_chars)
        head, rest = rest[:cut].strip(), rest[cut:].strip()
        if not head:
            break
        pieces.append(head)
    if rest:
        pieces.append(rest)
    return pieces


def _clause_cut(text: str, max_chars: int) -> int:
    """Index of the latest clause boundary at or before ``max_chars``."""
    window = text[: max_chars + 1]
    best = 0
    for match in _CLAUSE_PUNCT_RE.finditer(window):
        if match.end() <= max_chars:
            best = max(best, match.end())
    for match in _CLAUSE_WORD_RE.finditer(window):
        if 0 < match.start() <= max_chars:
            best = max(best, match.start())
    if best:
        return best
    space = window.rfind(" ", 0, max_chars + 1)
    return space if space > 0 else max_chars
