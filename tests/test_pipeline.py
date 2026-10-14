"""J4: a sentence must highlight its own glyphs, not the whole paragraph's.

`Sentence.items` is what `pdfview.highlightItems` paints. Handing every sentence of a
block the block's full item list makes all N sentences of a paragraph highlight
identically, which is the defect these tests exist to prevent coming back.
"""

from __future__ import annotations

from dataclasses import replace
from typing import Sequence

import pytest

from kokoro_reader import config
from kokoro_reader.config import ReadOptions
from kokoro_reader.textpipe import normalize, pipeline
from kokoro_reader.textpipe.classify import compute_doc_stats
from kokoro_reader.textpipe.types import Block, PageGeometry, Sentence

from .test_classify import BODY, BOLD_FONT, LEFT, RIGHT, mk_line, mk_page

PARA_LEADING = 12.0


def build(pages: Sequence[PageGeometry], **kw):
    """Run the real pipeline the way the route does."""
    stats = compute_doc_stats(pages)
    return pipeline.build_script(pages, stats, ReadOptions(**kw))


def para_page(page: int, texts: Sequence[str], *, y0: float = 120.0, **line_kw):
    """One paragraph: evenly led lines that the classifier keeps as a single block."""
    return mk_page(
        page,
        [mk_line(i, t, y0 + PARA_LEADING * i, **line_kw) for i, t in enumerate(texts)],
    )


def only_block(pages: Sequence[PageGeometry], **kw) -> tuple[Block, tuple[Sentence, ...]]:
    sentences, blocks, _ = build(pages, **kw)
    spoken = [b for b in blocks if b.speak]
    assert len(spoken) == 1, [(b.kind, b.text) for b in blocks]
    return spoken[0], sentences


def assert_sane(block: Block, sentences: Sequence[Sentence]) -> None:
    """The invariants that make a highlight safe, asserted on every case below."""
    allowed = set(block.items)
    order = {item: i for i, item in enumerate(block.items)}
    for s in sentences:
        assert s.items, f"empty items for {s.text!r}"
        assert allowed.issuperset(s.items), f"foreign index in {s.items} vs {block.items}"
        positions = [order[i] for i in s.items]
        assert positions == sorted(positions), f"items out of reading order: {s.items}"
        assert len(set(s.items)) == len(s.items), f"repeated index in {s.items}"


# ── The defect ────────────────────────────────────────────────────────────────


THREE_SENTENCES = (
    "We train the model on eight tasks and report the mean score.",
    "The variance is small. Each run uses a different random seed",
    "and the seeds are fixed in advance so the numbers reproduce.",
)


def test_three_sentence_paragraph_highlights_one_sentence_at_a_time():
    block, sentences = only_block([para_page(1, THREE_SENTENCES)])
    assert len(sentences) == 3
    assert_sane(block, sentences)
    spans = [set(s.items) for s in sentences]
    assert not spans[0] & spans[1] and not spans[1] & spans[2] and not spans[0] & spans[2]
    # The defect: every sentence carried the block's whole item list.
    assert all(set(s.items) != set(block.items) for s in sentences)


