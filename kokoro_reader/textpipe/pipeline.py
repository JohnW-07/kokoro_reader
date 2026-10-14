"""Turns page geometry into a speakable sentence list.

The stages are deliberately separable so each can be tested and reasoned about alone:

    classify  →  select  →  normalize  →  mathspeak  →  llm (optional)  →  split

`build_script` is the only entry point the routes use.
"""

from __future__ import annotations

import logging
import re
from collections import Counter
from typing import Sequence

from .. import config
from ..config import ReadOptions
from . import classify, eqlayout, glyphfix, mathspeak, normalize, subs, wrapfig
from .types import Block, DocStats, Line, PageGeometry, Sentence

log = logging.getLogger(__name__)

#: Kinds whose text is mostly notation, so the LLM is worth the latency.
_LLM_KINDS = frozenset({"equation"})

#: Prose above this math density is worth routing through the LLM too.
_LLM_DENSITY = 0.18

#: Read a heading as its own utterance with a trailing period so the voice lands on it.
_HEADING_SUFFIX = "."

#: Only prose is joined across a block boundary; a caption or equation ends where it ends.
_JOINABLE_KIND = "body"

#: Why `_voice` silences a block with too little to say. A body block keeps its spoken text
#: under this reason all the same: it may be the rest of the sentence before it (U14).
_FRAGMENT_REASON = "nothing speakable"

#: A fragment block that turned out to finish the sentence before it.
_CLAIMED_REASON = "rest of the sentence before it"

#: A sentence that ends like this is finished, so the next block starts a new one.
_TERMINAL_END_RE = re.compile(r"[.!?:;…][\"'”’)\]}»]*$")

#: Baselines this close (pt) are one printed row that the extractor split in two.
_SAME_ROW_TOL = 1.0

#: Spoken kinds that may sit between the halves of a sentence cut by a page turn (N4): a
#: figure's caption or a footnote at the foot of one page or the head of the next. The
#: sentence is finished first and they are read after it. A heading or an equation between
#: the halves ends the sentence instead.
_INTERPOSED_KINDS = frozenset({"caption", "footnote", "table", "figure"})

#: The tail's last line must fill this share of its column: one that stops short ended
#: its paragraph (or leads into a display), so the page turn did not cut it.
_FULL_LINE_SHARE = 0.9

#: How far apart (share of the tail's column width) the two pages' columns may be set and
#: still be the same measure: ragged-right books vary by a few percent line to line.
_MEASURE_SHARE = 0.1

#: page number → line index → line, so a Block's `line_ids` can be resolved back to the
#: items each of its sentences covers.
_LineIndex = dict[int, dict[int, Line]]


def build_script(
    pages: Sequence[PageGeometry],
    stats: DocStats,
    options: ReadOptions | None = None,
    normalizer=None,
    own: tuple[int, int] | None = None,
) -> tuple[tuple[Sentence, ...], tuple[Block, ...], dict]:
    """Return ``(sentences, blocks, report)`` for a whole document or page batch.

    `blocks` includes the skipped ones, each carrying the `reason` it was skipped, so the
    UI can grey out those regions and explain itself. Silent skipping is indistinguishable
    from a bug, which is exactly the complaint this pipeline exists to fix.

    `own`, a ``(first, last)`` page range, makes the pages outside it context (N4): they
    are built so a sentence over a batch seam is joined exactly as in one whole build, and
    then only the sentences that *start* on an owned page, and the owned pages' blocks,
    are returned. The batch before a seam builds that sentence whole; the one after skips it.
    """
    opts = options or ReadOptions()
    speak_kinds = opts.speak_kinds()
    # Every later stage -- line lookups for highlights, line gaps -- sees the same lines.
    pages = tuple(_unwrap_page(geom, stats) for geom in pages)

    blocks: list[Block] = []
    for geom in pages:
        blocks.extend(_classify_page(geom, stats))

    decided = tuple(_decide(b, speak_kinds) for b in blocks)
    lines_by_page = _lines_by_page(pages)
    spoken = tuple(_voice(b, opts, normalizer, _layout_text(b, lines_by_page)) if b.speak
                   else b for b in decided)

    line_gaps = {geom.page: classify.page_line_gap(geom, stats) for geom in pages}
    found, claimed = _to_sentences(spoken, lines_by_page, line_gaps)
    sentences = tuple(found)
    spoken = tuple(_claim(b) if i in claimed else b for i, b in enumerate(spoken))
    if own is not None:
        sentences = tuple(s for s in sentences if own[0] <= s.page <= own[1])
        spoken = tuple(b for b in spoken if own[0] <= b.page <= own[1])
    report = _report(spoken, sentences)
    return sentences, spoken, report


