"""H9/H10 — the footnote rule, checked against shapes taken from real papers.

Every fixture here is transcribed from geometry that pdf.js actually produced for a PDF
on this machine; the docstring of each test names the page it came from. The rule failed
in both directions at once: it caught none of the footnotes in five arXiv papers, and it
started a footnote on any small line beginning with a digit — which deletes the rest of
the run, and a figure's axis ticks sit directly above its caption.
"""

from __future__ import annotations

from typing import Sequence

from kokoro_reader.textpipe.classify import classify_page
from kokoro_reader.textpipe.types import Block, DocStats, Line, PageGeometry

PAGE_W = 612.0
PAGE_H = 792.0
LEFT = 72.0
BODY = 10.0
FOOTNOTE_SIZE = 9.0     # arXiv style: footnotes are 0.90 of body, not 0.86
MARKER_SIZE = 6.0       # ...and the marker itself is set as a superscript
BODY_FONT = "g_d0_f1"


def mk_line(
    idx: int,
    y: float,
    items: Sequence[tuple[str, float]],
    *,
    x0: float = LEFT,
    size: float = BODY,
    font: str = BODY_FONT,
) -> Line:
    """A line built from ``(text, glyph height)`` items, as pdf.js reports them."""
    texts = tuple(text for text, _ in items)
    sizes = tuple(float(s) for _, s in items)
    xs, cursor = [], x0
    for text, item_size in zip(texts, sizes):
        xs.append(cursor)
        cursor += len(text) * item_size * 0.5
    base = idx * 100
    return Line(
        idx=idx,
        text="".join(texts),
        x0=x0,
        x1=cursor,
        y=y,
        size=size,
        font=font,
        items=tuple(range(base, base + len(texts))),
        item_x=tuple(xs),
        item_text=texts,
        item_size=sizes,
    )


def prose(idx: int, y: float, text: str) -> Line:
    return mk_line(idx, y, [(text, BODY)])


def mk_page(lines: Sequence[Line], page: int = 5) -> PageGeometry:
    return PageGeometry(page=page, width=PAGE_W, height=PAGE_H, lines=tuple(lines))


STATS = DocStats(body_size=BODY, num_pages=31)


def kinds_of(blocks: Sequence[Block], *line_ids: int) -> list[str]:
    return [next(b.kind for b in blocks if i in b.line_ids) for i in line_ids]


# ── H10: real footnotes the rule used to miss ────────────────────────────────


def test_superscript_digit_marker_starts_a_footnote() -> None:
    """iVideoGPT.pdf p5: ``3Unless otherwise specified, ...`` at 9.0 with a 6.0 marker.

    Body is 10.0, so the footnote is 0.90 of body and the marker is glued to the word.
    """
    # Arrange
    page = mk_page([
        prose(0, 689.0, "We leave an in-depth analysis of tokenizer adaptation for future work."),
        mk_line(1, 708.1, [("3", MARKER_SIZE),
                           ("Unless otherwise specified, action-free video prediction is",
                            FOOTNOTE_SIZE)],
                size=FOOTNOTE_SIZE, x0=120.7),
        mk_line(2, 720.0, [("used as the default pre-training objective.", FOOTNOTE_SIZE)],
                size=FOOTNOTE_SIZE),
    ])

    # Act
    blocks = classify_page(page, STATS)

    # Assert
    assert kinds_of(blocks, 1, 2) == ["footnote", "footnote"]
    assert kinds_of(blocks, 0) == ["body"]


