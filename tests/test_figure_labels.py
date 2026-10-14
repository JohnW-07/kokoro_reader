"""U19 round 2: a figure's labels are not a byline, and do not run into the prose beside them.

N3 read a centred run of plain words as a byline, not display math. Past the title page
that also took figure labels ("per hour", "Video World"), which then joined the body block
next to them and were read aloud. A label set beside a column (iVideoGPT p7 "Enc") joined
the prose line below it once U17d read that line as prose. Real `pdfview` lines, one item each.
"""

from __future__ import annotations

from dataclasses import replace
from typing import Iterable, Sequence

import pytest

from kokoro_reader.textpipe import classify
from kokoro_reader.textpipe.classify import classify_page
from kokoro_reader.textpipe.types import Block, DocStats, Line, PageGeometry

from .test_set_prose import A4_H, A4_W, LETTER_H, LETTER_W, page

PI0_6_P9 = (
    (0, "Fig. 7: Throughput. We show the number of successfully completed tasks", 49.0, 297.2, 200.6, 8.0, "g_d4_f4"),
    (1, "per hour", 300.2, 328.9, 200.6, 8.0, "g_d4_f6"),
    (2, "Error bars show standard error. This metric measures both success and speed. In all cases, RECAP applied to π∗/0.6 (Ours) leads to substantial improvements", 49.0, 563.0, 209.5, 8.0, "g_d4_f4"),
    (3, "in throughput. RECAP has the highest impact on throughput for diverse laundry and espresso tasks, more than doubling successful completions per hour.", 49.0, 551.6, 218.5, 8.0, "g_d4_f4"),
    (4, "Fig. 8: Success rates. We show the absolute success rates with standard error. Each stage of RECAP improves performance across the tasks, with the challenging", 49.0, 563.0, 361.1, 8.0, "g_d4_f4"),
)

COSMOS_P54 = (
    (1, "Video", 356.8, 379.6, 107.7, 9.7, "g_d0_f53"),
    (2, "World", 281.4, 305.5, 113.5, 9.7, "g_d0_f53"),
    (3, "WFM Keyword Content Face WFM", 70.4, 519.4, 119.4, 9.7, "g_d0_f53"),
    (4, "Aegis Foundation", 208.1, 315.9, 125.6, 9.7, "g_d0_f53"),
    (5, "Inputs Blocking Safety Blur Outputs", 68.7, 524.8, 131.5, 9.7, "g_d0_f53"),
    (6, "Model", 280.6, 306.2, 136.9, 9.7, "g_d0_f53"),
)

COSMOS_P11 = (
    (21, "input.", 62.4, 88.1, 401.8, 10.0, "g_d0_f3"),
    (22, "Input Token Token Reconstructed", 78.5, 512.9, 455.6, 9.7, "g_d0_f17"),
    (23, "Encoder Tokens Decoder", 175.7, 398.3, 466.2, 9.7, "g_d0_f17"),
    (24, "Video Video", 77.6, 495.9, 467.2, 9.7, "g_d0_f17"),
    (25, "Figure 6: Video tokenization pipeline. An input video is encoded into tokens, which are usually much more", 62.4, 532.9, 537.7, 10.0, "g_d0_f3"),
    (26, "compact than the input video. The decoder then reconstructs the input video from the tokens. Tokenizer", 62.4, 533.1, 549.7, 10.0, "g_d0_f3"),
)

IVIDEOGPT_P7 = (
    (48, "nipulation tasks of varying difficulty from Meta-", 108.0, 317.5, 611.7, 10.0, "g_d10_f6"),
    (52, "method adapted from MBPO [42], which augments ^MBPO", 108.0, 354.6, 644.5, 10.0, "g_d10_f6"),
    (53, "Enc", 431.1, 438.6, 653.4, 7.5, "g_d10_f37"),
    (54, "the replay buffer with synthetic rollouts to train a stan- ^(ours) Env", 108.0, 377.2, 655.3, 10.0, "g_d10_f6"),
    (55, "dard actor-critic RL algorithm (see Appendix A.5 for _iVideoGPT 𝒟 ^𝜋 𝑣", 108.0, 486.4, 662.2, 10.0, "g_d10_f6"),
    (56, "the pseudo-code). Our implementation builds upon _World model rollouts Standard model-free RL", 108.0, 496.4, 680.8, 10.0, "g_d10_f6"),
)


