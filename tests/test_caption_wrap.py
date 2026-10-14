"""U16: a caption set in the body's own type is read to its end (see `capwrap`).

Before U16 such a caption stopped after its first line: PiZero.pdf p4 read "Fig. 3: ...
both our own dexterous" as a caption and "manipulation datasets and open-source data." as
a paragraph of its own. The fixtures are the real pages of `test_figwalk`.
"""

from __future__ import annotations

import pytest

from kokoro_reader.textpipe import capwrap

from .test_classify import mk_line
from .test_figwalk import kind_of


@pytest.mark.parametrize("paper, page, prefix", [
    ("PiZero", 4, "manipulation datasets and open-source data."),
    ("PiZero", 1, "embodiment dataset with a variety of dexterous"),
    ("PiZero", 1, "tasks, such as folding multiple articles of laundry"),
    ("GR00TN1", 7, "trajectories to increase the quantity and diversity"),
    ("GR00TN1", 7, "red rectangles to indicate the initial frames."),
    ("Cosmos", 11, "training is about learning the encoder and decoder"),
])
def test_a_body_size_caption_keeps_its_wrapped_lines(paper, page, prefix):
    assert kind_of(paper, page, prefix) == "caption"


@pytest.mark.parametrize("paper, page, prefix", [
    # "Figure 14 shows ..." opens a paragraph about the figure.
    ("VJEPA_2", 37, "the grasp and reach with object tasks"),
    # "Figure 10. Start and goal ..." is the next line of the paragraph above it.
    ("VJEPA_2", 13, "Lab 1 are shown in Appendix B.2."),
    # "algorithmic and ..." matches the caption pattern as "algorithm ic".
    ("Cosmos", 7, "have different aspect ratios, resolutions"),
])
def test_prose_that_looks_like_a_caption_head_is_not_followed(paper, page, prefix):
    assert kind_of(paper, page, prefix) == "body"


def test_a_paragraph_a_space_below_is_not_the_caption():
    """Cosmos p11 sets its prose 2.7 ems under `Figure 6:`'s last full line (`WRAP_EMS`)."""
    assert kind_of("Cosmos", 11, "Tokenizers come in two types") == "body"


@pytest.mark.parametrize("head, joined", [
    ("Fig. 3: Overview of our framework. We start with", True),
    ("Figure 10. Start and goal frames for all tasks", True),
    ("Algorithm 1 RL with Experience and Corrections via", True),
    ("TABLE I: Inference time of our model on an NVIDIA", True),
    ("Figure 14 shows examples of start and goal frames", False),
    ("Table 4 and Table 5 present a detailed comparison", False),
    ("Figure 4 (Left) compares the performance of a model", False),
    ("algorithmic and an infrastructural perspective. The", False),
])
def test_only_a_caption_head_opens_a_block(head, joined):
    rest = mk_line(1, "the rest of the block, set to the full measure", 112.0)
    lines = (mk_line(0, head, 100.0), rest)
    assert capwrap.caption_rest(lines, 0, lambda j: True) == ([1] if joined else [])


def test_the_block_ends_after_its_short_last_line():
    lines = (
        mk_line(0, "Fig. 2: A caption set in the body's type, run to the full measure", 100.0),
        mk_line(1, "and wrapped once more, to the full measure again", 112.0),
        mk_line(2, "then a short last line.", 124.0, x1=200.0),
        mk_line(3, "Prose that starts right under it, one step down", 136.0),
    )
    assert capwrap.caption_rest(lines, 0, lambda j: True) == [1, 2]


def test_a_claimed_line_ends_the_block():
    lines = (mk_line(0, "Fig. 2: A caption", 100.0),
             mk_line(1, "claimed by an earlier rule", 112.0))
    assert capwrap.caption_rest(lines, 0, lambda j: j != 1) == []


def test_a_wider_line_below_is_not_the_caption():
    """A column caption over a paragraph that runs past its right edge (U16 `_wraps`)."""
    lines = (mk_line(0, "Fig. 4: A caption set in one column's measure", 100.0, x1=300.0),
             mk_line(1, "prose below it that runs on across the full page", 112.0))
    assert capwrap.caption_rest(lines, 0, lambda j: True) == []


def test_an_indented_paragraph_below_is_not_the_caption():
    """A wrapped line starts within `EDGE_TOL` of the caption's edge; a paragraph indent doesn't."""
    lines = (mk_line(0, "Fig. 5: A caption set in the body's type, run to the full measure", 100.0),
             mk_line(1, "A paragraph that opens with an indent", 112.0, x0=87.0))
    assert capwrap.caption_rest(lines, 0, lambda j: True) == []