# ── Stages ────────────────────────────────────────────────────────────────────


def _unwrap_page(geom: PageGeometry, stats: DocStats) -> PageGeometry:
    """Glyph repair and separating a wrapped figure are enhancements; a failure keeps the
    page as sent."""
    try:
        return wrapfig.unwrap_page(glyphfix.fix_page(geom), stats)
    except Exception:  # noqa: BLE001 - degrade to the unsplit lines
        log.exception("unwrap_page failed on page %s; using lines as extracted", geom.page)
        return geom


def _classify_page(geom: PageGeometry, stats: DocStats) -> tuple[Block, ...]:
    """Classification must never take down the whole document."""
    try:
        return classify.classify_page(geom, stats)
    except Exception:  # noqa: BLE001 - degrade to unclassified body text
        log.exception("classify_page failed on page %s; falling back to raw lines", geom.page)
        return tuple(
            Block(
                kind="body",
                text=ln.text,
                page=geom.page,
                line_ids=(ln.idx,),
                items=ln.items,
                reason="classifier error, treated as body",
            )
            for ln in geom.lines
            if ln.text.strip()
        )


def _decide(block: Block, speak_kinds: frozenset[str]) -> Block:
    """Apply the user's read options. Pure; returns a new Block."""
    if block.kind in speak_kinds:
        return block
    reason = block.reason or f"{block.kind} skipped by settings"
    return Block(**{**_as_dict(block), "speak": False, "reason": reason})


def _layout_text(block: Block, lines_by_page: _LineIndex) -> str | None:
    """A display equation's limits and fractions put back in place (N14), else None."""
    if block.kind != "equation" or len(block.line_ids) < 2:
        return None
    page = lines_by_page.get(block.page, {})
    try:
        return eqlayout.linearize([page[i] for i in block.line_ids if i in page])
    except Exception:  # noqa: BLE001 - read the equation as extracted
        log.exception("eqlayout failed on page %s; reading the lines as extracted", block.page)
        return None


def _voice(block: Block, opts: ReadOptions, normalizer, source: str | None = None) -> Block:
    """Produce `spoken` text for a block that will be read aloud.

    Substitutions rewrite a local copy of the raw text, never `block.text` (D1): the
    highlight mapping walks `block.text` against the page items character by character.
    `source`, when given, is what to read in place of `block.text` (an equation's layout).
    """
    text = normalize.normalize(subs.apply(source or block.text, opts.substitutions))
    if not text:
        return Block(**{**_as_dict(block), "speak": False, "reason": "empty after cleanup"})
    if block.kind == "heading" and not text.endswith((".", "!", "?", ":")):
        text += _HEADING_SUFFIX
    # mathspeak expands, so it can only ever lengthen a block: `1 h _2 i` becomes
    # "1 h sub 2 i" and clears the speakable floor a bare fragment of a display equation
    # has no business clearing. Whether a block has something to say is a question about
    # the block, not about how many words the verbaliser needed to read its symbols --
    # so the floor is applied to the block's own prose, before any expansion. It runs
    # after the heading suffix because `4.2 Results` is a real heading and `4.2 Results.`
    # is what will be read; judging it a character short of the floor loses the section.
    if not _is_speakable(block.kind, text):
        rest = mathspeak.speak(text) if block.kind == _JOINABLE_KIND else ""
        return Block(**{**_as_dict(block), "spoken": rest, "speak": False,
                        "reason": _FRAGMENT_REASON})

    text = mathspeak.speak(text)

    source = "rules"
    if normalizer is not None and opts.use_llm and _wants_llm(block, text):
        refined = _refine(normalizer, text, block.kind)
        if refined and refined != text:
            text, source = refined, "llm"

    if not _is_speakable(block.kind, text):
        return Block(**{**_as_dict(block), "speak": False, "reason": _FRAGMENT_REASON})

    return block.with_spoken(text, source)


