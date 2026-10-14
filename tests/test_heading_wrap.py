"""U12 (D4): a heading set over two or more lines is one heading and one sentence.

The first fixtures are the real `pdfview.buildPageGeometry` lines of GR00TN1.pdf p1 (the
title wraps flush left), MaskViT.pdf p1 (it wraps centred) and GR00TN1.pdf p19 (a running
head over two stacked section headings), trimmed to the lines the rule looks at. Before
U12 the GR00T title was read "...for Generalist." / "Humanoid Robots." -- a false stop in
the voice, and a bogus "Humanoid Robots" section in the notes' section view.
"""

from __future__ import annotations

from dataclasses import replace

import pytest

from kokoro_reader.config import ReadOptions
from kokoro_reader.textpipe import pipeline
from kokoro_reader.textpipe.classify import classify_page
from kokoro_reader.textpipe.headwrap import heading_runs
from kokoro_reader.textpipe.types import Block, DocStats, Line, PageGeometry

from .test_classify import BOLD_FONT, mk_line, mk_page

GROOT_TITLE = "GR00T N1: An Open Foundation Model for Generalist Humanoid Robots"
GROOT_STATS = DocStats(
    body_size=10.0, num_pages=36, repeated_y=frozenset({62, 794}),
    repeated=frozenset({"gr#t n# an open foundation model for generalist humanoid robots", "#"}),
)
A4_W, A4_H = 595.276, 841.89
TITLE_SIZE = 17.0


def real(idx, text, x0, x1, y, size, font, items, item_x, item_text, item_size) -> Line:
    """One line exactly as the client sent it (see the module docstring)."""
    return Line(idx=idx, text=text, x0=x0, x1=x1, y=y, size=size, font=font,
                items=tuple(items), item_x=tuple(item_x), item_text=tuple(item_text),
                item_size=tuple(item_size))


def groot_p1() -> PageGeometry:
    lines = (
        real(0, "2025-3-28", 494.039, 530.144, 61.528, 8, "g_d1_f1",
             [0], [494.039], ["2025-3-28"], [7.9701]),
        real(1, "GR00T N1: An Open Foundation Model for Generalist", 62.362, 481.252, 97.767,
             16.9, "g_d1_f2", [2], [62.362],
             ["GR00T N1: An Open Foundation Model for Generalist"], [16.9365]),
        real(2, "Humanoid Robots", 62.362, 203.054, 120.681, 16.9, "g_d1_f2",
             [3], [62.362], ["Humanoid Robots"], [16.9365]),
        real(3, "NVIDIA^1", 62.362, 96.486, 151.503, 9, "g_d1_f2",
             [5, 6], [62.362, 93.162], ["NVIDIA", "^1"], [8.9664, 5.9776]),
        real(4, "Abstract", 61.935, 111.565, 193.956, 13, "g_d1_f2",
             [8], [61.935], ["Abstract"], [12.9514]),
        real(5, "General-purpose robots need a versatile body and an intelligent mind. "
                "Recent advancements in humanoid", 62.013, 532.909, 214.47, 10, "g_d1_f2",
             [10], [62.013], ["General-purpose robots need a versatile body and an intelligent "
                              "mind. Recent advancements in humanoid"], [9.9626]),
        real(6, "robots have shown great promise as a hardware platform for building "
                "generalist autonomy in the human", 62.362, 532.916, 228.816, 10, "g_d1_f2",
             [11], [62.362], ["robots have shown great promise as a hardware platform for "
                              "building generalist autonomy in the human"], [9.9626]),
        real(7, "world. A robot foundation model, trained on massive and diverse data sources, "
                "is essential for enabling", 61.964, 532.910, 243.162, 10, "g_d1_f2",
             [12], [61.964], ["world. A robot foundation model, trained on massive and "
                              "diverse data sources, is essential for enabling"], [9.9626]),
    )
    return PageGeometry(page=1, width=A4_W, height=A4_H, lines=lines)


