"""Classification rules for R3-R6: furniture, tables, references, footnotes."""

from __future__ import annotations

from dataclasses import replace
from typing import Sequence

import pytest

from kokoro_reader.textpipe import classify
from kokoro_reader.textpipe.classify import classify_page, compute_doc_stats
from kokoro_reader.textpipe.types import Block, Line, PageGeometry

PAGE_W = 612.0
PAGE_H = 792.0
LEFT = 72.0
RIGHT = 540.0
BODY = 9.9
SMALL = 8.0
CAPTION_SIZE = 8.9
BODY_FONT = "g_d0_f1"
BOLD_FONT = "TimesNewRomanPS-BoldMT"
ADVANCE = 0.5  # matches tablerow.CHAR_ADVANCE_RATIO


def mk_line(
    idx: int,
    text: str,
    y: float,
    *,
    x0: float = LEFT,
    x1: float = RIGHT,
    size: float = BODY,
    font: str = BODY_FONT,
    item_x: Sequence[float] | None = None,
    item_text: Sequence[str] | None = None,
) -> Line:
    """A realistic pdf.js line; items are laid out with ordinary word spacing."""
    texts = tuple(item_text) if item_text is not None else tuple(
        f"{word} " for word in text.split()
    )
    if item_x is not None:
        xs = tuple(float(v) for v in item_x)
    else:
        xs, cursor = [], x0
        for chunk in texts:
            xs.append(cursor)
            cursor += len(chunk) * size * ADVANCE
        xs = tuple(xs)
    base = idx * 100
    return Line(
        idx=idx,
        text=text,
        x0=x0,
        x1=x1,
        y=y,
        size=size,
        font=font,
        items=tuple(range(base, base + len(texts))),
        item_x=xs,
        item_text=texts,
        item_size=(size,) * len(texts),
    )


def mk_page(page: int, lines: Sequence[Line]) -> PageGeometry:
    return PageGeometry(page=page, width=PAGE_W, height=PAGE_H, lines=tuple(lines))


def prose_page(page: int, *, first_idx: int = 0) -> PageGeometry:
    """A plain body-text page, used as filler when building multi-page docs."""
    texts = (
        "We evaluate the proposed estimator on four standard benchmark suites",
        "and report the mean over five independent runs with different seeds",
        "so that the reported variance reflects initialisation rather than data",
    )
    return mk_page(
        page,
        [mk_line(first_idx + i, t, 120.0 + 12.0 * i) for i, t in enumerate(texts)],
    )


def block_for(blocks: Sequence[Block], line_idx: int) -> Block:
    return next(b for b in blocks if line_idx in b.line_ids)


def kinds(blocks: Sequence[Block]) -> list[str]:
    return [b.kind for b in blocks]


RUNNING_HEAD = "Deep Residual Learning for Image Recognition"


def _doc_with_running_head() -> list[PageGeometry]:
    """8 pages; the running head sits in the header band on 6 of them."""
    pages = []
    for n in range(1, 9):
        head = [mk_line(0, RUNNING_HEAD, 40.0)] if n <= 6 else []
        body = prose_page(n, first_idx=1).lines
        pages.append(mk_page(n, [*head, *body]))
    return pages


def test_running_head_on_six_of_eight_pages_is_header() -> None:
    # Arrange
    pages = _doc_with_running_head()
    stats = compute_doc_stats(pages)

    # Act
    blocks = classify_page(pages[0], stats)

    # Assert
    assert block_for(blocks, 0).kind == "header"
    assert "repeats" in block_for(blocks, 0).reason


def test_running_head_text_appearing_once_mid_page_is_body() -> None:
    # Arrange
    pages = _doc_with_running_head()
    stats = compute_doc_stats(pages)
    mid_page = mk_page(
        7,
        [
            mk_line(0, "The architecture follows the design introduced by", 300.0),
            mk_line(1, RUNNING_HEAD, 312.0),
        ],
    )

    # Act
    blocks = classify_page(mid_page, stats)

    # Assert
    assert block_for(blocks, 1).kind == "body"


def test_short_document_yields_no_repeated_furniture() -> None:
    # Arrange
    pages = [
        mk_page(n, [mk_line(0, RUNNING_HEAD, 40.0), *prose_page(n, first_idx=1).lines])
        for n in (1, 2, 3)
    ]

    # Act
    stats = compute_doc_stats(pages)

    # Assert
    assert stats.repeated == frozenset()


def test_arxiv_stamp_is_furniture_without_repetition() -> None:
    # Arrange
    page = mk_page(
        1,
        [
            mk_line(0, "arXiv:2401.01234v2 [cs.LG] 3 Jan 2024", 300.0,
                    x0=28.0, x1=44.0),
            mk_line(1, "We introduce a simple estimator for the partition", 120.0),
        ],
    )
    stats = compute_doc_stats([page, prose_page(2)])

    # Act
    blocks = classify_page(page, stats)

    # Assert
    stamp = block_for(blocks, 0)
    assert stamp.kind in ("header", "footer")
    assert stamp.reason == "arXiv stamp"


