"""Boundary pins for the tablerow thresholds (U36).

Two kinds of pin per threshold:
- boundary tests derive their inputs from the constant, so a flipped comparison fails;
- spec tests feed a fixed, realistic row, so a moved threshold fails. A test that read
  the constant could not catch the constant changing.
"""

from __future__ import annotations

from fractions import Fraction
from itertools import count
from typing import Callable, Sequence

from kokoro_reader.textpipe import tablerow
from kokoro_reader.textpipe.types import Line

SIZE = 10.0
NUMBER = "12"
WORD = "word"
COLUMN_X = 300.0     # far past any gutter threshold from x=0 for a one-letter item
RESULTS_ROW = "ResNet-50 top-1 76.1 92.9"   # half its tokens are numbers
TABLE_ROWS = 8
BLANK_CELLS = 2      # a quarter of the rows leave the column empty
# Spec inputs for the lowering direction (U37): a lowered threshold reads prose as a table.
PROSE_WITH_NUMBERS = "In 2019 we trained 3 models for 12 hours."   # a third numbers
SHORT_RESULTS_ROW = "ResNet-50 76.1 92.9"     # three tokens, two of them numbers
HEADER_ROW = ("Model", "Params", "Dataset", "Accuracy")              # 6.5 chars per item
PROSE_ITEMS = ("convolutional", "networks", "generalize", "poorly")  # 9.25 chars per item
PROSE_TAIL = ("as", "we", "show.")   # a sentence's last line: short words, but only three
LONG_RUN_ROWS = 10
SPARSE_SUPPORTERS = 6   # a column in 60% of the rows is a coincidence, not a column


def mk_line(item_text: Sequence[str], item_x: Sequence[float]) -> Line:
    return Line(
        idx=0,
        text=" ".join(item_text),
        x0=item_x[0],
        x1=item_x[-1],
        y=0.0,
        size=SIZE,
        item_x=tuple(item_x),
        item_text=tuple(item_text),
    )


def flush_line(item_text: Sequence[str]) -> Line:
    """Items laid end to end with no whitespace, so the line is a single column."""
    advances = [len(t) * SIZE * tablerow.CHAR_ADVANCE_RATIO for t in item_text]
    xs = [sum(advances[:k]) for k in range(len(item_text))]
    return mk_line(item_text, xs)


def exact_split(fraction: float, fits: Callable[[int, int], bool]) -> tuple[int, int]:
    """(part, total): the smallest total on which `fraction` lands exactly and `fits`."""
    share = Fraction(str(fraction))
    totals = count(share.denominator, share.denominator)
    return next((int(share * n), n) for n in totals if fits(int(share * n), n))


# ── NUMERIC_TOKEN_FRACTION ────────────────────────────────────────────────────

def numeric_line(hits: int, total: int) -> Line:
    return mk_line([NUMBER] * hits + [WORD] * (total - hits), [0.0] * total)


def numeric_case() -> tuple[int, int]:
    return exact_split(tablerow.NUMERIC_TOKEN_FRACTION,
                       lambda _, total: total >= tablerow.MIN_TABLE_TOKENS)


def test_numeric_share_exactly_at_the_fraction_is_not_dominant() -> None:
    hits, total = numeric_case()

    assert not tablerow.numeric_dominant(numeric_line(hits, total))


def test_one_numeric_token_past_the_fraction_is_dominant() -> None:
    hits, total = numeric_case()

    assert tablerow.numeric_dominant(numeric_line(hits + 1, total))


def test_a_results_row_that_is_half_numbers_is_numeric_dominant() -> None:
    line = mk_line(RESULTS_ROW.split(), [0.0] * len(RESULTS_ROW.split()))

    assert tablerow.numeric_dominant(line)


def test_prose_that_is_a_third_numbers_is_not_numeric_dominant() -> None:
    tokens = PROSE_WITH_NUMBERS.split()

    assert not tablerow.numeric_dominant(mk_line(tokens, [0.0] * len(tokens)))


def test_a_three_token_results_row_is_numeric_dominant() -> None:
    tokens = SHORT_RESULTS_ROW.split()

    assert tablerow.numeric_dominant(mk_line(tokens, [0.0] * len(tokens)))


# ── SHORT_ITEM_CHARS (_short_item_row, via looks_tabular) ─────────────────────

def short_item_line(chars: int) -> Line:
    return flush_line(["x" * chars] * tablerow.MIN_SHORT_ITEMS)


def test_items_averaging_exactly_the_short_limit_are_not_a_table_row() -> None:
    line = short_item_line(tablerow.SHORT_ITEM_CHARS)

    assert not tablerow.looks_tabular(line)


def test_items_one_char_under_the_short_limit_are_a_table_row() -> None:
    line = short_item_line(tablerow.SHORT_ITEM_CHARS - 1)

    assert tablerow.looks_tabular(line)


def test_a_four_cell_header_row_of_short_words_is_a_table_row() -> None:
    assert tablerow.looks_tabular(flush_line(HEADER_ROW))


def test_four_words_of_ordinary_prose_are_not_a_table_row() -> None:
    assert not tablerow.looks_tabular(flush_line(PROSE_ITEMS))


def test_the_three_word_tail_of_a_sentence_is_not_a_table_row() -> None:
    assert not tablerow.looks_tabular(flush_line(PROSE_TAIL))


# ── COLUMN_SUPPORT_FRACTION (shared_columns) ──────────────────────────────────

def rows_with_column(supporters: int, total: int) -> list[Line]:
    """`total` rows starting at x=0; the first `supporters` also start a column at COLUMN_X."""
    two_columns = mk_line(["a", "b"], [0.0, COLUMN_X])
    one_column = mk_line(["a"], [0.0])
    return [two_columns] * supporters + [one_column] * (total - supporters)


def support_case() -> tuple[int, int]:
    """A run long enough that the fraction, not MIN_TABLE_RUN, sets the support needed."""
    return exact_split(tablerow.COLUMN_SUPPORT_FRACTION,
                       lambda needed, _: needed > tablerow.MIN_TABLE_RUN)


def test_a_column_backed_by_exactly_the_support_fraction_is_shared() -> None:
    needed, total = support_case()

    assert tablerow.shared_columns(rows_with_column(needed, total)) == [0.0, COLUMN_X]


def test_a_column_one_row_short_of_the_support_fraction_is_dropped() -> None:
    needed, total = support_case()

    assert tablerow.shared_columns(rows_with_column(needed - 1, total)) == [0.0]


def test_a_column_blank_in_a_quarter_of_the_rows_is_still_shared() -> None:
    rows = rows_with_column(TABLE_ROWS - BLANK_CELLS, TABLE_ROWS)

    assert tablerow.shared_columns(rows) == [0.0, COLUMN_X]


def test_a_column_in_six_of_ten_rows_is_not_shared() -> None:
    rows = rows_with_column(SPARSE_SUPPORTERS, LONG_RUN_ROWS)

    assert tablerow.shared_columns(rows) == [0.0]