def maskvit_p1() -> PageGeometry:
    lines = (
        real(0, "MaskViT: Masked Visual Pre-Training", 162.373, 449.629, 96.541, 17.2,
             "g_d3_f1", [0], [162.373], ["MaskViT: Masked Visual Pre-Training"], [17.2154]),
        real(1, "for Video Prediction", 231.621, 380.379, 118.061, 17.2, "g_d3_f1",
             [1], [231.621], ["for Video Prediction"], [17.2154]),
        real(2, "Agrim Gupta^1 Stephen Tian^1 Yunzhi Zhang^1 Jiajun Wu^1", 138.283, 475.710,
             145.15, 10, "g_d3_f1", [3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13],
             [138.283, 195.568, 199.540, 233.807, 290.374, 294.346, 328.613, 388.877,
              392.849, 427.116, 471.738],
             ["Agrim Gupta", "^1", " ", "Stephen Tian", "^1", " ", "Yunzhi Zhang", "^1", " ",
              "Jiajun Wu", "^1"],
             [9.9626, 6.9738, 6.9738, 9.9626, 6.9738, 6.9738, 9.9626, 6.9738, 6.9738,
              9.9626, 6.9738]),
        real(6, "Abstract: The ability to predict future visual observations conditioned on past",
             143.865, 468.131, 247.098, 10, "g_d3_f4", [32], [143.865],
             ["Abstract: The ability to predict future visual observations conditioned on past"],
             [9.9626]),
    )
    return PageGeometry(page=1, width=612.0, height=792.0, lines=lines)


def groot_p19() -> PageGeometry:
    lines = (
        real(0, GROOT_TITLE, 171.848, 423.145, 62.126, 8, "g_d1_f3",
             [0], [171.848], [GROOT_TITLE], [7.9701]),
        real(1, "A. Contributors and Acknowledgments", 62.362, 295.772, 96.267, 13,
             "g_d1_f2", [2], [62.362], ["A. Contributors and Acknowledgments"], [12.9514]),
        real(2, "A.1. Core Contributors", 62.362, 189.266, 117.288, 12, "g_d1_f2",
             [4], [62.362], ["A.1. Core Contributors"], [11.9552]),
        real(3, "Model Training", 62.362, 133.236, 134.713, 10, "g_d1_f2",
             [6], [62.362], ["Model Training"], [9.9626]),
        real(4, "Scott Reed, Ruijie Zheng, Guanzhi Wang, Johan Bjorck, Joel Jang, Ao Zhang, "
                "Jing Wang, Yinzhen Xu, Fengyuan", 62.362, 532.916, 148.461, 10, "g_d1_f3",
             [8], [62.362], ["Scott Reed, Ruijie Zheng, Guanzhi Wang, Johan Bjorck, Joel "
                             "Jang, Ao Zhang, Jing Wang, Yinzhen Xu, Fengyuan"], [9.9626]),
        real(5, "Hu, Seonghyeon Ye, Zongyu Lin, Jiannan Xiang, Loic Magne, Zhiding Yu, "
                "Zhiqi Li", 62.362, 415.576, 162.21, 10, "g_d1_f3",
             [9], [62.362], ["Hu, Seonghyeon Ye, Zongyu Lin, Jiannan Xiang, Loic Magne, "
                             "Zhiding Yu, Zhiqi Li"], [9.9626]),
    )
    return PageGeometry(page=19, width=A4_W, height=A4_H, lines=lines)


def headings(blocks: tuple[Block, ...]) -> list[str]:
    return [b.text for b in blocks if b.kind == "heading"]


def title_page(*titles: tuple[str, float, float], size: float = TITLE_SIZE) -> PageGeometry:
    """Bold heading lines `(text, y, x0)` over one body line, as a synthetic page."""
    lines = [mk_line(i, text, y, x0=x0, x1=x0 + len(text) * size * 0.5, size=size,
                     font=BOLD_FONT) for i, (text, y, x0) in enumerate(titles)]
    body = mk_line(len(lines), "We describe the method and the experiments in the sections below",
                   titles[-1][1] + 3 * size)
    return mk_page(1, [*lines, body])


# ── The defect ────────────────────────────────────────────────────────────────


def test_a_title_wrapped_flush_left_is_one_heading() -> None:
    blocks = classify_page(groot_p1(), GROOT_STATS)

    title = next(b for b in blocks if b.kind == "heading")
    assert title.text == GROOT_TITLE
    assert title.line_ids == (1, 2)
    assert title.items == (2, 3)


