"""U5: prose beside a wrapped figure is read as prose; the figure's text is not.

The fixture mirrors GR00TN1.pdf p2 as `pdfview.buildPageGeometry` extracted it: prose
justified to 62-283 beside a figure whose labels and caption share the prose baselines,
so pdf.js lines run across the gutter. Before U5 the row "for generalist humanoid robots.
The GR00T N1 ^Real-World Data" read as display maths and cut the opening sentence in two.
"""

from __future__ import annotations

from typing import Sequence

from kokoro_reader.textpipe import classify, pipeline, wrapfig
from kokoro_reader.textpipe.types import DocStats, Line, PageGeometry

PAGE_W, PAGE_H = 595.276, 841.89
BODY, LABEL = 10.0, 8.2
MARGIN, MEASURE, FULL = 62.4, 282.7, 532.9
STATS = DocStats(body_size=BODY, num_pages=36)
SENTENCE = "We introduce GR00T N1, an open foundation model for generalist humanoid robots."
LABELS = ("^Real", "World Data", "_Synthetic Data", "Web Data &", "Human Videos")

Seg = tuple[float, str, float]  # item x, item text, item size


def row(idx: int, y: float, *segs: Seg, x1: float | None = None) -> Line:
    """A pdf.js line built from its items, exactly as the client joins them."""
    return Line(
        idx=idx, text=" ".join(t.strip() for _, t, _ in segs if t.strip()),
        x0=segs[0][0], x1=x1 if x1 is not None else MEASURE, y=y,
        size=max(s for _, _, s in segs), font="g_d0_f3",
        items=tuple(idx * 10 + k for k in range(len(segs))),
        item_x=tuple(x for x, _, _ in segs), item_text=tuple(t for _, t, _ in segs),
        item_size=tuple(s for _, _, s in segs),
    )


def prose(idx: int, y: float, text: str, x1: float = MEASURE) -> Line:
    return row(idx, y, (MARGIN, text, BODY), x1=x1)


def wrapped_page(tail: Sequence[Line] = ()) -> PageGeometry:
    lines = (
        prose(0, 95.0, "control modes, and other factors result in an archipelago of data "
                       "islands rather than a coherent, Internet-scale", x1=FULL),
        prose(1, 108.8, "dataset needed for training a true generalist model.", x1=285.2),
        prose(2, 129.4, "We introduce GR00T N1, an open foundation model"),
        row(3, 142.4, (MARGIN, "for generalist humanoid robots.", BODY), (206.2, " ", BODY),
            (214.1, "The GR00T N1", BODY), (350.6, "^Real", LABEL), (367.4, "-", LABEL),
            (371.0, "World Data", LABEL), x1=415.7),
        prose(4, 156.9, "model is a Vision-Language-Action (VLA) model,", x1=284.1),
        prose(5, 170.6, "which generates actions from image and language"),
        row(6, 186.7, (MARGIN, "instruction input. It has cross-embodiment support", BODY),
            (331.1, "_Synthetic Data", LABEL), x1=390.2),
        prose(7, 198.1, "from tabletop robot arms to dexterous humanoid"),
        row(8, 234.0, (310.6, "Web Data &", LABEL), x1=357.5),
        prose(9, 239.4, "robots. The System 2 reasoning module is a"),
        row(10, 246.4, (305.6, "Human Videos", LABEL), x1=362.4),
        prose(11, 253.1, "pre-trained Vision-Language Model (VLM) that"),
        row(12, 283.3, (MARGIN, "processes the robot's visual perception and", BODY),
            (297.6, "Figure 1:", BODY), (336.5, " ", BODY),
            (339.3, "Data Pyramid for Robot Foundation Model", BODY), x1=FULL),
        row(13, 295.3, (MARGIN, "language instruction to interpret the scene.", BODY),
            (297.3, "Training.", BODY), (339.3, " ", BODY),
            (342.6, "The corpora form a pyramid.", BODY), x1=FULL),
        prose(14, 349.3, "It then employs embodiment-"),
        row(15, 363.1, (MARGIN, "specific encoders and decoders to handle variable state and "
                                "action dimensions for motion generation.", BODY),
            (520.2, " ", BODY), (526.4, "It", BODY), x1=533.1),
        prose(16, 376.8, "generates closed-loop motor actions at a higher frequency.", x1=FULL),
    )
    return PageGeometry(page=2, width=PAGE_W, height=PAGE_H, lines=lines + tuple(tail))


def merged_page() -> PageGeometry:
    """A figure whose labels land on most of the prose baselines (VJEPA_2.pdf p13).

    Eight of the thirteen prose rows are joined with a plot label, so only five rows are
    left visibly ending at the measure -- fewer than half the run.
    """
    lines = []
    for k in range(13):
        text = f"prose row {k} of the paragraph beside the plot."
        lines.append(prose(k, 100.0 + 13.8 * k, text) if k % 3 == 0 else
                     row(k, 100.0 + 13.8 * k, (MARGIN, text, BODY),
                         (350.6, f"0.{40 + k}", LABEL), x1=415.7))
    return PageGeometry(page=13, width=PAGE_W, height=PAGE_H, lines=tuple(lines))


def spoken(page: PageGeometry):
    sentences, blocks, _ = pipeline.build_script((page,), STATS)
    return sentences, blocks


# ── The defect ────────────────────────────────────────────────────────────────


def test_sentence_beside_a_wrapped_figure_is_one_chunk():
    sentences, _ = spoken(wrapped_page())
    assert SENTENCE in [s.text for s in sentences]