def test_symbolic_marker_starts_a_footnote() -> None:
    """iVideoGPT.pdf p1 uses U+2217 ASTERISK OPERATOR; InContextLimitation.pdf p1 uses ``*``.

    Neither was in the marker class, and neither is followed by a space.
    """
    # Arrange
    page = mk_page([
        prose(0, 640.0, "We describe the training procedure in the following section."),
        mk_line(1, 700.0, [("∗Equal contribution. Correspondence to the first author.",
                            FOOTNOTE_SIZE)], size=FOOTNOTE_SIZE),
        mk_line(2, 712.0, [("*Work done while interning at the lab.", FOOTNOTE_SIZE)],
                size=FOOTNOTE_SIZE),
    ], page=1)

    # Act
    blocks = classify_page(page, STATS)

    # Assert
    assert kinds_of(blocks, 1, 2) == ["footnote", "footnote"]


# ── H9: prose that merely begins with a digit ────────────────────────────────


def test_axis_ticks_above_a_caption_do_not_swallow_the_caption() -> None:
    """mml-book.pdf p330: a tick row ``0 50 100 150 200`` sits above the figure caption.

    The old marker regex matched the tick row and marked *the rest of the run* — 48 words
    of caption prose — as a footnote. Deleting real prose is the failure this pipeline
    exists to prevent.
    """
    # Arrange
    page = mk_page([
        prose(0, 500.0, "Principal component analysis compresses the data as follows."),
        mk_line(1, 690.0, [("0 50 100 150 200", FOOTNOTE_SIZE)], size=FOOTNOTE_SIZE),
        mk_line(2, 702.0, [("Figure 10.5 Eigenvalues of the covariance matrix, sorted in",
                            FOOTNOTE_SIZE)], size=FOOTNOTE_SIZE),
        mk_line(3, 714.0, [("descending order, and the variance captured by the first k",
                            FOOTNOTE_SIZE)], size=FOOTNOTE_SIZE),
        mk_line(4, 726.0, [("principal components of the data set.", FOOTNOTE_SIZE)],
                size=FOOTNOTE_SIZE),
    ], page=330)

    # Act
    blocks = classify_page(page, STATS)

    # Assert
    assert "footnote" not in kinds_of(blocks, 2, 3, 4)
    assert all(b.speak for b in blocks if 2 in b.line_ids)


def test_prose_opening_with_a_number_is_not_a_footnote() -> None:
    """GR00TN1.pdf p20: ``30 100 300 ... Number of Demos Per Task``.

    A digit at line size is a number in the text, not a footnote marker.
    """
    # Arrange
    page = mk_page([
        prose(0, 500.0, "The policy is trained on demonstrations collected by teleoperation."),
        mk_line(1, 700.0, [("30 100 300 demonstrations were used for each of the three",
                            FOOTNOTE_SIZE)], size=FOOTNOTE_SIZE),
        mk_line(2, 712.0, [("tasks, and the success rate is averaged over ten trials.",
                            FOOTNOTE_SIZE)], size=FOOTNOTE_SIZE),
    ], page=20)

    # Act
    blocks = classify_page(page, STATS)

    # Assert
    assert "footnote" not in kinds_of(blocks, 1, 2)


def test_a_footnote_run_stops_at_the_next_caption() -> None:
    """VJEPA_2.pdf p5 sets a caption at 9.0 directly below a footnote in the same band."""
    # Arrange
    page = mk_page([
        prose(0, 500.0, "Scaling the model improves accuracy on every benchmark we tried."),
        mk_line(1, 690.0, [("1", MARKER_SIZE),
                           ("Averaged over five seeds.", FOOTNOTE_SIZE)],
                size=FOOTNOTE_SIZE),
        mk_line(2, 702.0, [("Figure 3 Scaling Ingredients. The effects of scaling",
                            FOOTNOTE_SIZE)], size=FOOTNOTE_SIZE),
        mk_line(3, 714.0, [("interventions on average accuracy across six tasks.",
                            FOOTNOTE_SIZE)], size=FOOTNOTE_SIZE),
    ], page=5)

    # Act
    blocks = classify_page(page, STATS)

    # Assert
    assert kinds_of(blocks, 1) == ["footnote"]
    assert kinds_of(blocks, 2, 3) == ["caption", "caption"]