def test_a_wrapped_title_is_one_spoken_sentence_carrying_the_whole_title() -> None:
    sentences, _, _ = pipeline.build_script((groot_p1(),), GROOT_STATS, ReadOptions())

    said = [s for s in sentences if s.kind == "heading"]
    assert said[0].text == f"{GROOT_TITLE}."
    # The notes' section view titles a section with the heading sentence's raw text.
    assert said[0].raw == GROOT_TITLE
    assert said[0].items == (2, 3)
    assert not any(s.text.startswith("Humanoid Robots") for s in sentences)


def test_a_title_wrapped_centred_is_one_heading() -> None:
    blocks = classify_page(maskvit_p1(), DocStats(body_size=10.0, num_pages=22))

    assert headings(blocks)[0] == "MaskViT: Masked Visual Pre-Training for Video Prediction"


def test_a_title_wrapped_over_three_lines_is_one_heading() -> None:
    page = title_page(("A Very Long Title That Needs", 100.0, 72.0),
                      ("Three Lines To Set In Full On", 121.0, 72.0),
                      ("The First Page", 142.0, 72.0))

    assert headings(classify_page(page, DocStats(body_size=9.9, num_pages=10))) == [
        "A Very Long Title That Needs Three Lines To Set In Full On The First Page"]


# ── What must stay apart ──────────────────────────────────────────────────────


def test_the_author_line_under_a_title_is_not_part_of_it() -> None:
    blocks = classify_page(groot_p1(), GROOT_STATS)

    author = next(b for b in blocks if 3 in b.line_ids)
    assert author.line_ids == (3,)
    assert GROOT_TITLE in headings(blocks)


def test_a_centred_author_line_is_not_part_of_a_centred_title() -> None:
    blocks = classify_page(maskvit_p1(), DocStats(body_size=10.0, num_pages=22))

    author = next(b for b in blocks if 2 in b.line_ids)
    assert author.line_ids == (2,)


def test_a_section_heading_is_not_merged_into_the_body_below_it() -> None:
    blocks = classify_page(groot_p1(), GROOT_STATS)

    abstract = next(b for b in blocks if 4 in b.line_ids)
    assert (abstract.kind, abstract.line_ids) == ("heading", (4,))
    assert next(b for b in blocks if 5 in b.line_ids).kind == "body"


def test_stacked_numbered_section_headings_stay_apart() -> None:
    blocks = classify_page(groot_p19(), GROOT_STATS)

    assert headings(blocks)[:2] == ["A. Contributors and Acknowledgments", "A.1. Core Contributors"]


def test_a_running_head_is_not_merged_into_the_heading_below_it() -> None:
    blocks = classify_page(groot_p19(), GROOT_STATS)

    head = next(b for b in blocks if 0 in b.line_ids)
    assert (head.kind, head.line_ids) == ("header", (0,))


def test_two_short_headings_in_the_same_style_stay_apart_when_the_second_is_numbered() -> None:
    page = title_page(("Abstract", 100.0, 72.0), ("1 Introduction", 120.0, 72.0), size=12.0)

    assert headings(classify_page(page, DocStats(body_size=9.9, num_pages=10))) == [
        "Abstract", "1 Introduction"]


def test_numbered_headings_stacked_tight_stay_apart() -> None:
    page = title_page(("3 Method", 100.0, 72.0), ("3.1 Setting", 115.0, 72.0), size=12.0)

    assert headings(classify_page(page, DocStats(body_size=9.9, num_pages=10))) == [
        "3 Method", "3.1 Setting"]


def test_heading_lines_further_apart_than_a_wrapped_line_stay_apart() -> None:
    page = title_page(("Learning To Act", 100.0, 72.0), ("From Pixels Alone", 140.0, 72.0))

    assert headings(classify_page(page, DocStats(body_size=9.9, num_pages=10))) == [
        "Learning To Act", "From Pixels Alone"]


def test_heading_lines_neither_left_aligned_nor_centred_stay_apart() -> None:
    page = title_page(("Architecture", 100.0, 72.0), ("Data Modality", 118.0, 300.0))

    assert headings(classify_page(page, DocStats(body_size=9.9, num_pages=10))) == [
        "Architecture", "Data Modality"]


