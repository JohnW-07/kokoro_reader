"""U17a: a real heading is read aloud, however short, and read whole.

Two losses, both at the speakable floor. "Abstract" (GR00TN1 p1) is eight characters, so
`_voice` silenced it. "4. Tokenizer" (Cosmos p11), read "4. Tokenizer.", was split after its number into "4."
and "Tokenizer.", and both pieces fell below the floor `_to_sentences` applies at the end.
"""

from __future__ import annotations

import pytest

from kokoro_reader.config import ReadOptions
from kokoro_reader.textpipe import pipeline
from kokoro_reader.textpipe.types import Block

from .test_classify import BODY, BOLD_FONT, LEFT, mk_line, mk_page
from .test_pipeline import THREE_SENTENCES, build, PARA_LEADING


def voiced_heading(text: str) -> Block:
    return pipeline._voice(Block(kind="heading", text=text, page=1), ReadOptions(), None)


def heading_page(text: str):
    return [mk_page(1, [
        mk_line(0, text, 100.0, x1=LEFT + 110.0, size=BODY + 3.0, font=BOLD_FONT),
        *[mk_line(1 + i, t, 130.0 + PARA_LEADING * i) for i, t in enumerate(THREE_SENTENCES)],
    ])]


@pytest.mark.parametrize("text", ["Abstract", "Contents", "Appendix", "1) Vision"])
def test_a_one_word_heading_is_read(text: str) -> None:
    # Act
    block = voiced_heading(text)

    # Assert
    assert block.speak, block.reason


@pytest.mark.parametrize("text", ["T", "K", "ψ", "NVIDIA^1", "(a)"])
def test_a_stray_glyph_tagged_heading_stays_silent(text: str) -> None:
    # Act
    block = voiced_heading(text)

    # Assert
    assert not block.speak


def test_a_title_led_by_a_symbol_is_read_with_its_symbol() -> None:
    """J8: PiZero p1's title once read ": A Vision-Language-Action Flow Model for" --
    `π0` was a line of its own and fell below the floor like any stray glyph. Since
    U16 the extractor keeps it on the title line, and the floor must not take it back."""
    # Act
    block = voiced_heading("π_0: A Vision-Language-Action Flow Model for")

    # Assert
    assert block.speak, block.reason
    assert block.spoken.startswith("pi sub 0: A Vision")


@pytest.mark.parametrize("text, said", [
    ("4. Tokenizer", "4. Tokenizer."),
    ("II. CHALLENGES", "II. CHALLENGES."),
    ("Abstract", "Abstract."),
])
def test_a_heading_is_one_utterance_that_survives_the_final_floor(text: str, said: str) -> None:
    # Act
    sentences, _, _ = build(heading_page(text))

    # Assert
    assert [s.text for s in sentences if s.kind == "heading"] == [said]
