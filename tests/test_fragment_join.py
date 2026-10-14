"""U14: the floor runs after the join, so a fragment that finishes a sentence is read.

The fixtures are real `pdfview.buildPageGeometry` lines, trimmed to the blocks a join
looks at. Before U14 `normalize.is_speakable` judged each piece and each block on its own,
before `_to_sentences` could reunite them: GR00TN1.pdf p1 read "...and rapidly learn new"
and dropped "tasks." -- cut off from its sentence by the arXiv stamp between the blocks.
"""

from __future__ import annotations

from dataclasses import replace

import pytest

from kokoro_reader.config import ReadOptions
from kokoro_reader.textpipe import pipeline
from kokoro_reader.textpipe.types import Block, DocStats, PageGeometry

from .test_heading_wrap import A4_H, A4_W, GROOT_STATS, real

COSMOS_STATS = DocStats(
    body_size=10.0, num_pages=75, repeated_y=frozenset({62, 786}),
    repeated=frozenset({"cosmos world foundation model platform for physical ai", "#"}),
)
FONT = "g_d0_f3"
SIZE = 9.9626
BULLET = ["•", " "]
PROSE_REASON = "prose"  # classify's reason for a body paragraph


def item(idx, text, x0, x1, y, *, font=FONT):
    """A line the client sent as one text item."""
    return real(idx, text, x0, x1, y, 10, font, [idx + 100], [x0], [text], [SIZE])


def bullet(idx, label, rest, x1, y, rest_x):
    """A `• Label: rest` line as Cosmos sets it: bullet, space, label, rest."""
    text = f"• {label}{rest}"
    return real(idx, text, 76.409, x1, y, 10, FONT, [idx + 100, idx + 101, idx + 102, idx + 103],
                [76.409, 82.287, 87.269, rest_x], [*BULLET, label, rest], [SIZE] * 4)


def groot_p1_stamp() -> PageGeometry:
    """GR00TN1.pdf p1: the rotated arXiv stamp sits on the baseline of `learn new`."""
    lines = (
        item(7, "world. A robot foundation model, trained on massive and diverse data "
                "sources, is essential for enabling", 61.964, 532.910, 243.162, font="g_d1_f2"),
        item(8, "the robots to reason about novel situations, robustly handle real-world "
                "variability, and rapidly learn new", 62.362, 533.307, 257.508, font="g_d1_f2"),
        real(9, "arXiv:2503.14734v2 [cs.RO] 27 Mar 2025", 32, 52, 257.71, 20, "g_d1_f5",
             [64], [32], ["arXiv:2503.14734v2 [cs.RO] 27 Mar 2025"], [20]),
        item(10, "tasks. To this end, we introduce GR00T N1, an open foundation model for "
                 "humanoid robots. GR00T", 62.362, 533.211, 271.854, font="g_d1_f2"),
        item(11, "N1 is a Vision-Language-Action (VLA) model with a dual-system architecture. "
                 "The vision-language", 62.362, 532.917, 286.201, font="g_d1_f2"),
    )
    return PageGeometry(page=1, width=A4_W, height=A4_H, lines=lines)


def cosmos_p4_instead() -> PageGeometry:
    """Cosmos p4: a bullet ends `...system. Instead`; its hanging indent goes on `of ...`."""
    lines = (
        real(23, "• Policy evaluation. This refers to evaluating the quality of a policy model "
                 "in a Physical AI system. Instead", 76.409, 532.910, 495.26, 10, FONT,
             [116, 117, 118, 119, 120], [76.409, 82.287, 87.269, 166.645, 169.86],
             [*BULLET, "Policy evaluation.", " ", "This refers to evaluating the quality of a "
              "policy model in a Physical AI system. Instead"], [SIZE] * 5),
        item(24, "of evaluating a trained policy by deploying it to a Physical AI system "
                 "operating in the real world, one", 87.269, 532.917, 509.009),
        item(25, "could instead let the digital copy of the Physical AI system interact with "
                 "the world foundation model. The", 87.269, 532.917, 522.757),
    )
    return PageGeometry(page=4, width=A4_W, height=A4_H, lines=lines)


def cosmos_p47_objects() -> PageGeometry:
    """Cosmos p47: `objects?` is a block of its own, the hanging indent of the bullet above."""
    lines = (
        bullet(19, "Instruction following", ": Is the generated video aligned with the input "
               "language instruction?", 481.579, 583.286, 183.478),
        bullet(20, "Object permanence", ": Do objects present in the scene remain throughout "
               "the generated video?", 495.486, 597.035, 176.105),
        bullet(21, "Verity", ": Does the generated video faithfully represent the real world "
               "without unexpected imaginary", 533.157, 610.783, 114.946),
        item(22, "objects?", 87.269, 122.148, 624.531),
        bullet(23, "Overall", ": Is the generated video reasonable for the robot to plan "
               "accordingly?", 420.069, 638.28, 119.946),
    )
    return PageGeometry(page=47, width=A4_W, height=A4_H, lines=lines)


def build(page: PageGeometry, stats: DocStats):
    return pipeline.build_script((page,), stats, ReadOptions())