def _is_speakable(kind: str, text: str) -> bool:
    """A heading below the floor is still read if it has a word (U17a): "Abstract" and
    "Contents" are navigation; "T", "ψ" and "NVIDIA^1" are stray glyphs."""
    if normalize.is_speakable(text):
        return True
    return (kind == "heading" and classify.WORD_RE.search(text) is not None
            and mathspeak.math_density(text) == 0)


def _pieces(block: Block) -> list[str]:
    """A heading is one utterance: split after its number, "4." and "Tokenizer." are lost."""
    if block.kind == "heading" and len(block.spoken) <= config.SENTENCE_MAX_CHARS:
        return [block.spoken]
    return normalize.split_sentences(block.spoken)


def _wants_llm(block: Block, text: str) -> bool:
    if block.kind in _LLM_KINDS:
        return True
    return mathspeak.math_density(text) >= _LLM_DENSITY


def _refine(normalizer, text: str, kind: str) -> str:
    """The LLM is an optional enhancement; it may never break the read."""
    try:
        return normalizer.refine(text, kind)
    except Exception:  # noqa: BLE001
        log.exception("LLM refine failed; using rules output")
        return text


def _to_sentences(
    blocks: Sequence[Block], lines_by_page: _LineIndex, line_gaps: dict[int, float]
) -> tuple[list[Sentence], frozenset[int]]:
    """The sentences, and the indices of the fragment blocks a join claimed.

    The floor runs after the join (U14): `tasks.` alone is a fragment, but it is the rest
    of `...rapidly learn new`, cut off by the arXiv stamp between the two blocks. A body
    block below the floor may only ever finish the sentence before it.
    """
    out: list[Sentence] = []
    claimed: set[int] = set()
    previous: Block | None = None
    # The last prose sentence (its index in `out`) and the block that ended it: a head
    # at the top of the next page may finish it past captions read in between (N4).
    open_tail: tuple[int, Block] | None = None
    for i, block in enumerate(blocks):
        if not block.spoken or not (block.speak or block.reason == _FRAGMENT_REASON):
            continue
        pieces = _pieces(block)
        spans = _highlight_spans(block, lines_by_page, len(pieces))
        current = [
            Sentence(
                text=piece,
                raw=block.text,
                page=block.page,
                kind=block.kind,
                items=items,
                source=block.source,
            )
            for piece, items in zip(pieces, spans)
        ]
        if not current:
            continue
        target = _join_target(out, previous, open_tail, block, current[0], lines_by_page,
                              line_gaps)
        if target is not None:
            out[target] = _join(out[target], current[0])
            current = current[1:]
            if not block.speak:
                claimed.add(i)
        elif not block.speak:
            continue
        out.extend(current)
        previous = block
        if block.kind == _JOINABLE_KIND:
            open_tail = (len(out) - 1 if current else target, block)
        elif block.kind not in _INTERPOSED_KINDS:
            open_tail = None
    return [s for s in out if _is_speakable(s.kind, s.text)], frozenset(claimed)


def _join_target(
    out: Sequence[Sentence],
    previous: Block | None,
    open_tail: tuple[int, Block] | None,
    block: Block,
    head: Sentence,
    lines_by_page: _LineIndex,
    line_gaps: dict[int, float],
) -> int | None:
    """Index in `out` of the sentence `head` finishes, if any: the one just before it on
    the same page (T2), or the last prose sentence of the page before (N4)."""
    if (previous is not None and previous.page == block.page and _continues(out[-1], head)
            and _runs_on(previous, block, lines_by_page[block.page], line_gaps[block.page])):
        return len(out) - 1
    if open_tail is not None:
        index, tail_block = open_tail
        if _turns_page(out[index], head) and _same_column(tail_block, block, lines_by_page):
            return index
    return None


def _claim(block: Block) -> Block:
    """A fragment block a join read out is spoken, not skipped, in the report."""
    return Block(**{**_as_dict(block), "speak": True, "reason": _CLAIMED_REASON})


def _continues(tail: Sentence, head: Sentence) -> bool:
    """Is `head` the rest of `tail`, cut off by a column or block boundary? (T2)

    The classifier ends a paragraph at a column foot, and at a figure or footnote that
    interrupts it, so the sentence running across is read as two chunks: `...holding out
    the kitchen` then `scenes for evaluation.` Here the head is on the page the tail ends
    on; `_turns_page` is the same question across a page turn.
    """
    return tail.parts[-1][0] == head.page and _reads_on(tail, head)