def test_bare_number_at_page_bottom_is_pagenum() -> None:
    # Arrange
    page = mk_page(
        3,
        [
            mk_line(0, "The remaining terms vanish as the step size decreases", 120.0),
            mk_line(1, "7", 760.0, x0=302.0, x1=310.0),
        ],
    )
    stats = compute_doc_stats([page, prose_page(4)])

    # Act
    blocks = classify_page(page, stats)

    # Assert
    assert block_for(blocks, 1).kind == "pagenum"


def _table_page() -> PageGeometry:
    columns = (72.0, 200.0, 330.0)
    rows = (
        ("ResNet-50 ", "76.1 ", "92.9"),
        ("ResNet-101 ", "77.4 ", "93.5"),
        ("ViT-B/16 ", "79.8 ", "94.7"),
    )
    grid = [
        mk_line(
            2,
            "Model Top-1 Top-5",
            536.0,
            x1=380.0,
            item_x=columns,
            item_text=("Model ", "Top-1 ", "Top-5"),
        )
    ]
    grid += [
        mk_line(
            3 + i,
            " ".join(cell.strip() for cell in cells),
            550.0 + 14.0 * i,
            x1=380.0,
            item_x=columns,
            item_text=cells,
        )
        for i, cells in enumerate(rows)
    ]
    return mk_page(
        4,
        [
            mk_line(0, "The results confirm the trend reported in earlier work", 120.0),
            mk_line(1, "Table 2: Results on ImageNet.", 520.0, x1=280.0,
                    size=CAPTION_SIZE),
            *grid,
        ],
    )


def test_numeric_grid_with_stable_columns_is_table() -> None:
    # Arrange
    page = _table_page()
    stats = compute_doc_stats([page, prose_page(5)])

    # Act
    blocks = classify_page(page, stats)

    # Assert
    table = block_for(blocks, 2)
    assert table.kind == "table"
    assert table.line_ids == (2, 3, 4, 5)
    assert "aligned columns" in table.reason


def test_table_caption_stays_a_separate_caption_block() -> None:
    # Arrange
    page = _table_page()
    stats = compute_doc_stats([page, prose_page(5)])

    # Act
    blocks = classify_page(page, stats)

    # Assert
    caption = block_for(blocks, 1)
    assert caption.kind == "caption"
    assert caption.line_ids == (1,)
    assert caption.text == "Table 2: Results on ImageNet."


def test_prose_mentioning_table_one_is_not_classified_as_table() -> None:
    # Arrange
    page = mk_page(
        4,
        [
            mk_line(0, "The gains are consistent across every dataset we tried", 120.0),
            mk_line(1, "and Table 1 shows the accuracy of each variant in turn", 132.0),
            mk_line(2, "which confirms that the regulariser is doing the work", 144.0),
        ],
    )
    stats = compute_doc_stats([page, prose_page(5)])

    # Act
    blocks = classify_page(page, stats)

    # Assert
    assert "table" not in kinds(blocks)
    assert block_for(blocks, 1).kind == "body"


def test_small_marked_lines_at_page_bottom_are_one_footnote_block() -> None:
    """The marker is a superscript — 6.0 on an 8.0 line, as in RLbook2020.pdf p70.

    This fixture used to set every item at the line size, which no real footnote does;
    accepting a full-size digit is what let an axis tick start a footnote and delete the
    caption under it. See `tests/test_pipe_footnotes.py` for that reproduction.
    """
    # Arrange
    marked = mk_line(1, "1 We thank the anonymous reviewers for pointing", 700.0,
                     size=SMALL)
    page = mk_page(
        2,
        [
            mk_line(0, "The estimator is unbiased under mild regularity", 120.0),
            replace(marked, item_size=(6.0,) + marked.item_size[1:]),
            mk_line(2, "out an error in the original derivation.", 710.0, size=SMALL),
        ],
    )
    stats = compute_doc_stats([page, prose_page(3)])

    # Act
    blocks = classify_page(page, stats)

    # Assert
    footnote = block_for(blocks, 1)
    assert footnote.kind == "footnote"
    assert footnote.line_ids == (1, 2)


def _doc_with_bibliography() -> list[PageGeometry]:
    """14 pages; the bibliography starts on page 12."""
    pages = [prose_page(n, first_idx=0) for n in range(1, 12)]
    pages.append(
        mk_page(
            12,
            [
                mk_line(0, "References", 120.0, x1=140.0, font=BOLD_FONT),
                mk_line(1, "He, K. et al. Deep residual learning. CVPR, 2016.", 140.0),
                mk_line(2, "Vaswani, A. et al. Attention is all you need.", 152.0),
            ],
        )
    )
    pages.append(
        mk_page(13, [mk_line(0, "Zhang, H. et al. Mixup training. ICLR, 2018.", 120.0)])
    )
    pages.append(
        mk_page(14, [mk_line(0, "Zhou, B. et al. Scene parsing. IJCV, 2019.", 120.0)])
    )
    return pages


