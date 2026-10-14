"""Headings pdf.js gives no font name for (N3): small caps and body-size run-in titles.

pdf.js names fonts `g_d0_f2`, so the bold and monospace hints in `_is_heading` never fire,
and a heading set at body size glued onto the sentence after it ("State and Action
Encoders To process states..."). The fixtures are geometry from GR00TN1.pdf p3 and
InContextLimitation.pdf p1 (IEEE small caps) as pdf.js reports it.
"""

from __future__ import annotations

from typing import Sequence

from kokoro_reader.textpipe.classify import classify_page
from kokoro_reader.textpipe.types import DocStats, Line, PageGeometry

Row = tuple[int, float, float, float, float, str, list[tuple[float, str, float]]]
STATS = DocStats(body_size=10.0, num_pages=12)

GR00T_P3: tuple[Row, ...] = (
    (42, 678.9, 62.4, 532.9, 10.0, "f3", [(62.4, "matching (Lipman et al.) to learn action "
                                          "generation. A diffusion transformer (DiT) processes the robot’s", 9.96)]),
    (43, 692.7, 62.4, 533.2, 10.0, "f3", [(62.4, "proprioceptive state and action, which are then "
                                          "cross-attended with image and text tokens from the Eagle-2", 9.96)]),
    (44, 706.4, 62.1, 493.7, 10.0, "f3", [(62.1, "VLM backbone to output the denoised motor actions. "
                                          "Below, we elaborate on each module in detail.", 9.96)]),
    (45, 729.4, 62.4, 183.5, 10.0, "f2", [(62.4, "State and Action Encoders", 9.96)]),
    (46, 743.1, 62.1, 533.1, 10.0, "f3", [(62.1, "To process states and actions of varying dimensions "
                                          "across different robot embodiments, we use an MLP per", 9.96)]),
    (47, 756.9, 62.4, 534.3, 10.0, "f3", [(62.4, "embodiment to project them to a shared embedding "
                                          "dimension as input to the DiT. As in Black et al. (2024),", 9.96)]),
)

ICRT_P1: tuple[Row, ...] = (
    (22, 440.6, 54.0, 298.8, 9.0, "f1", [(54.0, "outperforms current state-of-the-art robot foundation models", 8.97)]),
    (23, 450.6, 54.0, 298.8, 9.0, "f1", [(54.0, "on generalization to unseen tasks. Code, checkpoints and data", 8.97)]),
    (24, 460.5, 54.0, 208.2, 9.0, "f1", [(54.0, "are available on", 8.97), (116.5, " ", 8.97),
                                         (119.9, "https://icrt.dev", 8.97), (206.0, ".", 8.97)]),
    (25, 481.4, 137.5, 215.3, 8.0, "f2", [(137.5, "I. I", 9.96), (153.1, "NTRODUCTION", 7.97)]),
    (26, 498.1, 64.0, 298.8, 10.0, "f2", [(64.0, "Learning-based single and multi-task robot policies have", 9.96)]),
    (27, 510.0, 54.0, 298.8, 10.0, "f2", [(54.0, "become increasingly capable [1–10]. This improvement in", 9.96)]),
    (28, 522.0, 54.0, 298.8, 10.0, "f2", [(54.0, "robot capabilities can largely be attributed to progress in", 9.96)]),
)


def mk(row: Row) -> Line:
    idx, y, x0, x1, size, font, items = row
    return Line(idx=idx, text="".join(t for _, t, _ in items).strip(), x0=x0, x1=x1, y=y,
                size=size, font=f"g_d0_{font}", items=tuple(range(idx * 10, idx * 10 + len(items))),
                item_x=tuple(x for x, _, _ in items), item_text=tuple(t for _, t, _ in items),
                item_size=tuple(s for _, _, s in items))


def kinds(rows: Sequence[Row], page: int = 3, width: float = 595.3) -> dict[int, str]:
    geom = PageGeometry(page=page, width=width, height=841.9, lines=tuple(mk(r) for r in rows))
    return {i: b.kind for b in classify_page(geom, STATS) for i in b.line_ids}