def block_of(blocks: Sequence[Block], idx: int) -> Block:
    return next(b for b in blocks if idx in b.line_ids)


def apart(blocks: Sequence[Block], a: int, b: int) -> bool:
    return b not in block_of(blocks, a).line_ids


def test_an_axis_label_does_not_run_into_the_caption_under_it() -> None:
    blocks = classify_page(page(9, PI0_6_P9, LETTER_W, LETTER_H), DocStats(body_size=10.0, num_pages=18))

    assert apart(blocks, 1, 2)
    assert block_of(blocks, 2).text.startswith("Error bars show standard error.")


def test_diagram_labels_past_the_title_page_are_not_a_byline() -> None:
    stats = DocStats(body_size=10.0, num_pages=75)

    p54 = classify_page(page(54, COSMOS_P54, A4_W, A4_H), stats)
    p11 = classify_page(page(11, COSMOS_P11, A4_W, A4_H), stats)

    assert apart(p54, 2, 3) and apart(p54, 4, 5)
    assert apart(p11, 23, 24)


def test_a_label_beside_the_column_does_not_join_the_prose_below_it() -> None:
    blocks = classify_page(page(7, IVIDEOGPT_P7, LETTER_W, LETTER_H), DocStats(body_size=10.0, num_pages=31))

    assert apart(blocks, 53, 54)
    prose = block_of(blocks, 54)
    assert prose.kind == "body" and 55 in prose.line_ids  # "stan- dard" still reads on (U17d)


def test_a_title_right_of_the_next_line_but_above_it_is_not_a_label() -> None:
    """A guard: PI0_6 p16 sets "APPENDIX" right of "A. Contributions", a full line below it."""
    geom = page(16, (
        (23, "APPENDIX", 152.3, 196.6, 353.1, 8.0, "g_d4_f4"),
        (24, "A. Contributions", 49.0, 117.7, 370.3, 10.0, "g_d4_f6"),
        (25, "Data collection and operations. Michael Equi, Chelsea Finn,", 49.0, 300.0, 386.6, 10.0, "g_d4_f5"),
    ), LETTER_W, LETTER_H)
    ctx = classify._Ctx.build(geom, DocStats(body_size=10.0, num_pages=18))
    appendix, contributions = geom.lines[0], geom.lines[1]

    assert classify._breaks_paragraph(appendix, contributions, ctx) is False


COSMOS_P52 = (
    (3, "Method FID ↓ FVD ↓ TSE ↓ CSE ↓", 207.3, 500.7, 135.7, 10.0, "g_d0_f3"),
    (4, "VideoLDM-MultiView 60.84 884.46 1.24 6.48", 147.8, 497.7, 152.6, 10.0, "g_d0_f3"),
    (5, "Cosmos-Predict1-7B-Text2World-", 97.5, 240.8, 169.6, 10.0, "g_d0_f3"),
    (6, "32.16 210.23 0.68 2.11", 278.6, 497.7, 175.7, 10.0, "g_d0_f2"),
    (7, "Sample-MultiView", 161.1, 240.8, 181.5, 10.0, "g_d0_f3"),
    (8, "Cosmos-Predict1-7B-Text2World-", 97.5, 240.8, 198.5, 10.0, "g_d0_f3"),
    (9, "- - 0.59 2.02", 290.1, 498.1, 204.6, 10.0, "g_d0_f2"),
    (10, "Sample-MultiView-TrajectoryCond", 91.6, 240.8, 210.4, 10.0, "g_d0_f3"),
    (11, "Real Videos (Reference) - - 0.69 1.71", 137.3, 497.7, 227.4, 10.0, "g_d0_f3"),
    (12, "Table 25: Trajectory consistency evaluation on post-trained multi-view world models for multi-view driving", 66.4, 528.6, 253.8, 10.0, "g_d0_f3"),
)


def test_a_cell_the_same_size_as_the_line_beside_it_is_not_a_label() -> None:
    """The beside break's size guard (U31): a figure label is smaller than the line it sits by.

    Cosmos p52 sets a row's numbers right of the second line of its wrapped name, at the same
    size. Without the guard the numbers split off alone and are silenced as unspeakable.
    """
    blocks = classify_page(page(52, COSMOS_P52, A4_W, A4_H), DocStats(body_size=10.0, num_pages=75))

    assert 7 in block_of(blocks, 6).line_ids
    assert 10 in block_of(blocks, 9).line_ids