def test_bibliography_heading_in_back_half_sets_reference_page() -> None:
    # Arrange
    pages = _doc_with_bibliography()

    # Act
    stats = compute_doc_stats(pages)

    # Assert
    assert stats.reference_page == 12
    assert stats.num_pages == 14


def test_everything_from_the_reference_page_onwards_is_reference() -> None:
    # Arrange
    pages = _doc_with_bibliography()
    stats = compute_doc_stats(pages)

    # Act
    tail = [classify_page(p, stats) for p in pages[11:]]

    # Assert
    assert [kinds(b) for b in tail] == [["reference"], ["reference"], ["reference"]]
    assert tail[0][0].line_ids == (0, 1, 2)


def test_references_word_in_front_half_does_not_start_bibliography() -> None:
    # Arrange
    original = _doc_with_bibliography()
    early = mk_page(2, [mk_line(0, "References", 120.0, x1=140.0, font=BOLD_FONT)])
    pages = [original[0], early, *original[2:]]

    # Act
    stats = compute_doc_stats(pages)

    # Assert
    assert stats.reference_page == 12


def test_numbered_bold_section_title_is_heading() -> None:
    # Arrange
    page = mk_page(
        5,
        [
            mk_line(0, "3.2 Method", 200.0, x1=150.0, font=BOLD_FONT),
            mk_line(1, "We first describe the sampling procedure in detail", 220.0),
        ],
    )
    stats = compute_doc_stats([page, prose_page(6)])

    # Act
    blocks = classify_page(page, stats)

    # Assert
    assert block_for(blocks, 0).kind == "heading"
    assert block_for(blocks, 1).kind == "body"


def test_consecutive_prose_lines_merge_into_one_body_block() -> None:
    # Arrange
    page = mk_page(
        6,
        [
            mk_line(0, "The optimiser converges to a stationary point whenever", 120.0),
            mk_line(1, "the step size satisfies the Robbins-Monro conditions", 132.0),
            mk_line(2, "and the gradient noise has bounded variance.", 144.0, x1=380.0),
        ],
    )
    stats = compute_doc_stats([page, prose_page(7)])

    # Act
    blocks = classify_page(page, stats)

    # Assert
    assert len(blocks) == 1
    assert blocks[0].kind == "body"
    assert blocks[0].line_ids == (0, 1, 2)
    assert blocks[0].items == tuple(page.lines[0].items + page.lines[1].items
                                    + page.lines[2].items)


def test_indented_next_line_starts_a_new_body_paragraph() -> None:
    # Arrange
    page = mk_page(
        6,
        [
            mk_line(0, "The optimiser converges to a stationary point whenever", 120.0),
            mk_line(1, "the step size satisfies the usual Robbins-Monro rules", 132.0),
            mk_line(2, "A second paragraph begins here with a first-line indent", 144.0,
                    x0=LEFT + 14.0),
        ],
    )
    stats = compute_doc_stats([page, prose_page(7)])

    # Act
    blocks = classify_page(page, stats)

    # Assert
    assert [b.line_ids for b in blocks] == [(0, 1), (2,)]


def test_centred_narrow_line_is_equation() -> None:
    # Arrange
    page = mk_page(
        7,
        [
            mk_line(0, "The update rule can therefore be written compactly as", 120.0),
            mk_line(1, "θ ← θ − η ∇L(θ)", 140.0, x0=258.0, x1=354.0),
            mk_line(2, "where η denotes the learning rate used in every run", 160.0),
        ],
    )
    stats = compute_doc_stats([page, prose_page(8)])

    # Act
    blocks = classify_page(page, stats)

    # Assert
    assert block_for(blocks, 1).kind == "equation"


def test_ragged_last_line_near_the_page_centre_is_not_an_equation() -> None:
    """T2: a paragraph's short last line, flush-left under a wider line, sat inside the
    centring tolerance and was read as display math, cutting the sentence before it."""
    # Arrange
    page = mk_page(
        7,
        [
            mk_line(0, "We evaluate the policy on four standard benchmark suites and", 120.0),
            mk_line(1, "report the mean over five independent runs with seeds", 132.0),
            mk_line(2, "fixed in advance so the numbers reproduce.", 144.0, x1=420.0),
        ],
    )
    stats = compute_doc_stats([page, prose_page(8)])

    # Act
    blocks = classify_page(page, stats)

    # Assert
    assert [(b.kind, b.line_ids) for b in blocks] == [("body", (0, 1, 2))]


PROSE_A = "We evaluate the policy on four standard benchmark suites and"
PROSE_B = "report the mean over five independent runs with seeds fixed"
DISPLAY = "cost(a, b) + penalty(b)"  # no math glyphs: only its centring marks it as math