def test_a_smaller_line_in_the_title_font_is_not_part_of_the_title() -> None:
    page = mk_page(1, [
        mk_line(0, "Learning To Act From Pixels", 100.0, x1=320.0, size=TITLE_SIZE, font=BOLD_FONT),
        mk_line(1, "Ada Lovelace and Alan Turing", 121.0, x1=250.0, size=14.0, font=BOLD_FONT),
        mk_line(2, "We describe the method and the experiments in the sections below", 160.0),
    ])

    assert headings(classify_page(page, DocStats(body_size=9.9, num_pages=10))) == [
        "Learning To Act From Pixels", "Ada Lovelace and Alan Turing"]


def test_a_line_of_the_same_size_in_another_font_is_not_part_of_the_heading() -> None:
    other_bold = "NimbusSanL-Bold"
    page = mk_page(1, [
        mk_line(0, "Learning To Act From Pixels", 100.0, x1=320.0, size=TITLE_SIZE, font=BOLD_FONT),
        mk_line(1, "Technical Report", 121.0, x1=250.0, size=TITLE_SIZE, font=other_bold),
        mk_line(2, "We describe the method and the experiments in the sections below", 160.0),
    ])

    assert headings(classify_page(page, DocStats(body_size=9.9, num_pages=10))) == [
        "Learning To Act From Pixels", "Technical Report"]


# ── Wrapped numbered headings (U12 follow-up: D1, D3, D5) ────────────────────


def vlaw_p6() -> PageGeometry:
    """VLAW p6, lines 37-45: body, then "5.2." wrapped with a hanging indent, then a run-in
    head. The heading font carries no bold hint and is the body size, so the second line
    is no heading on its own; it sits under the text after the number, 17.4pt in."""
    f1, f2, size = "g_d9_f1", "g_d9_f2", 9.9626

    def plain(idx: int, item: int, text: str, x0: float, x1: float, y: float,
              font: str = f2) -> Line:
        return real(idx, text, x0, x1, y, 10, font, [item], [x0], [text], [size])

    lines = (
        plain(0, 148, "additionally finetuned using rollout data from the first iter-",
              55.44, 291.091, 555.706),
        plain(1, 149, "ation to improve reward accuracy. The policy is updated",
              55.44, 289.437, 567.661),
        plain(2, 150, "with 2k steps with batch size 256. We perform a total of two",
              55.082, 289.441, 579.616),
        plain(3, 151, "iterations of this procedure.", 55.44, 165.009, 591.571),
        real(4, "5.2. Can we learn an accurate action-conditioned world", 55.44, 289.438, 616.704,
             10, f1, [153, 154, 155], [55.44, 70.384, 72.875],
             ["5.2.", " ", "Can we learn an accurate action-conditioned world"], [size] * 3),
        plain(5, 156, "model for contact-rich tasks?", 72.875, 196.860, 628.66, f1),
        real(6, "Action replay inside the world model. We evaluate the", 55.082, 289.445, 647.312,
             10, f1, [157, 158, 159], [55.082, 219.714, 224.348],
             ["Action replay inside the world model.", " ", "We evaluate the"], [size] * 3),
        plain(7, 160, "fidelity of the learned world model and study the contribu-",
              55.44, 291.091, 659.267),
        plain(8, 161, "tion of online rollout data by replaying real-world action",
              55.44, 289.437, 671.222),
    )
    return PageGeometry(page=6, width=612, height=792, lines=lines)


VLAW_STATS = DocStats(body_size=10.0, num_pages=14)


def test_a_numbered_heading_wrapped_under_its_text_is_one_heading() -> None:
    blocks = classify_page(vlaw_p6(), VLAW_STATS)

    title = next(b for b in blocks if b.kind == "heading")
    assert title.text == ("5.2. Can we learn an accurate action-conditioned world "
                          "model for contact-rich tasks?")
    assert title.line_ids == (4, 5)


def test_the_run_in_head_after_a_wrapped_heading_is_not_part_of_it() -> None:
    blocks = classify_page(vlaw_p6(), VLAW_STATS)

    assert not any(6 in b.line_ids for b in blocks if b.kind == "heading")


def test_a_hanging_indent_joins_a_bold_numbered_heading() -> None:
    page = title_page(("3.2 Learning Latent Actions from", 100.0, 72.0),
                      ("Human Videos", 114.0, 92.0), size=12.0)

    assert headings(classify_page(page, DocStats(body_size=9.9, num_pages=10))) == [
        "3.2 Learning Latent Actions from Human Videos"]