def test_sentence_spanning_a_line_break_takes_items_from_both_lines():
    _, sentences = only_block([para_page(1, THREE_SENTENCES)])
    last = sentences[-1]
    lines_used = {i // 100 for i in last.items}
    assert lines_used == {1, 2}, last.items


def test_first_sentence_covers_exactly_its_own_line():
    block, sentences = only_block([para_page(1, THREE_SENTENCES)])
    first_line_items = set(range(0, 100)) & set(block.items)
    assert set(sentences[0].items) == first_line_items


# ── Unchanged behaviour where there is nothing to narrow ──────────────────────


def test_single_sentence_block_keeps_the_whole_block():
    texts = ("A single unbroken claim about the estimator that runs across",
             "two visual lines without ever reaching a full stop until here.")
    block, sentences = only_block([para_page(1, texts)])
    assert len(sentences) == 1
    assert sentences[0].items == block.items


def test_heading_gets_its_own_items():
    pages = [mk_page(1, [
        mk_line(0, "3 Experimental Setup", 100.0, x1=LEFT + 110.0, size=BODY + 3.0, font=BOLD_FONT),
        *[mk_line(1 + i, t, 130.0 + PARA_LEADING * i) for i, t in enumerate(THREE_SENTENCES)],
    ])]
    sentences, blocks, _ = build(pages)
    heading = next(b for b in blocks if b.kind == "heading")
    said = [s for s in sentences if s.kind == "heading"]
    assert len(said) == 1 and said[0].text.endswith(".")
    assert said[0].items == heading.items
    assert_sane(heading, said)
    body = next(b for b in blocks if b.kind == "body")
    assert_sane(body, [s for s in sentences if s.kind == "body"])


# ── Fallback: when the spoken side cannot be paired, stay coarse ──────────────


EQUATION = "x0:T = D E x0:T . (1)"


def test_equation_block_falls_back_to_block_items_without_a_foreign_index():
    pages = [mk_page(1, [
        mk_line(0, EQUATION, 100.0, x0=LEFT + 120.0, x1=RIGHT - 120.0),
        *[mk_line(1 + i, t, 140.0 + PARA_LEADING * i) for i, t in enumerate(THREE_SENTENCES)],
    ])]
    sentences, blocks, _ = build(pages, read_equations=True)
    eq = next(b for b in blocks if b.kind == "equation")
    said = [s for s in sentences if s.kind == "equation"]
    assert said, "the equation should still be spoken"
    # mathspeak rewrote the text, so raw and spoken no longer split alike.
    assert len(normalize.split_sentences(eq.text)) != len(normalize.split_sentences(eq.spoken))
    assert all(s.items == eq.items for s in said)
    assert_sane(eq, said)


def test_abbreviation_expansion_that_adds_a_sentence_falls_back():
    """`etc.` is one raw sentence and two spoken ones — the pairing must not slide."""
    texts = ("We vary the aspect ratio, the resolution, the clip length, etc. Many",
             "of the clips were edited before release and carry visible artifacts.")
    block, sentences = only_block([para_page(1, texts)])
    assert len(normalize.split_sentences(block.text)) == 1
    assert len(normalize.split_sentences(block.spoken)) == 2
    assert all(s.items == block.items for s in sentences)
    assert_sane(block, sentences)


def test_llm_rewrite_cannot_produce_a_foreign_index():
    class Rewriter:
        def available(self) -> bool:
            return True

        def refine(self, text: str, kind: str) -> str:
            return "One. Two. Three. Four. Five. Six. Seven."

    pages = [para_page(1, THREE_SENTENCES)]
    stats = compute_doc_stats(pages)
    sentences, blocks, _ = pipeline.build_script(
        pages, stats, ReadOptions(use_llm=True), Rewriter())
    block = next(b for b in blocks if b.speak)
    assert_sane(block, sentences)


def test_block_whose_lines_are_not_in_this_batch_falls_back():
    """`/api/script/build` is called per page batch; a lookup miss must stay coarse."""
    block = Block(kind="body", text="One sentence. And a second one here.", page=9,
                  line_ids=(0, 1), items=(4, 5, 6), spoken="One sentence. And a second.")
    assert pipeline._highlight_spans(block, {}, 2) == (block.items, block.items)


def test_broken_parallel_arrays_fall_back():
    """`items` and `item_text` are the whole basis of the mapping; unequal means unknown."""
    line = mk_line(0, "One sentence. And a second one here.", 100.0)
    broken = replace(line, item_text=line.item_text[:-1])
    block = Block(kind="body", text=line.text, page=1, line_ids=(0,),
                  items=line.items, spoken=line.text)
    index = {1: {0: broken}}
    assert pipeline._highlight_spans(block, index, 2) == (block.items, block.items)
    assert pipeline._highlight_spans(block, {1: {0: line}}, 2) != (block.items, block.items)


# ── Degenerate input ──────────────────────────────────────────────────────────


@pytest.mark.parametrize("text", ["", "   ", " ", "Introduction", "x"])
def test_degenerate_blocks_do_not_crash(text):
    pages = [para_page(1, (text, "Padding that keeps the page from being empty here."))]
    sentences, blocks, _ = build(pages)
    by_key = {(b.page, b.text): b for b in blocks}
    for s in sentences:
        block = by_key[(s.page, s.raw)]
        assert_sane(block, [s])


def test_items_are_always_a_subset_of_their_block_across_a_whole_document():
    """Property assertion over a document carrying every kind the pipeline emits."""
    pages = [
        mk_page(1, [
            mk_line(0, "3 Experimental Setup", 100.0, x1=LEFT + 110.0, size=BODY + 3.0, font=BOLD_FONT),
            *[mk_line(1 + i, t, 130.0 + PARA_LEADING * i) for i, t in enumerate(THREE_SENTENCES)],
            mk_line(4, EQUATION, 180.0, x0=LEFT + 120.0, x1=RIGHT - 120.0),
            mk_line(5, "Figure 1: The encoder reads frames and the decoder writes them back.",
                    220.0, size=BODY - 1.0),
        ]),
        para_page(2, THREE_SENTENCES),
    ]
    sentences, blocks, _ = build(pages, read_equations=True, read_captions=True)
    assert len({b.kind for b in blocks if b.speak}) >= 3
    by_key = {(b.page, b.text): b for b in blocks}
    assert sentences
    for s in sentences:
        assert_sane(by_key[(s.page, s.raw)], [s])


# ── the speakable floor runs on the block, not on mathspeak's expansion ───────


def voiced(kind: str, text: str) -> Block:
    """Run `_voice` the way `build_script` does, with the LLM off."""
    return pipeline._voice(Block(kind=kind, text=text, page=1), ReadOptions(), None)


@pytest.mark.parametrize("text", ["1 h _2 i", "∑ _M", "X^T_0 X^T", "k<i"])
def test_an_equation_fragment_is_silenced_before_mathspeak_inflates_it(text: str) -> None:
    """mathspeak only ever lengthens, so a fragment must be judged on its own text.

    `1 h _2 i` is eight characters of a display equation that lost its context, but
    mathspeak reads it as "1 h sub 2 i" -- fifteen -- and it clears MIN_SPEAKABLE_CHARS
    on the strength of the verbaliser's words alone. Twelve such blocks appeared in the
    corpus the moment extraction started emitting `_` and `^` markers.
    """
    # Act
    block = voiced("equation", text)

    # Assert
    assert not block.speak
    assert block.reason == "nothing speakable"


@pytest.mark.parametrize("text", ["4.2 Results", "E. SAFETY", "INDEX TERMS", "Extractions"])
def test_a_short_section_heading_survives_the_floor(text: str) -> None:
    """The floor runs after `_HEADING_SUFFIX`, because the suffix is part of the read.

    `4.2 Results` is eleven characters and `4.2 Results.` is twelve. Gating on the bare
    text drops eight genuine section headings across the corpus -- navigation the reader
    has no other way to hear.
    """
    # Act
    block = voiced("heading", text)

    # Assert
    assert block.speak, block.reason
    assert block.spoken.endswith(".")


# ── A sentence cut by a column or block boundary is read as one (T2) ──────────

LEFT_COL_X, LEFT_COL_X1, RIGHT_COL_X, RIGHT_COL_X1 = 49.0, 300.0, 312.0, 563.0

LEFT_COLUMN = (
    "We collect demonstrations on four robots and train",
    "one policy on all of them, holding out the kitchen",
)
RIGHT_COLUMN = (
    "scenes for evaluation. The held-out success rate is",
    "reported with a confidence interval over three seeds.",
)


def two_column_page(page: int, left: Sequence[str], right: Sequence[str]) -> PageGeometry:
    """Left column then right column, both starting at the same baseline."""
    lines = [mk_line(i, t, 120.0 + PARA_LEADING * i, x0=LEFT_COL_X, x1=LEFT_COL_X1)
             for i, t in enumerate(left)]
    lines += [mk_line(len(left) + i, t, 120.0 + PARA_LEADING * i, x0=RIGHT_COL_X,
                      x1=RIGHT_COL_X1) for i, t in enumerate(right)]
    return mk_page(page, lines)


def spoken_blocks(blocks: Sequence[Block]) -> list[Block]:
    return [b for b in blocks if b.speak]


def test_a_sentence_continuing_into_the_next_column_is_one_sentence():
    # Arrange
    page = two_column_page(1, LEFT_COLUMN, RIGHT_COLUMN)

    # Act
    sentences, blocks, _ = build([page])

    # Assert
    first, second = spoken_blocks(blocks)
    assert [s.text for s in sentences][0].endswith("holding out the kitchen scenes for evaluation.")
    assert len(sentences) == 2
    joined = sentences[0]
    assert joined.page == 1
    merged = replace(first, items=first.items + second.items)
    assert_sane(merged, [joined])
    assert set(joined.items) & set(first.items) and set(joined.items) & set(second.items)
    assert_sane(second, sentences[1:])


def test_a_sentence_ending_at_a_column_foot_is_not_joined():
    # Arrange
    left = (LEFT_COLUMN[0], "one policy on all of them, holding out the kitchen.")
    right = ("scenes are held out for evaluation. The success rate is",
             RIGHT_COLUMN[1])

    # Act
    sentences, _, _ = build([two_column_page(1, left, right)])

    # Assert
    assert sentences[0].text.endswith("kitchen.")
    assert sentences[1].text.startswith("scenes are held out")


@pytest.mark.parametrize("mark", [":", ";"])
def test_a_tail_ending_in_a_clause_mark_is_not_joined(mark):
    # Arrange
    left = (LEFT_COLUMN[0], LEFT_COLUMN[1] + mark)

    # Act
    sentences, _, _ = build([two_column_page(1, left, RIGHT_COLUMN)])

    # Assert
    assert sentences[0].text.endswith("kitchen" + mark)
    assert sentences[1].text.startswith("scenes for evaluation")


def test_a_word_hyphenated_across_the_column_break_is_rejoined():
    # Arrange
    left = (LEFT_COLUMN[0], "one policy on all of them, holding out the evalu-")
    right = ("ation scenes for the kitchen. The held-out success rate is", RIGHT_COLUMN[1])

    # Act
    sentences, _, _ = build([two_column_page(1, left, right)])

    # Assert
    assert "holding out the evaluation scenes for the kitchen." in sentences[0].text


def test_a_capitalised_next_column_is_not_joined():
    # Arrange
    right = ("Scenes for evaluation. The held-out success rate is", RIGHT_COLUMN[1])

    # Act
    sentences, _, _ = build([two_column_page(1, LEFT_COLUMN, right)])

    # Assert
    assert sentences[0].text.endswith("holding out the kitchen")


def test_a_continuation_on_the_next_page_is_joined_with_a_part_per_page():
    """N4: each page paints its own items, so the join no longer stops at the page turn."""
    # Arrange: page 2 carries on exactly one line below where page 1 stopped
    below = [mk_line(len(LEFT_COLUMN) + i, t, 120.0 + PARA_LEADING * (len(LEFT_COLUMN) + i))
             for i, t in enumerate(RIGHT_COLUMN)]
    pages = [para_page(1, LEFT_COLUMN), mk_page(2, below)]

    # Act
    sentences, _, _ = build(pages)

    # Assert
    assert sentences[0].text.endswith("holding out the kitchen scenes for evaluation.")
    assert [page for page, _ in sentences[0].parts] == [1, 2]
    assert sentences[0].page == 1 and not [s for s in sentences if s.text.startswith("scenes")]


def test_a_join_that_would_exceed_the_length_cap_is_not_made():
    # Arrange: each half fits under the cap on its own, together they do not
    left = ("We collect demonstrations on four robots and train one policy on all of",
            "them, holding out the kitchen and the garage and the laundry room and",
            "the office and the workshop and the greenhouse and the loading dock and",
            "the pantry and the attic, together with every object that sits in those")
    right = ("rooms, across three seasons, two lighting setups and a range of clutter",
             "levels that we chose in advance so that no scene is seen in training.")
    tail, head = " ".join(left), " ".join(right)
    assert len(tail) < config.SENTENCE_MAX_CHARS and len(head) < config.SENTENCE_MAX_CHARS
    assert len(tail) + len(head) >= config.SENTENCE_MAX_CHARS

    # Act
    sentences, _, _ = build([two_column_page(1, left, right)])

    # Assert
    assert [s.text for s in sentences] == [tail, head]


def test_a_lowercase_block_that_is_not_where_the_text_runs_on_is_not_joined():
    """A column's short last line ends its text; the next column is something else."""
    # Arrange
    lines = [
        mk_line(0, "Correspondence to: the first author at the lab", 120.0,
                x0=LEFT_COL_X, x1=240.0),
        mk_line(1, "robots and a pre-trained model are used. Training is", 60.0,
                x0=RIGHT_COL_X, x1=RIGHT_COL_X1),
        mk_line(2, "run on a cluster for three days with a fixed budget.", 72.0,
                x0=RIGHT_COL_X, x1=RIGHT_COL_X1),
    ]

    # Act
    sentences, _, _ = build([mk_page(1, lines)])

    # Assert
    assert sentences[0].text == "Correspondence to: the first author at the lab"
    assert sentences[1].text.startswith("robots and a pre-trained model")


@pytest.mark.parametrize(
    "tail_kind, head_kind",
    [("caption", "body"), ("body", "caption"), ("equation", "body")],
)
def test_only_prose_is_joined(tail_kind: str, head_kind: str):
    # Arrange
    tail = Sentence(text="holding out the kitchen", raw="", page=1, kind=tail_kind, items=(1,))
    head = Sentence(text="scenes for evaluation.", raw="", page=1, kind=head_kind, items=(2,))

    # Act / Assert
    assert not pipeline._continues(tail, head)
    assert pipeline._continues(replace(tail, kind="body"), replace(head, kind="body"))


def test_a_head_on_another_page_does_not_continue_the_tail():
    # Arrange
    tail = Sentence(text="holding out the kitchen", raw="", page=1, kind="body", items=(1,))
    head = Sentence(text="scenes for evaluation.", raw="", page=2, kind="body", items=(1,))

    # Act / Assert
    assert not pipeline._continues(tail, head)
    assert pipeline._continues(tail, replace(head, page=1))


# Where the head's first line sits relative to the tail's last line (left column 49-300,
# 12pt leading): only the three places text carries on to are a continuation.
LEFT_LINE = (LEFT_COL_X, LEFT_COL_X1, 120.0)
RIGHT_LINE = (RIGHT_COL_X, RIGHT_COL_X1, 120.0)


@pytest.mark.parametrize(
    "last, first, runs_on",
    [
        (LEFT_LINE, (304.0, 563.0, 120.0), True),              # rest of the same row
        (LEFT_LINE, (LEFT_COL_X, LEFT_COL_X1, 132.0), True),   # next line down
        (LEFT_LINE, (69.0, LEFT_COL_X1, 132.0), True),         # next line, hanging indent
        (LEFT_LINE, (RIGHT_COL_X, RIGHT_COL_X1, 60.0), True),  # top of the next column
        (LEFT_LINE, (340.0, 563.0, 120.0), False),             # same row across a gutter
        (LEFT_LINE, (0.0, 45.0, 120.0), False),                # same row, left of the tail
        (LEFT_LINE, (304.0, 563.0, 124.5), False),             # just off the row
        (LEFT_LINE, (LEFT_COL_X, LEFT_COL_X1, 160.0), False),  # past a paragraph gap
        (LEFT_LINE, (LEFT_COL_X, LEFT_COL_X1, 60.0), False),   # higher up the same column
        (LEFT_LINE, (RIGHT_COL_X, RIGHT_COL_X1, 132.0), False),  # next baseline, other column
        (RIGHT_LINE, (LEFT_COL_X, LEFT_COL_X1, 132.0), False),   # ...and to the left
        (LEFT_LINE, (332.0, RIGHT_COL_X1, 60.0), False),       # next column, indented
        ((LEFT_COL_X, 240.0, 120.0), (RIGHT_COL_X, RIGHT_COL_X1, 60.0), False),  # short tail
    ],
)
def test_a_head_runs_on_only_from_where_the_tail_line_ends(last, first, runs_on):
    # Arrange
    lines = {
        0: mk_line(0, "the tail", last[2], x0=last[0], x1=last[1]),
        1: mk_line(1, "the head", first[2], x0=first[0], x1=first[1]),
    }
    tail = Block(kind="body", text="the tail", page=1, line_ids=(0,))
    head = Block(kind="body", text="the head", page=1, line_ids=(1,))

    # Act / Assert
    assert pipeline._runs_on(tail, head, lines, PARA_LEADING) is runs_on