#: PSI_Paper.pdf p28: a figure's row labels are set turned 90° (L15, L17, L19). At 14.7pt
#: they passed as headings. `pdfview` flags a turned line (`pagegeom.buildLine`).
PSI_P28 = (
    (11, "In our bowling example, conditioning on two ground-truth frames yields a factual prediction that closely matches", 54.0, 558.0, 242.6, 10.9, "g_d5_f4"),
    (12, "the true next frame—the ball strikes the pin and the pin topples—demonstrating that Ψ captures contact physics,", 54.0, 558.0, 256.2, 10.9, "g_d5_f4"),
    (13, "while the same mechanism supports counterfactual edits that redirect the ball and prevent the pins from falling.", 54.0, 558.0, 269.7, 10.9, "g_d5_f4"),
    (14, "GT frame 0 GT frame 1 GT frame 2", 144.9, 499.7, 291.7, 14.7, "g_d5_f74"),
    (15, "Factual", 103.2, 117.9, 330.7, 14.7, "g_d5_f73"),
    (16, "GT frame 0 GT frame 1 Predicted frame 2", 145.1, 518.2, 432.7, 14.7, "g_d5_f74"),
    (17, "Hypothetical", 103.6, 118.3, 449.3, 14.7, "g_d5_f73"),
    (18, "GT frame 0 Counterfactual frame 1 Predicted frame 2", 145.1, 523.4, 578.0, 14.7, "g_d5_f74"),
    (19, "Counterfactual", 106.0, 120.7, 586.1, 14.7, "g_d5_f73"),
    (20, "move ball", 175.7, 213.5, 699.4, 9.8, "g_d5_f74"),
    (21, "Intervene, then recompute the future. With a localized edit (we translate the ball mid-trajectory in the last", 54.0, 558.0, 731.4, 10.9, "g_d5_f4"),
    (22, "context frame), PSI produces a counterfactual where the ball misses, so no force is transferred and the pins", 54.0, 558.0, 744.9, 10.9, "g_d5_f4"),
)


BODY = "the quick brown fox jumps over the lazy dog and keeps running along the long river bank"
UPRIGHT_BODY = tuple((i, BODY, 72.0, 540.0, 100.0 + 12 * i, 10.0, "g_d0_f1") for i in range(6))
SYNTHETIC = DocStats(body_size=10.0, num_pages=20)


def turned(geom: PageGeometry, ids: Iterable[int]) -> PageGeometry:
    """`geom` with the lines `ids` set 90° to the page, as `pdfview` flags them."""
    ids = frozenset(ids)
    return replace(geom, lines=tuple(replace(line, turned=line.idx in ids) for line in geom.lines))


def test_a_sideways_label_is_figure_text_not_a_heading() -> None:
    geom = turned(page(28, PSI_P28, LETTER_W, LETTER_H), (15, 17, 19))
    blocks = classify_page(geom, DocStats(body_size=10.9, num_pages=42))

    assert [block_of(blocks, i).kind for i in (15, 17, 19)] == ["figure"] * 3
    assert block_of(blocks, 21).kind == "body" and 22 in block_of(blocks, 21).line_ids


def test_the_turned_flag_comes_over_the_wire() -> None:
    assert Line.from_json({"idx": 0, "turned": True}).turned
    assert not Line.from_json({"idx": 0}).turned  # an older client sends no flag
    assert not any(Line.from_json({"idx": 0, "turned": v}).turned for v in ("false", 1, "true"))


def upright_with(label: tuple) -> PageGeometry:
    rows = (*UPRIGHT_BODY, label, (7, BODY, 72.0, 540.0, 206.0, 10.0, "g_d0_f1"))
    return page(5, rows, LETTER_W, LETTER_H)


def test_an_upright_numeral_one_em_wide_is_still_a_heading() -> None:
    """"III" in Times is 0.999 em wide, the box of a turned label, but it is set upright."""
    blocks = classify_page(upright_with((6, "III", 72.0, 84.0, 190.0, 12.0, "Bold")), SYNTHETIC)

    assert block_of(blocks, 6).kind == "heading"


def test_a_zero_width_line_is_not_sideways() -> None:
    blocks = classify_page(upright_with((6, "III", 72.0, 72.0, 190.0, 12.0, "Bold")), SYNTHETIC)

    assert block_of(blocks, 6).kind == "heading"