def _turns_page(tail: Sentence, head: Sentence) -> bool:
    """Is `head`, at the top of the next page, the rest of `tail`? (N4)

    The head must be on the page after the one the tail starts on, so a sentence crosses
    at most one page turn and every join stays within two pages: that is what lets a page
    batch built with context pages agree with a whole-document build. A tail that already
    turned a page takes no second head here; on that page `_continues` decides.
    """
    return len(tail.parts) == 1 and head.page == tail.page + 1 and _reads_on(tail, head)


def _reads_on(tail: Sentence, head: Sentence) -> bool:
    """Prose to prose, an unfinished tail, a lowercase head -- the one signal that the
    next block cannot start a new sentence -- and the existing length cap."""
    return (
        tail.kind == head.kind == _JOINABLE_KIND
        and _TERMINAL_END_RE.search(tail.text) is None
        and head.text[:1].islower()
        and len(tail.text) + len(head.text) < config.SENTENCE_MAX_CHARS
    )


def _runs_on(tail: Block, head: Block, lines: dict[int, Line], line_gap: float) -> bool:
    """Does `head`'s first line sit where the text of `tail`'s last line carries on? (T2)

    A lowercase head after an unfinished tail is not enough: the block before it in
    reading order can be a figure label, a table row, an author list or the other half of
    a caption, and gluing those on reads nonsense. The carry-on is one of three places:
    the rest of the same printed row, the next line down in the same column, or the top
    of the next column, which is to the right, higher up, and set to the same measure.
    """
    last, first = lines[tail.line_ids[-1]], lines[head.line_ids[0]]
    step = first.y - last.y
    same_row = (abs(step) <= _SAME_ROW_TOL
                and 0 <= first.x0 - last.x1 <= classify.RIGHT_FLUSH_TOL)
    next_line = (0 < step <= classify.PARA_GAP_RATIO * line_gap
                 and first.x0 < last.x1 and last.x0 < first.x1)
    next_column = (step < 0 and first.x0 > last.x1
                   and abs(first.width - last.width) <= classify.RIGHT_FLUSH_TOL)
    return same_row or next_line or next_column


def _same_column(tail: Block, head: Block, lines_by_page: _LineIndex) -> bool:
    """Is `head`'s text set where `tail`'s carries on over the page turn? (N4)

    Pages repeat their layout, so the carry-on is a column of the same measure: the left
    column of a two-column page follows the right one, a verso's text block follows a
    recto's shifted margin. The tail's last line must run to its column's end -- one that
    stops short closed its paragraph -- and the head's column must be as wide. A one-line
    head is the short last line of its paragraph, so it need only fit. A figure label or a
    code listing at a page foot is set narrower than the prose after it, and stays apart.
    """
    tail_lines = _block_lines(tail, lines_by_page)
    head_lines = _block_lines(head, lines_by_page)
    if not tail_lines or not head_lines:
        return False
    measure = max(ln.width for ln in tail_lines)
    if tail_lines[-1].width < _FULL_LINE_SHARE * measure:
        return False
    if len(head_lines) == 1:
        return head_lines[0].width <= measure + classify.RIGHT_FLUSH_TOL
    return abs(max(ln.width for ln in head_lines) - measure) <= _MEASURE_SHARE * measure


def _block_lines(block: Block, lines_by_page: _LineIndex) -> list[Line]:
    page = lines_by_page.get(block.page, {})
    return [page[i] for i in block.line_ids if i in page]


def _join(tail: Sentence, head: Sentence) -> Sentence:
    """One sentence whose items run from `tail`'s block into `head`'s, in reading order.

    Items on one page merge into one part; a head on the next page adds a part (N4).
    """
    (last_page, last_items), *head_rest = head.parts
    tail_end_page, tail_end_items = tail.parts[-1]
    if last_page == tail_end_page:
        parts = (*tail.parts[:-1], (last_page, tail_end_items + last_items), *head_rest)
    else:
        parts = (*tail.parts, *head.parts)
    return Sentence(
        text=normalize.dehyphenate(f"{tail.text} {head.text}"),
        raw=f"{tail.raw} {head.raw}",
        page=tail.page,
        kind=tail.kind,
        items=parts[0][1],
        source="llm" if "llm" in (tail.source, head.source) else tail.source,
        spans=parts if len(parts) > 1 else (),
    )


# ── Sentence-level highlighting (J4) ──────────────────────────────────────────