@pytest.mark.parametrize(
    "lines",
    [
        pytest.param(  # nothing above it to run out from
            [(DISPLAY, 120.0, 230.0, 382.0), (PROSE_A, 132.0, LEFT, RIGHT),
             (PROSE_B, 144.0, LEFT, RIGHT)],
            id="first-line-on-the-page"),
        pytest.param(  # the second row of a centred display
            [(PROSE_A, 120.0, LEFT, RIGHT), (PROSE_B, 132.0, LEFT, RIGHT),
             ("minimize cost(a, b) over pairs", 144.0, 220.0, 400.0),
             (DISPLAY, 156.0, 220.0, 380.0)],
            id="under-a-centred-line"),
        pytest.param(  # inset from the prose above it
            [(PROSE_A, 120.0, LEFT, RIGHT), (PROSE_B, 132.0, LEFT, RIGHT),
             (DISPLAY, 144.0, 230.0, 382.0)],
            id="display-equation-under-wider-prose"),
        pytest.param(  # flush-left but longer than the line above, so not running out
            [(PROSE_A, 120.0, LEFT, RIGHT), (PROSE_B, 132.0, LEFT, RIGHT),
             ("solve for", 144.0, 160.0, 220.0), (DISPLAY, 156.0, 160.0, 452.0)],
            id="wider-than-the-line-above"),
        pytest.param(  # set off from the paragraph by more than a line break
            [(PROSE_A, 120.0, LEFT, RIGHT), (PROSE_B, 132.0, LEFT, RIGHT),
             (DISPLAY, 172.0, LEFT, 440.0), (PROSE_A, 184.0, LEFT, RIGHT)],
            id="below-a-paragraph-gap"),
    ],
)
def test_centred_line_that_is_not_a_ragged_last_line_stays_an_equation(lines) -> None:
    """Each case breaks exactly one `_is_ragged_line` condition, so it stays display math."""
    # Arrange
    page = mk_page(7, [mk_line(i, text, y, x0=x0, x1=x1)
                       for i, (text, y, x0, x1) in enumerate(lines)])
    display = next(i for i, line in enumerate(lines) if line[0] == DISPLAY)
    stats = compute_doc_stats([page, prose_page(8)])

    # Act
    blocks = classify_page(page, stats)

    # Assert
    assert block_for(blocks, display).kind == "equation"


def test_monospaced_run_is_code() -> None:
    # Arrange
    page = mk_page(
        8,
        [
            mk_line(0, "for i in range(n):", 200.0, x1=200.0, font="CMTT10"),
            mk_line(1, "total += weights[i]", 212.0, x1=210.0, font="CMTT10"),
        ],
    )
    stats = compute_doc_stats([page, prose_page(9)])

    # Act
    blocks = classify_page(page, stats)

    # Assert
    assert kinds(blocks) == ["code"]
    assert blocks[0].line_ids == (0, 1)


def test_every_block_reports_a_reason() -> None:
    # Arrange
    page = _table_page()
    stats = compute_doc_stats([page, prose_page(5)])

    # Act
    blocks = classify_page(page, stats)

    # Assert
    assert all(b.reason for b in blocks)
    assert all(b.speak is True for b in blocks)


def test_body_size_is_the_char_weighted_modal_size() -> None:
    # Arrange: many small caption glyphs, but body prose dominates by characters.
    page = mk_page(
        1,
        [
            mk_line(0, "Figure 1: A short caption.", 400.0, size=CAPTION_SIZE),
            *prose_page(1, first_idx=1).lines,
        ],
    )

    # Act
    stats = compute_doc_stats([page])

    # Assert
    assert stats.body_size == BODY


def test_empty_page_yields_no_blocks() -> None:
    # Arrange
    page = mk_page(1, [])

    # Act / Assert
    assert classify_page(page, compute_doc_stats([page])) == ()


# ── M2: a section number introduces a title, but only when it really does ──────

@pytest.mark.parametrize(
    "text",
    [
        "3.1 Method",
        "1 Introduction",
        "5.3.1. 3D Consistency",      # a title may start with a digit after the separator
        "D. Inference",               # appendix letter -- the old class omitted D and M
        "IV. Related Work",
        "2) Ablations",
    ],
)
def test_numbered_heading_shapes_are_recognised(text: str) -> None:
    assert classify._NUMBERED_HEADING_RE.match(text), text


@pytest.mark.parametrize(
    "text",
    [
        "M = I + n M , 0 t < T, (9.26)",   # RLbook p256 -- an equation, not a heading
        "V t (s) = a (a|s)Q t (s, a)",     # RLbook p20
        "27.5 16x16",                      # Cosmos p13 -- a table row
        "34 4fps 8fps 16fps",              # VJEPA_2 p44
        "0 1b 2b",                         # RLbook p196
        "X X h",                           # RLbook p81 -- a mangled summation
    ],
)
def test_maths_and_table_rows_are_not_numbered_headings(text: str) -> None:
    """195 of these were tagged as headings across 25 real documents.

    A heading skips `mathspeak`, so an equation mis-tagged this way is read as its raw
    glyphs instead of being verbalised -- exactly the failure this reader exists to fix.
    """
    assert not classify._NUMBERED_HEADING_RE.match(text), text