def turned_prose(ids: Iterable[int], x0: float = 100.0) -> tuple:
    """Turned lines of prose one pitch apart across the page, each one em wide."""
    return tuple((i, "we train the policy with the same recipe as before and report", x0 + 12 * n,
                  x0 + 10 + 12 * n, 300.0 + (n % 2) * 40, 10.0, "g_d0_f1") for n, i in enumerate(ids))


def kinds(rows: tuple, turned_ids: Iterable[int], ids: Iterable[int]) -> list[str]:
    blocks = classify_page(turned(page(5, rows, LETTER_W, LETTER_H), turned_ids), SYNTHETIC)
    return [block_of(blocks, i).kind for i in ids]


def test_a_landscape_page_is_prose_not_figure_labels() -> None:
    """A page set sideways (a landscape appendix) turns its prose, not only its labels."""
    rows = (*turned_prose(range(5)), (5, "17", 300.0, 310.0, 760.0, 10.0, "g_d0_f1"))

    assert kinds(rows, range(5), range(5)) == ["body"] * 5


UPRIGHT_FILLER = {
    "furniture": ((3, "17", 300.0, 310.0, 760.0, 10.0, "g_d0_f1"),
                  (4, "Preprint. Under review.", 72.0, 200.0, 30.0, 8.0, "g_d0_f1"),
                  (5, "arXiv:2410.24164v4 [cs.LG] 8 Jan 2026", 20.0, 200.0, 400.0, 10.0, "g_d0_f1")),
    "empty": tuple((i, "", 72.0, 540.0, 200.0 + 100 * i, 10.0, "g_d0_f1") for i in (3, 4, 5)),
}


@pytest.mark.parametrize("filler", sorted(UPRIGHT_FILLER))
def test_a_landscape_page_is_judged_by_its_text_not_its_furniture_or_blank_lines(filler: str) -> None:
    """The page number, a stamp and blank lines stay upright on a turned page: they do not vote."""
    rows = (*turned_prose(range(3)), *UPRIGHT_FILLER[filler])

    assert kinds(rows, range(3), range(3)) == ["body"] * 3


def test_one_turned_line_in_two_is_a_label_on_an_upright_page() -> None:
    rows = ((0, BODY, 72.0, 540.0, 300.0, 10.0, "g_d0_f1"), (1, "Accuracy", 300.0, 310.0, 400.0, 10.0, "g_d0_f1"))

    assert kinds(rows, (1,), (1,)) == ["figure"]


def test_a_landscape_pages_caption_counts_toward_its_orientation() -> None:
    """Lines already tagged still vote: a turned caption is turned text on a turned page."""
    rows = (*turned_prose((0, 1)),
            (2, BODY, 72.0, 540.0, 500.0, 10.0, "g_d0_f1"), (3, BODY, 72.0, 540.0, 512.0, 10.0, "g_d0_f1"),
            (4, "Table 3: Hyperparameters used in all experiments, grouped by", 400.0, 410.0, 300.0, 10.0, "g_d0_f1"),
            (5, "stage of training and by the size of the model.", 412.0, 422.0, 330.0, 10.0, "g_d0_f1"))

    assert kinds(rows, (0, 1, 4, 5), (0, 1)) == ["body"] * 2


TURNED_CAPTION = (6, "Figure 4: Success rate of each policy over training.", 300.0, 310.0, 200.0, 10.0, "g_d0_f1")
LOWER_BODY = tuple((9 + i, BODY, 72.0, 540.0, 420.0 + 12 * i, 10.0, "g_d0_f1") for i in range(6))


def caption_page(after: tuple, upright: Iterable[int] = ()) -> tuple[Block, ...]:
    """Upright prose, a turned caption, the lines `after` it (turned unless `upright`), more prose."""
    rows = (*UPRIGHT_BODY, TURNED_CAPTION, *after, *LOWER_BODY)
    ids = [6, *(row[0] for row in after if row[0] not in upright)]
    return classify_page(turned(page(5, rows, LETTER_W, LETTER_H), ids), SYNTHETIC)


@pytest.mark.parametrize("x0", [312.0, 318.0])  # 1.2 em, and 1.8 em (1.5 line spacing)
def test_a_turned_caption_keeps_its_wrapped_line(x0: float) -> None:
    blocks = caption_page(((7, "stage of training and by the size of the model.", x0, x0 + 10, 280.0, 10.0, "g_d0_f1"),
                           (8, BODY, 310.0, 540.0, 400.0, 10.0, "g_d0_f1")), upright=(8,))
    caption = block_of(blocks, 6)

    assert caption.kind == "caption" and 7 in caption.line_ids
    assert 8 not in caption.line_ids  # an upright line is never a turned caption's wrap