def unbulleted(page: PageGeometry, idx: int) -> PageGeometry:
    """`page` with the bullet dropped from line `idx`, which keeps its x0.

    A bullet's hanging indent joins its block (U17e), so the real fixtures no longer cut a
    fragment into a block of its own. Without the bullet the next line is an indent: a new block.
    """
    def strip(ln):
        return replace(ln, text=ln.text[len(BULLET):], items=ln.items[len(BULLET):],
                       item_x=ln.item_x[len(BULLET):], item_text=ln.item_text[len(BULLET):],
                       item_size=ln.item_size[len(BULLET):])
    return replace(page, lines=tuple(strip(ln) if ln.idx == idx else ln for ln in page.lines))


def texts(sentences) -> list[str]:
    return [s.text for s in sentences]


# ── A fragment piece at the head or tail of a block ───────────────────────────


def test_a_fragment_cut_off_by_the_arxiv_stamp_finishes_its_sentence() -> None:
    sentences, _, _ = build(groot_p1_stamp(), GROOT_STATS)

    assert any(t.endswith("and rapidly learn new tasks.") for t in texts(sentences))
    assert "tasks." not in texts(sentences)


def test_a_fragment_at_a_block_tail_starts_the_sentence_that_runs_on() -> None:
    sentences, _, _ = build(cosmos_p4_instead(), COSMOS_STATS)

    assert any(t.startswith("Instead of evaluating a trained policy") for t in texts(sentences))
    assert not any(t.startswith("of evaluating") for t in texts(sentences))
    assert "The" not in texts(sentences)  # the page-foot tail has nothing to finish it


def test_a_joined_block_above_the_floor_keeps_its_own_reason() -> None:
    """Only a fragment is claimed: `of evaluating...` is read on its own merits."""
    _, blocks, _ = build(unbulleted(cosmos_p4_instead(), 23), COSMOS_STATS)

    head = next(b for b in blocks if b.text.startswith("of evaluating"))
    assert head.speak
    assert head.reason == PROSE_REASON


# ── A whole block below the floor ─────────────────────────────────────────────


def test_a_fragment_block_finishes_the_sentence_before_it() -> None:
    sentences, blocks, report = build(unbulleted(cosmos_p47_objects(), 21), COSMOS_STATS)

    fragment = next(b for b in blocks if b.text == "objects?")
    assert any(t.endswith("without unexpected imaginary objects?") for t in texts(sentences))
    assert fragment.speak and fragment.reason == pipeline._CLAIMED_REASON
    assert report["skipped_total"] == 0


def test_a_bullet_hang_is_no_fragment_block_at_all() -> None:
    """The real p47 line: since U17e `objects?` is the bullet's own second line."""
    sentences, blocks, _ = build(cosmos_p47_objects(), COSMOS_STATS)

    assert any(t.endswith("without unexpected imaginary objects?") for t in texts(sentences))
    assert not any(b.text == "objects?" for b in blocks)


def test_a_fragment_block_after_a_finished_sentence_stays_silent() -> None:
    """A guard, not the defect: a fragment is read only as the rest of an open sentence."""
    page = unbulleted(cosmos_p47_objects(), 21)
    verity = next(ln for ln in page.lines if ln.idx == 21)
    finished = replace(verity, text=verity.text + ".",
                       item_text=(*verity.item_text[:-1], verity.item_text[-1] + "."))
    page = replace(page, lines=tuple(finished if ln.idx == 21 else ln for ln in page.lines))

    sentences, blocks, _ = build(page, COSMOS_STATS)

    fragment = next(b for b in blocks if b.text == "objects?")
    assert not fragment.speak and fragment.reason == "nothing speakable"
    assert not any("objects?" in t for t in texts(sentences))


def vjepa2_p1_core_team() -> PageGeometry:
    """V-JEPA 2 p1: the `∗Core Team` key under the author list, then the arXiv stamp."""
    lines = (
        real(9, "∗Core Team", 87.797, 136.419, 221.467, 9, "g_d7_f8", [172, 173],
             [87.797, 92.114], ["∗", "Core Team"], [5.9776, 8.9664]),
        real(10, "arXiv:2506.09985v1 [cs.AI] 11 Jun 2025", 32, 52, 226.02, 20, "g_d7_f1",
             [0], [32], ["arXiv:2506.09985v1 [cs.AI] 11 Jun 2025"], [20]),
        item(11, "A major challenge for modern AI is to learn to understand the world and learn "
                 "to act largely by", 87.418, 524.568, 249.499, font="g_d7_f6"),
    )
    return PageGeometry(page=1, width=612.0, height=792.0, lines=lines)


def test_a_fragment_block_that_finishes_nothing_is_not_read_even_once_verbalised() -> None:
    """A guard: mathspeak reads `∗Core Team` as "star Core Team", which clears the floor."""
    stats = DocStats(body_size=10.0, num_pages=48, repeated_y=frozenset({752}),
                     repeated=frozenset({"#"}))

    sentences, blocks, _ = build(vjepa2_p1_core_team(), stats)

    key = next(b for b in blocks if b.text == "∗Core Team")
    assert not key.speak
    assert not any("Core Team" in t for t in texts(sentences))


@pytest.mark.parametrize(("kind", "rest"), [("body", "objects?"), ("equation", ""),
                                            ("caption", "")])
def test_only_a_prose_fragment_keeps_its_text_for_a_join(kind: str, rest: str) -> None:
    block = pipeline._voice(Block(kind=kind, text="objects?", page=1), ReadOptions(), None)

    assert not block.speak
    assert block.spoken == rest