# ── Figure interiors ──────────────────────────────────────────────────────────
# Text printed *inside* a figure -- axis ticks, legend entries, node labels, the words
# on an arrow -- is laid out for the eye, not for sequential reading. `figure` has been
# a declared block kind and excluded from DEFAULT_SPEAK_KINDS since the beginning, but
# no rule ever produced one, so every glyph inside a figure fell through to the heading
# and equation rules. On PiZero.pdf p1 that is 22 of the page's 42 spoken sentences.


def figure_interior_lines(first_idx: int, y0: float) -> list[Line]:
    """A figure's innards: sub-body type, short, scattered across the page's width."""
    labels = (
        (110.0, "observation"), (400.0, "action expert"), (212.0, "image encoder"),
        (398.0, "token"), (245.0, "state"), (113.0, "robot control"),
    )
    return [
        mk_line(first_idx + i, text, y0 + 14.0 * i,
                x0=x, x1=x + 62.0, size=BODY * 0.55)
        for i, (x, text) in enumerate(labels)
    ]


def test_text_inside_a_figure_is_not_spoken() -> None:
    lines = [
        mk_line(0, "We train the policy on a mixture of sources.", 120.0),
        *figure_interior_lines(1, 240.0),
        mk_line(7, "Fig. 1: Our generalist robot policy uses a pre-trained backbone.",
                520.0, size=CAPTION_SIZE),
        mk_line(8, "The model is adapted to robot control by an action expert.", 560.0),
    ]

    blocks = classify_page(mk_page(1, lines), compute_doc_stats([mk_page(1, lines)]))

    assert block_for(blocks, 3).kind == "figure"
    assert {block_for(blocks, i).kind for i in range(1, 7)} == {"figure"}


def test_a_display_equation_above_a_caption_is_still_spoken() -> None:
    """The guard on the figure rule: display maths is also short and also sits next to
    captions. Only sub-body type inside a scattered run is a figure."""
    lines = [
        mk_line(0, "We minimise the flow matching objective below.", 120.0),
        mk_line(1, "L(x) = E [ ||v(x) - u(x)||^2 ] , (1)", 140.0, x0=200.0, x1=412.0),
        mk_line(2, "Fig. 2: The training objective.", 160.0, size=CAPTION_SIZE),
    ]

    blocks = classify_page(mk_page(1, lines), compute_doc_stats([mk_page(1, lines)]))

    assert block_for(blocks, 1).kind != "figure"


def test_a_short_scattered_run_far_from_any_caption_survives() -> None:
    """Without a caption anchoring it, a run of small lines is left alone."""
    lines = [
        mk_line(0, "We train the policy on a mixture of sources.", 120.0),
        *figure_interior_lines(1, 240.0),
        mk_line(7, "The model is adapted to robot control by an action expert.", 560.0),
    ]

    blocks = classify_page(mk_page(1, lines), compute_doc_stats([mk_page(1, lines)]))

    assert all(b.kind != "figure" for b in blocks)


# Two-column ordering (J6) reads the whole left column before the whole right one, so a
# full-width figure arrives as two runs of line indices separated by every body line
# between them. Index adjacency then finds one half and speaks the other: PiZero.pdf p1
# went back to eleven blocks of glyph soup the day column ordering landed. The rule walks
# the page geometrically now, so the split is invisible to it.


def test_a_figure_split_across_a_column_gutter_is_claimed_whole() -> None:
    lines = [
        mk_line(0, "We train the policy on a mixture of sources.", 120.0),
        mk_line(1, "observation", 240.0, x0=110.0, x1=172.0, size=BODY * 0.55),
        mk_line(2, "image encoder", 254.0, x0=112.0, x1=174.0, size=BODY * 0.55),
        mk_line(3, "robot control", 268.0, x0=113.0, x1=175.0, size=BODY * 0.55),
        mk_line(4, "Fig. 1: Our generalist robot policy uses a pre-trained backbone.",
                520.0, size=CAPTION_SIZE),
        mk_line(5, "The model is adapted to robot control by an action expert.", 560.0),
        # The right half of the same figure, carried here by column ordering.
        mk_line(6, "action expert", 245.0, x0=400.0, x1=462.0, size=BODY * 0.55),
        mk_line(7, "token", 259.0, x0=398.0, x1=460.0, size=BODY * 0.55),
        mk_line(8, "state", 273.0, x0=396.0, x1=458.0, size=BODY * 0.55),
    ]

    blocks = classify_page(mk_page(1, lines), compute_doc_stats([mk_page(1, lines)]))

    assert {block_for(blocks, i).kind for i in (1, 2, 3, 6, 7, 8)} == {"figure"}
    assert block_for(blocks, 0).kind != "figure"
    assert block_for(blocks, 5).kind != "figure"