def test_a_line_indented_past_the_number_is_not_a_hanging_indent() -> None:
    page = title_page(("3.2 Learning Latent Actions from", 100.0, 72.0),
                      ("Human Videos", 114.0, 110.0), size=12.0)

    assert headings(classify_page(page, DocStats(body_size=9.9, num_pages=10))) == [
        "3.2 Learning Latent Actions from", "Human Videos"]


def test_a_lowercase_line_after_a_heading_that_has_ended_is_not_part_of_it() -> None:
    page = mk_page(1, [
        mk_line(0, "5.2. Can we learn world models?", 100.0, x1=250.0, size=10.0, font="g_d9_f1"),
        mk_line(1, "and the answer is yes", 112.0, x1=200.0, size=10.0, font="g_d9_f1"),
        *(mk_line(i, "We describe the method and the experiments in the sections below", 100.0 + 12 * i)
          for i in range(2, 6)),
    ])

    blocks = classify_page(page, DocStats(body_size=10.0, num_pages=10))
    assert next(b for b in blocks if b.kind == "heading").line_ids == (0,)


def test_a_lowercase_body_line_under_a_heading_is_not_part_of_it() -> None:
    page = mk_page(1, [
        mk_line(0, "3 Learning Latent Actions from", 100.0, x1=250.0, size=12.0, font=BOLD_FONT),
        mk_line(1, "videos is what we describe in this section of the paper", 114.0),
        mk_line(2, "We describe the method and the experiments in the sections below", 126.0),
    ])

    blocks = classify_page(page, DocStats(body_size=9.9, num_pages=10))
    assert next(b for b in blocks if b.kind == "heading").line_ids == (0,)


def test_a_lettered_subsection_under_a_roman_section_stays_apart() -> None:
    page = title_page(("III. METHOD", 100.0, 72.0), ("A. Problem Setup", 112.0, 72.0), size=9.9)

    assert headings(classify_page(page, DocStats(body_size=9.9, num_pages=10))) == [
        "III. METHOD", "A. Problem Setup"]


def test_an_appendix_subsection_under_its_appendix_stays_apart() -> None:
    page = title_page(("A Implementation Details", 100.0, 72.0),
                      ("A.1 Training Setup", 116.0, 72.0), size=12.0)

    assert headings(classify_page(page, DocStats(body_size=9.9, num_pages=10))) == [
        "A Implementation Details", "A.1 Training Setup"]


def test_a_title_line_that_opens_with_a_quantity_is_still_a_wrap() -> None:
    page = title_page(("Scaling Robot Learning to", 100.0, 72.0),
                      ("1000 Tasks and Beyond", 121.0, 72.0))

    assert headings(classify_page(page, DocStats(body_size=9.9, num_pages=10))) == [
        "Scaling Robot Learning to 1000 Tasks and Beyond"]


def test_heading_lines_on_one_baseline_or_out_of_order_stay_apart() -> None:
    same = title_page(("Learning To Act", 100.0, 72.0), ("From Pixels Alone", 100.0, 72.0))
    above = title_page(("Learning To Act", 100.0, 72.0), ("From Pixels Alone", 90.0, 72.0))

    for page in (same, above):
        assert len(headings(classify_page(page, DocStats(body_size=9.9, num_pages=10)))) == 2


@pytest.mark.parametrize("rest", [
    "Model rollouts are costly and slow",           # opens a sentence of its own
    "model for contact-rich tasks, and for every other task that we set the robots in our lab, and",  # prose-length
    "model for contact-rich tasks.",                # ends as a sentence, not a title
])
def test_a_line_under_a_numbered_heading_that_could_start_prose_is_not_its_rest(rest: str) -> None:
    page = vlaw_p6()
    lines = tuple(replace(ln, text=rest, item_text=(rest,)) if ln.idx == 5 else ln
                  for ln in page.lines)

    blocks = classify_page(replace(page, lines=lines), VLAW_STATS)
    assert next(b for b in blocks if b.kind == "heading").line_ids == (4,)


def test_a_line_another_rule_has_claimed_is_not_the_rest_of_a_heading() -> None:
    lines = vlaw_p6().lines

    assert list(heading_runs(lines, [4], [4, 5])) == [[4, 5]]
    assert list(heading_runs(lines, [4], [4])) == [[4]]