def test_no_figure_label_is_read_and_nothing_is_called_an_equation():
    sentences, blocks = spoken(wrapped_page())
    text = " ".join(s.text for s in sentences)
    assert not [label for label in LABELS if label.strip("^_") in text]
    assert "equation" not in {s.kind for s in sentences}
    figure = [b for b in blocks if b.kind == "figure"]
    assert figure and not any(b.speak for b in figure)


def test_caption_is_read_apart_from_the_prose():
    sentences, _ = spoken(wrapped_page())
    # The caption is set in the body's type; U16 reads it to its end (see `capwrap`).
    assert ("caption", "Figure 1: Data Pyramid for Robot Foundation Model Training.") in [
        (s.kind, s.text) for s in sentences]
    prose_text = " ".join(s.text for s in sentences if s.kind == "body")
    assert "perception and language instruction to interpret the scene." in prose_text
    assert "Figure" not in prose_text


def test_side_column_is_read_at_the_next_sentence_end_not_mid_sentence():
    sentences, _ = spoken(wrapped_page())
    texts = [s.text for s in sentences]
    caption = texts.index("Figure 1: Data Pyramid for Robot Foundation Model Training.")
    # Row 15 ends "... generation. It", so the first line-final sentence end is row 16.
    assert texts[caption - 1] == "It generates closed-loop motor actions at a higher frequency."
    assert any(t.startswith("It then employs embodiment") and t.endswith("motion generation.")
               for t in texts)


def test_highlights_cover_only_their_own_items():
    sentences, _ = spoken(wrapped_page())
    first = next(s for s in sentences if s.text == SENTENCE)
    assert first.items == (20, 30)  # row 2's item and row 3's first item, no label


def test_figure_is_found_even_when_it_merges_with_most_of_the_prose():
    page = merged_page()
    measure = wrapfig._measure(page.lines, STATS, page.width)
    flow = [ln for ln in page.lines if ln.x0 < measure.gutter]
    in_measure = sum(measure.starts(ln) and measure.holds(ln) for ln in flow)
    assert in_measure < wrapfig.MIN_MEASURE_SHARE * len(flow)  # a share test over uncut rows fails

    out = wrapfig.unwrap_page(page, STATS)
    texts = [ln.text for ln in out.lines]
    assert texts[:13] == [f"prose row {k} of the paragraph beside the plot." for k in range(13)]
    assert texts[13:] == [f"0.{40 + k}" for k in range(13) if k % 3]


def test_a_cut_head_reports_the_extent_of_the_text_it_keeps():
    line = wrapped_page().lines[3]  # "for generalist humanoid robots. The GR00T N1" + label
    head, _ = wrapfig._split(line, cut=3, gutter=MEASURE)
    assert head.x1 < MEASURE  # ragged: the head stops where its own last item ends
    assert head.x1 > line.item_x[2]


# ── What must not change ──────────────────────────────────────────────────────


def test_full_width_line_with_an_item_past_the_gutter_is_not_cut():
    page = wrapfig.unwrap_page(wrapped_page(), STATS)
    texts = [ln.text for ln in page.lines]
    assert any(t.endswith("for motion generation. It") for t in texts)
    assert "It" not in texts


def test_cut_lines_keep_every_item_once_and_indices_stay_unique():
    before = wrapped_page()
    after = wrapfig.unwrap_page(before, STATS)
    assert sorted(i for ln in after.lines for i in ln.items) == sorted(
        i for ln in before.lines for i in ln.items)
    assert [ln.idx for ln in after.lines] == list(range(len(after.lines)))


def test_page_without_a_narrow_measure_is_returned_untouched():
    lines = tuple(prose(k, 100.0 + 13.8 * k, f"full width prose line number {k} runs on",
                        x1=FULL) for k in range(8))
    page = PageGeometry(page=1, width=PAGE_W, height=PAGE_H, lines=lines)
    assert wrapfig.unwrap_page(page, STATS) is page


def test_two_column_page_in_column_order_is_returned_untouched():
    left = [prose(k, 100.0 + 13.8 * k, f"left column prose line {k} of the page") for k in range(6)]
    right = [row(6 + k, 100.0 + 13.8 * k, (310.0, f"right column prose line {k}", BODY), x1=FULL)
             for k in range(6)]
    page = PageGeometry(page=3, width=PAGE_W, height=PAGE_H, lines=tuple(left + right))
    assert wrapfig.unwrap_page(page, STATS) is page


def test_one_stray_crossing_is_not_a_wrapped_figure():
    lines = list(wrapped_page().lines)
    lines[6] = prose(6, 186.7, "instruction input. It has cross-embodiment support")
    lines[12] = prose(12, 283.3, "processes the robot's visual perception and")
    lines[13] = prose(13, 295.3, "language instruction to interpret the scene.")
    page = PageGeometry(page=2, width=PAGE_W, height=PAGE_H, lines=tuple(lines))
    assert wrapfig.unwrap_page(page, STATS) is page


def test_classifier_tags_the_unwrapped_side_column():
    page = wrapfig.unwrap_page(wrapped_page(), STATS)
    kinds = {b.text: b.kind for b in classify.classify_page(page, STATS)}
    caption = ("Figure 1: Data Pyramid for Robot Foundation Model Training. "
               "The corpora form a pyramid.")
    assert kinds[caption] == "caption"
    assert {k for t, k in kinds.items() if "Human Videos" in t} == {"figure"}