def test_a_caption_s_own_wrapped_text_is_not_swallowed_by_the_figure() -> None:
    """The walk stops at the caption's size, which is what the caption wraps at.

    Column ordering can indent a caption's continuation away from its head, and then
    `_caption_continuation` will not follow it. It must still be spoken: on
    VLALitReview.pdf p6-p7 that is 1090 words of "This figure categorizes seven
    representative architectures..." -- the most useful prose on the page.
    """
    lines = [
        mk_line(0, "We train the policy on a mixture of sources.", 120.0),
        *figure_interior_lines(1, 240.0),
        mk_line(7, "Fig. 1: Our generalist robot policy uses a pre-trained backbone.",
                520.0, size=CAPTION_SIZE),
        mk_line(8, "The figure summarises the key components of the model.", 534.0,
                x0=LEFT + 40.0, size=CAPTION_SIZE),
        mk_line(9, "The model is adapted to robot control by an action expert.", 570.0),
    ]

    blocks = classify_page(mk_page(1, lines), compute_doc_stats([mk_page(1, lines)]))

    assert block_for(blocks, 3).kind == "figure"
    assert block_for(blocks, 8).kind != "figure"
    assert block_for(blocks, 8).speak


def test_a_narrow_label_set_larger_than_the_body_is_still_figure_text() -> None:
    """PiZero.pdf p1 sets one node label at 10.7pt against a 10.0pt body, 11.7pt wide.

    Size alone calls it prose and stops the walk two lines into the figure. Nothing that
    narrow is prose, whatever its font size.
    """
    lines = [
        mk_line(0, "We train the policy on a mixture of sources.", 120.0),
        *figure_interior_lines(1, 240.0),
        mk_line(7, "mlh", 254.0, x0=212.0, x1=224.0, size=BODY * 1.08),
        mk_line(8, "Fig. 1: Our generalist robot policy uses a pre-trained backbone.",
                520.0, size=CAPTION_SIZE),
        mk_line(9, "The model is adapted to robot control by an action expert.", 570.0),
    ]

    blocks = classify_page(mk_page(1, lines), compute_doc_stats([mk_page(1, lines)]))

    assert {block_for(blocks, i).kind for i in range(1, 8)} == {"figure"}


def test_a_running_head_inside_the_figure_s_band_does_not_end_it() -> None:
    """Furniture is printed over the page, not in its flow. PiZero.pdf p1 lays the arXiv
    stamp across the figure at y=228, above every label in it."""
    lines = [
        mk_line(0, "We train the policy on a mixture of sources.", 120.0),
        mk_line(1, "arXiv:2410.24164v4 [cs.LG] 8 Jan 2026", 250.0,
                x0=32.0, x1=52.0, size=BODY * 2.0),
        *figure_interior_lines(2, 260.0),
        mk_line(8, "Fig. 1: Our generalist robot policy uses a pre-trained backbone.",
                520.0, size=CAPTION_SIZE),
        mk_line(9, "The model is adapted to robot control by an action expert.", 570.0),
    ]

    blocks = classify_page(mk_page(1, lines), compute_doc_stats([mk_page(1, lines)]))

    assert block_for(blocks, 1).kind == "header"
    assert {block_for(blocks, i).kind for i in range(2, 8)} == {"figure"}


def test_a_caption_set_larger_than_the_body_cannot_swallow_the_prose_above_it() -> None:
    """The boundary was the caption's own size, so a caption set a point up -- bold, or
    a display caption -- left no prose on the page able to stop the walk at all: the
    whole paragraph above the figure went silent. Body type bounds a figure whatever
    the caption is set in."""
    big_caption = BODY * 1.12
    lines = [
        mk_line(0, "tick", 100.0, x0=110.0, x1=130.0, size=BODY * 0.55),
        mk_line(1, "We train the policy on a large mixture of heterogeneous sources.", 150.0),
        mk_line(2, "Prior work has shown this improves downstream generalisation.", 170.0),
        mk_line(3, "Every sentence here is genuine prose and has to be read aloud.", 190.0),
        *figure_interior_lines(4, 240.0),
        mk_line(10, "Fig. 1: Our generalist robot policy uses a pre-trained backbone.",
                520.0, size=big_caption),
        mk_line(11, "The model is adapted to robot control by an action expert.", 570.0),
    ]

    blocks = classify_page(mk_page(1, lines), compute_doc_stats([mk_page(1, lines)]))

    assert {block_for(blocks, i).kind for i in (1, 2, 3)} == {"body"}
    assert {block_for(blocks, i).kind for i in range(4, 10)} == {"figure"}


LEFT_COL, LEFT_EDGE, RIGHT_COL, RIGHT_EDGE = 49.0, 300.0, 312.0, 563.0

PROSE = (
    "v2 [52], and DROID [23]. The robots and tasks in these datasets",
    "typically have one or two cameras and use low frequency control,",
    "between 2 and 10 Hz. However, these datasets cover a wide range",
    "of objects and environments. To learn dexterous behaviours we also",
    "use timesteps of data from our own datasets, where 106 of them are",
    "from single-arm robots and 797M are from dual-arm robots in total.",
    "This data has 68 tasks, where each task is composed of behaviors",
    "and a wide range of different dishes, cups, and utensils appear.",
)


