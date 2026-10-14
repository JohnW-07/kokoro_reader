"""U17e: a bullet's hanging-indent continuation belongs to the bullet.

GR00TN1.pdf p11 sets each item's second line 11pt right of its "•". The indent rule read
that as a new paragraph, so "(Grau-" and "man et al., 2024);" were voiced in different
blocks and the citation came out as "(Grauman and others;". Real geometry, one item a line.
"""

from __future__ import annotations

from kokoro_reader.config import ReadOptions
from kokoro_reader.textpipe import pipeline
from kokoro_reader.textpipe.classify import classify_page, compute_doc_stats

from .test_set_prose import A4_H, A4_W, page

GROOT_P11 = (
    (8, "first-person perspectives of hand-object interactions (examples shown in Figure 14). Our video datasets include", 62.4, 532.9, 339.5, 10.0, "g_d1_f3"),
    (9, "the following:", 62.4, 122.4, 353.2, 10.0, "g_d1_f3"),
    (10, "• Ego4D is a large-scale egocentric video dataset that includes diverse recordings of everyday activi-", 76.4, 534.5, 373.8, 10.0, "g_d1_f3"),
    (11, "ties (Grauman et al., 2022);", 87.3, 208.7, 387.6, 10.0, "g_d1_f3"),
    (12, "• Ego-Exo4D adds complementary exocentric (third-person) views alongside first-person recordings (Grau-", 76.4, 534.5, 401.3, 10.0, "g_d1_f3"),
    (13, "man et al., 2024);", 87.3, 165.6, 415.1, 10.0, "g_d1_f3"),
    (14, "• Assembly-101 focuses on complex assembly tasks by providing detailed videos of step-by-step object", 76.4, 533.1, 428.8, 10.0, "g_d1_f3"),
    (15, "assembly (Sener et al., 2022);", 87.3, 217.1, 442.6, 10.0, "g_d1_f3"),
)


def test_a_bullet_and_its_hanging_continuation_are_one_block() -> None:
    # Arrange
    geom = page(11, GROOT_P11, A4_W, A4_H)

    # Act
    blocks = classify_page(geom, compute_doc_stats([geom]))

    # Assert
    together = [b.line_ids for b in blocks if 12 in b.line_ids or 13 in b.line_ids]
    assert len(together) == 1 and {12, 13} <= set(together[0])


def test_a_citation_broken_across_a_bullet_continuation_is_read_whole() -> None:
    # Arrange
    geom = page(11, GROOT_P11, A4_W, A4_H)

    # Act
    sentences, _, _ = pipeline.build_script([geom], compute_doc_stats([geom]), ReadOptions())

    # Assert
    said = " ".join(s.text for s in sentences)
    assert "Ego-Exo4D" in said
    assert said.count("(") == said.count(")")


def test_a_line_indented_past_the_hang_is_a_new_block() -> None:
    """Only a hang is exempt: a nested item set 3 ems past the "•" is its own paragraph.

    The corpus has no such line, so it is made from p11's item 12: size 10, so 3 ems is 30pt.
    """
    # Arrange
    nested = (13, "◦ Ego-Exo4D Keystep annotates procedural steps across the same recordings.",
              76.4 + 3 * 10.0, 520.0, 415.1, 10.0, "g_d1_f3")
    geom = page(11, (*GROOT_P11[:5], nested), A4_W, A4_H)

    # Act
    blocks = classify_page(geom, compute_doc_stats([geom]))

    # Assert
    assert not any({12, 13} <= set(b.line_ids) for b in blocks)