def with_row(rows: Sequence[Row], idx: int, **change: object) -> tuple[Row, ...]:
    fields = ("idx", "y", "x0", "x1", "size", "font", "items")
    return tuple(tuple(change.get(f, v) for f, v in zip(fields, r)) if r[0] == idx else r
                 for r in rows)


def test_body_size_title_in_its_own_font_is_a_heading():
    got = kinds(GR00T_P3)
    assert got[45] == "heading"
    assert got[46] == got[47] == "body"


def test_short_line_in_the_prose_font_is_not_a_title():
    assert kinds(with_row(GR00T_P3, 45, font="f3"))[45] == "body"


def test_short_line_running_on_in_lower_case_is_not_a_title():
    rows = with_row(GR00T_P3, 46, items=[(62.1, "to process states and actions of varying "
                                         "dimensions across different robot embodiments, we", 9.96)])
    assert kinds(rows)[45] == "body"


def test_small_caps_section_title_is_a_heading():
    got = kinds(ICRT_P1, page=1, width=612.0)
    assert got[25] == "heading"
    assert got[26] == "body"


def test_capital_then_smaller_lower_case_is_not_small_caps():
    """A word with a raised mark (`Policies` + a smaller `1`) is prose, not small caps."""
    rows = with_row(ICRT_P1, 25, items=[(137.5, "Robot P", 9.96), (153.1, "olicies", 7.97)])
    assert kinds(rows, page=1, width=612.0)[25] != "heading"


# Contents falls back to detected headings (N7), so a table label or name is a false chapter.
def title_kind(title_items: list, next_items: list | None = None) -> str:
    rows = with_row(GR00T_P3, 45, items=title_items)
    if next_items is not None:
        rows = with_row(rows, 46, items=next_items)
    return kinds(rows)[45]


def test_table_cell_and_number_lines_are_not_titles():
    """Python-for-Data-Analysis: `False 10256`; VJEPA_2 p48: `Stage 1`."""
    assert title_kind([(62.4, "False 10256", 9.96)]) != "heading"
    assert title_kind([(62.4, "Stage 1", 9.96)]) != "heading"


def test_column_header_split_by_a_gutter_is_not_a_title():
    """Python-for-Data-Analysis p53: `Type` and `Description` head two table columns."""
    assert title_kind([(62.4, "Type", 9.96), (160.0, "Description", 9.96)]) != "heading"


def test_label_with_no_four_letter_word_is_not_a_title():
    """VJEPA_2 p35: the row label `ViT-L`."""
    assert title_kind([(62.4, "ViT-L", 9.96)]) != "heading"


def test_name_over_a_list_of_names_is_not_a_title():
    """GR00TN1 p19: `Jing Wang` among contributor names, not over prose."""
    names = [(62.1, "Seonghyeon Ye, Zongyu Lin, Jiannan Xiang, Joel Jang, You Liang Tan", 9.96)]
    assert title_kind([(62.4, "Jing Wang", 9.96)], names) != "heading"


def test_name_over_a_short_title_is_not_a_title():
    """GR00TN1 p19: `Jing Wang` closes one contributor list over the next list's title."""
    rows = with_row(GR00T_P3, 46, x1=267.8,
                    items=[(62.1, "Video Generation Models and Latent Actions", 9.96)])
    assert kinds(with_row(rows, 45, items=[(62.4, "Jing Wang", 9.96)]))[45] != "heading"


def test_column_header_aligned_with_the_row_below_is_not_a_title():
    """Python-for-Data-Analysis p53: `Type` / `Description` over `None` / `The Python...`."""
    row = [(62.1, "None", 9.0), (104.1, "The Python null value (only one instance of the None "
                                        "object exists) and more text to fill the row", 9.0)]
    assert title_kind([(62.4, "Type", 9.0), (89.7, " ", 9.0), (104.1, "Description", 9.0)],
                      row) != "heading"