def test_a_turned_caption_steps_one_pitch_per_line_not_from_its_head() -> None:
    blocks = caption_page(((7, "stage of training and by the size of the model.", 312.0, 322.0, 280.0, 10.0, "g_d0_f1"),
                           (8, "Shaded bands are one standard deviation.", 324.0, 334.0, 260.0, 10.0, "g_d0_f1")))

    assert block_of(blocks, 6).line_ids == (6, 7, 8)


AFTER_A_TURNED_CAPTION = {
    # J6 round 2: a 10pt turned caption swallowed the 7pt axis labels after it; they were read.
    "axis labels": ((7, "Success Rate (%)", 330.0, 337.0, 240.0, 7.0, "g_d0_f1"),
                    (8, "Training steps (k)", 420.0, 427.0, 300.0, 7.0, "g_d0_f1")),
    "smaller type one pitch off": ((7, "Success Rate (%)", 312.0, 319.0, 240.0, 7.0, "g_d0_f1"),),
    # MaskViT sets 9.2pt labels under its 10pt captions.
    "0.8pt smaller type one pitch off": ((7, "Success Rate (%)", 312.0, 321.2, 240.0, 9.2, "g_d0_f1"),),
    "same type three ems off": ((7, "Training steps (k)", 340.0, 350.0, 300.0, 10.0, "g_d0_f1"),),
    "same type 2.2 ems off": ((7, "Training steps (k)", 322.0, 332.0, 300.0, 10.0, "g_d0_f1"),),
}


@pytest.mark.parametrize("case", sorted(AFTER_A_TURNED_CAPTION))
def test_the_labels_after_a_turned_caption_stay_figure_text(case: str) -> None:
    blocks = caption_page(AFTER_A_TURNED_CAPTION[case])

    assert block_of(blocks, 6).kind == "caption" and block_of(blocks, 7).kind == "figure"


# J6 round 3: landtab.pdf p4, a landscape table in 9pt under a two-line 10pt turned caption.
LANDTAB_P4 = (
    (0, "AdamW", 194.0, 203.0, 291.5, 9.0, "g_d0_f1"),
    (1, "3e-4 512 2000", 134.0, 167.0, 306.0, 9.0, "g_d0_f1"),
    (2, "0.1 0.0", 170.0, 191.0, 310.8, 9.0, "g_d0_f1"),
    (3, "", 134.0, 203.0, 322.0, 9.0, "g_d0_f1"),
    (4, "Table 3: Hyperparameters used in all of our experiments, grouped by", 100.0, 110.0, 365.7, 10.0, "g_d0_f1"),
    (5, "stage of training and by the size of the model in parameters.", 112.0, 122.0, 402.6, 10.0, "g_d0_f1"),
    (6, "AdamW", 194.0, 203.0, 451.5, 9.0, "g_d0_f1"),
    (7, "1e-4 256 1000 0.05", 134.0, 179.0, 466.1, 9.0, "g_d0_f1"),
    (8, "0.1", 182.0, 191.0, 470.8, 9.0, "g_d0_f1"),
    (9, "", 134.0, 203.0, 482.0, 9.0, "g_d0_f1"),
    (10, "warmup steps weight decay", 158.0, 179.0, 593.3, 9.0, "g_d0_f1"),
    (11, "learning rate", 134.0, 143.0, 596.8, 9.0, "g_d0_f1"),
    (12, "batch size optimizer", 146.0, 203.0, 606.9, 9.0, "g_d0_f1"),
    (13, "dropout", 182.0, 191.0, 614.0, 9.0, "g_d0_f1"),
    (14, "4", 300.0, 305.0, 752.0, 10.0, "g_d0_f1"),
)


def test_a_two_line_turned_caption_still_finds_its_table_on_both_sides() -> None:
    """Above and below mean nothing to turned lines: a wrapped turned caption walks both ways."""
    geom = turned(page(4, LANDTAB_P4, LETTER_W, LETTER_H), range(14))
    blocks = classify_page(geom, DocStats(body_size=10.0, num_pages=6))

    assert block_of(blocks, 4).kind == "caption" and block_of(blocks, 4).line_ids == (4, 5)
    assert [block_of(blocks, i).kind for i in (0, 1, 2, 6, 7, 8, 10, 11, 12, 13)] == ["figure"] * 10