def test_prose_in_the_other_column_does_not_bound_a_figure() -> None:
    """PiZero.pdf p6 puts Fig. 5 in the right column and body text in the left.

    Page order is a single sequence in y, so the first line the walk meets above the
    caption is left-column prose: it bounded the walk on its first step and the two rows
    of robot names over the figure were read aloud verbatim -- "Bimanual UR5e Bimanual
    Trossen Bimanual ARX". Prose in the other column is neither this figure's boundary
    nor its interior. The region here is exactly two lines, which is also why a figure
    interior may be shorter than three.
    """
    lines = [
        *[mk_line(i, text, 66.0 + 12.0 * i, x0=LEFT_COL, x1=LEFT_EDGE)
          for i, text in enumerate(PROSE)],
        mk_line(8, "Bimanual UR5e Bimanual Trossen Bimanual ARX", 127.6,
                x0=346.1, x1=574.8, size=BODY * 0.53),
        mk_line(9, "UR5e Franka Mobile Trossen Mobile Fibocom", 210.8,
                x0=343.8, x1=596.5, size=BODY * 0.53),
        mk_line(10, "Fig. 5: The robots used in our experiments.", 236.4,
                x0=RIGHT_COL, x1=RIGHT_EDGE),
        mk_line(11, "They include single and dual-arm manipulators with 6-DoF arms.",
                248.4, x0=RIGHT_COL, x1=RIGHT_EDGE),
    ]

    blocks = classify_page(mk_page(6, lines), compute_doc_stats([mk_page(6, lines)]))

    assert {block_for(blocks, i).kind for i in (8, 9)} == {"figure"}
    assert all(block_for(blocks, i).speak for i in range(8))


def test_a_figure_wider_than_its_caption_keeps_its_far_half() -> None:
    """PiZero.pdf p4 sets `Fig. 3:` across 49-219 and the diagram over it across 58-524.

    The x-band decides only what may *bound* the walk, never what it may absorb: gating
    absorption on the band too leaves the far half of the diagram spoken, which on a
    figure whose font carries no ToUnicode map is six blocks of glyph soup.
    """
    labels = (
        (76.1, 106.8), (232.6, 274.3), (206.4, 303.9),
        (403.2, 450.1), (482.6, 524.4), (378.2, 520.9),
    )
    lines = [
        *[mk_line(i, "kp", 85.0 + 14.0 * i, x0=x0, x1=x1, size=BODY * 0.58)
          for i, (x0, x1) in enumerate(labels)],
        mk_line(6, "Fig. 3: Overview of our framework.", 211.8,
                x0=LEFT_COL, x1=218.5),
        *[mk_line(7 + i, text, 295.5 + 12.0 * i, x0=LEFT_COL, x1=LEFT_EDGE)
          for i, text in enumerate(PROSE)],
    ]

    blocks = classify_page(mk_page(4, lines), compute_doc_stats([mk_page(4, lines)]))

    assert {block_for(blocks, i).kind for i in range(6)} == {"figure"}
    assert all(block_for(blocks, i).speak for i in range(7, 15))


IEEE_CAPTION = 7.0     # IEEE Access sets its captions well below its 10pt body


def test_a_caption_set_smaller_than_the_body_still_claims_the_labels_above_it() -> None:
    """Type between the caption's size and the body's is the figure's, not the page's.

    Flooring the walk at the caption's own size reads every label a figure sets larger
    than its caption -- and a journal that sets captions at 7pt against a 10pt body sets
    almost all of them larger. The floor that matters is the body's: type below it, in a
    figure's band, is the figure's.
    """
    labels = ((0, 7.5), (1, 9.0), (2, 8.0), (3, 8.9))
    lines = [
        *[mk_line(i, "Bimanual UR5e Bimanual Trossen", 80.0 + 20.0 * i,
                  x0=120.0, x1=320.0, size=size)
          for i, size in labels],
        mk_line(4, "Fig. 6: The robots used in our experiments.", 170.0,
                size=IEEE_CAPTION),
        *[mk_line(5 + i, text, 220.0 + 12.0 * i)
          for i, text in enumerate(PROSE)],
    ]

    blocks = classify_page(mk_page(3, lines), compute_doc_stats([mk_page(3, lines)]))

    assert {block_for(blocks, i).kind for i, _ in labels} == {"figure"}
    assert {block_for(blocks, i).kind for i in range(5, 13)} == {"body"}


def test_a_diagram_whose_labels_are_all_body_sized_is_not_trimmed_away() -> None:
    """VLALitReview.pdf p8 sets every label in its diagram at the body's own 10pt.

    The trailing-size trim exists to hand back a stub heading or a short equation the
    walk overran -- text that is figure text only when figure text follows it. When
    *nothing* in the region is sub-body type there is no figure text for it to follow,
    the rule has nothing to say, and trimming on size alone empties the region and reads
    the diagram aloud ("(2) Latent action generation").
    """
    labels = ("World Model", "Inverse Dynamics", "Latent Action",
              "(1) Action generation", "in world models")
    lines = [
        *[mk_line(i, text, 80.0 + 16.0 * i, x0=100.0, x1=190.0)
          for i, text in enumerate(labels)],
        mk_line(5, "Fig. 5: Design patterns for incorporating world models.", 175.0,
                size=IEEE_CAPTION),
        *[mk_line(6 + i, text, 220.0 + 12.0 * i)
          for i, text in enumerate(PROSE)],
    ]

    blocks = classify_page(mk_page(8, lines), compute_doc_stats([mk_page(8, lines)]))

    assert {block_for(blocks, i).kind for i in range(5)} == {"figure"}
    assert {block_for(blocks, i).kind for i in range(6, 14)} == {"body"}