def _lines_by_page(pages: Sequence[PageGeometry]) -> _LineIndex:
    """`Block` carries `line_ids`, not the lines; this is how they are looked back up."""
    return {geom.page: {ln.idx: ln for ln in geom.lines} for geom in pages}


def _highlight_spans(
    block: Block, lines_by_page: _LineIndex, count: int
) -> tuple[tuple[int, ...], ...]:
    """One item tuple per spoken sentence — the glyphs that sentence actually covers.

    Handing every sentence `block.items` highlights the whole paragraph while one
    sentence is read (J4). The narrowing is only safe when the raw side splits into the
    same number of sentences as the spoken side, because that is what makes the pairing
    positional rather than a guess; where it does not, the sentence keeps the block's
    full list. A coarse highlight is a cosmetic complaint, a wrong one looks like the
    reader has lost its place.

    Measured on the 11-paper corpus (8,396 sentences): 4,061 of 4,123 spoken blocks
    (98.5%) pair 1:1, 59 disagree on the count — `etc.` is one raw sentence and two
    spoken ones — and 3 carry a literal NUL that `split_sentences` restores as a period.
    So 182 sentences (2.2%) keep the block-wide highlight and the median sentence drops
    from 8 items to 2. A cumulative-word-count alignment would have to earn that last
    2.2% against the risk of sliding a highlight on the other 97.8%.
    """
    spans = _raw_item_spans(block, lines_by_page)
    if spans is None or len(spans) != count or not all(spans):
        return (block.items,) * count
    return spans


def _raw_item_spans(
    block: Block, lines_by_page: _LineIndex
) -> tuple[tuple[int, ...], ...] | None:
    """Item indices for each sentence of the *raw* block text, or None if unmappable.

    `block.spoken` cannot be indexed into: normalize, mathspeak and the LLM have all
    rewritten it, so its offsets no longer correspond to anything on the page. The raw
    side can be. `block.text` joins `Line.text`, each of which joins `Line.item_text`,
    and every one of those joins only ever *adds or collapses whitespace* — so ignoring
    whitespace, the characters of `block.text` are exactly the characters of the items
    that produced it, in order. Walking the two in lockstep therefore needs no offset
    arithmetic and no knowledge of the client's spacing heuristic. Any disagreement
    abandons the block instead of guessing: an index that belongs to another sentence
    silently highlights the wrong glyphs (`pdfview.js` paints whatever it is given).
    """
    page = lines_by_page.get(block.page, {})
    lines = [page.get(i) for i in block.line_ids]
    if not lines or any(ln is None for ln in lines):
        return None

    stream = _char_stream(lines)  # type: ignore[arg-type]
    if stream is None or not set(block.items).issuperset(idx for _, idx in stream):
        return None

    spans: list[tuple[int, ...]] = []
    pos = 0
    for sentence in normalize.split_sentences(block.text):
        seen: list[int] = []
        for ch in sentence:
            if ch.isspace():
                continue
            if pos >= len(stream) or stream[pos][0] != ch:
                return None
            if not seen or seen[-1] != stream[pos][1]:
                seen.append(stream[pos][1])
            pos += 1
        spans.append(tuple(seen))
    return tuple(spans)


def _char_stream(lines: Sequence[Line]) -> tuple[tuple[str, int], ...] | None:
    """Every non-space character of the block's items, tagged with the item it came from."""
    out: list[tuple[str, int]] = []
    for line in lines:
        if len(line.items) != len(line.item_text):
            return None  # the parallel arrays are the whole basis of the mapping
        for idx, text in zip(line.items, line.item_text):
            out.extend((ch, idx) for ch in text if not ch.isspace())
    return tuple(out)


def _report(blocks: Sequence[Block], sentences: Sequence[Sentence]) -> dict:
    skipped = Counter(b.kind for b in blocks if not b.speak)
    return {
        "blocks": len(blocks),
        "sentences": len(sentences),
        "skipped": dict(skipped),
        "skipped_total": sum(skipped.values()),
        "llm_used": sum(1 for b in blocks if b.source == "llm"),
    }


def _as_dict(block: Block) -> dict:
    return {
        "kind": block.kind,
        "text": block.text,
        "page": block.page,
        "line_ids": block.line_ids,
        "items": block.items,
        "spoken": block.spoken,
        "speak": block.speak,
        "source": block.source,
        "reason": block.reason,
    }