# ── Unmarked notes at the foot of the page ────────────────────────────────────
# `_starts_footnote` requires a typographic marker. An affiliation or correspondence
# block carries none -- PiZero.pdf p1 ends "Physical Intelligence, San Francisco,
# California, USA. Correspondance to: research@physicalintelligence.company", which is
# read aloud in full. It is not repeated on any other page, so the furniture rules
# cannot see it either.


def test_an_unmarked_note_set_off_at_the_foot_of_the_page_is_not_spoken() -> None:
    body = [mk_line(i, "as well as to address some of the deepest questions in AI.",
                    600.0 + 10.0 * i) for i in range(6)]
    lines = [
        *body,
        mk_line(6, "Physical Intelligence, San Francisco, California, USA.",
                680.0, size=SMALL, x1=300.0),
        mk_line(7, "Correspondance to: research@physicalintelligence.company",
                690.0, size=SMALL, x1=226.0),
    ]

    blocks = classify_page(mk_page(1, lines), compute_doc_stats([mk_page(1, lines)]))

    assert block_for(blocks, 6).kind == "footnote"
    assert block_for(blocks, 7).kind == "footnote"


GUTTER_L, GUTTER_R = 300.0, 312.0
COLUMN_PROSE = "as well as to address some of the deepest questions in AI."


def _two_column_note_page(below: Sequence[Line] = ()) -> list[Line]:
    """PiZero p1 under column ordering (J8): the left column ends in the affiliation
    note, then the right column -- ending higher -- is read after it."""
    left = [mk_line(i, COLUMN_PROSE, 600.0 + 10.0 * i, x1=GUTTER_L) for i in range(6)]
    note = [
        mk_line(6, "Physical Intelligence, San Francisco, California, USA.",
                680.0, size=SMALL, x1=GUTTER_L),
        mk_line(7, "Correspondance to: research@physicalintelligence.company",
                690.0, size=SMALL, x1=226.0),
    ]
    right = [mk_line(8 + i, COLUMN_PROSE, 600.0 + 10.0 * i, x0=GUTTER_R) for i in range(6)]
    return [*left, *note, *right, *below]


def test_an_unmarked_note_at_the_foot_of_the_left_column_is_not_spoken() -> None:
    """J8: the note is the lowest text on the page, but column ordering reads the right
    column after it, so it is not the page's last line in reading order."""
    lines = _two_column_note_page()

    blocks = classify_page(mk_page(1, lines), compute_doc_stats([mk_page(1, lines)]))

    assert block_for(blocks, 6).kind == "footnote"
    assert block_for(blocks, 7).kind == "footnote"
    assert block_for(blocks, 13).kind == "body"


@pytest.mark.parametrize("below", [
    mk_line(14, COLUMN_PROSE, 715.0, x1=GUTTER_L),
    mk_line(14, "VOLUME 11, 2023", 744.0, x0=490.0, size=SMALL),
    mk_line(14, "16", 744.0, x0=36.0, x1=44.0, size=SMALL),
    mk_line(14, COLUMN_PROSE, 702.0, x0=GUTTER_R),
], ids=["own-column-continues", "footer-in-another-column", "page-number",
        "other-column-just-below"])
def test_small_type_with_text_lower_on_the_page_is_still_spoken(below) -> None:
    """The guard J8 keeps: a note runs to the bottom of the page. Anything lower --
    even a footer clear of its column, as under VLALitReview p16's stranded `VI.
    DATASETS` heading -- says the small type is not hanging off the foot."""
    lines = _two_column_note_page([below])

    blocks = classify_page(mk_page(1, lines), compute_doc_stats([mk_page(1, lines)]))

    assert block_for(blocks, 6).kind != "footnote"
    assert block_for(blocks, 7).kind != "footnote"
    if below.text == "16":  # tagged first, as on the corpus: it still counts as lower
        assert block_for(blocks, 14).kind == "pagenum"


def test_the_last_paragraph_of_a_page_is_still_spoken() -> None:
    """The guard on the unmarked-note rule: ordinary body text runs to the page foot
    with ordinary leading, and dropping it loses a real sentence on every page."""
    lines = [mk_line(i, "as well as to address some of the deepest questions in AI.",
                     600.0 + 10.0 * i) for i in range(9)]

    blocks = classify_page(mk_page(1, lines), compute_doc_stats([mk_page(1, lines)]))

    assert block_for(blocks, 8).kind == "body"
