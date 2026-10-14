"""U17b: the bibliography starts at its heading in reading order, not at its baseline.

PiZero.pdf p12 sets "REFERENCES" at the foot of the left column (y 538). Bounding the span
by `y >= reference_y` left the right column's entries above that y, "[4]" to "[8] Serkan
Cabi…", to be read as body. The fixture is the page's real geometry, abridged.
"""

from __future__ import annotations

from kokoro_reader.textpipe.classify import classify_page
from kokoro_reader.textpipe.types import DocStats

from .test_set_prose import LETTER_H, LETTER_W, kind_of, page

PIZERO_P12 = (
    (36, "a full contribution statement, see Appendix A.", 49.0, 239.0, 514.8, 10.0, "g_d6_f3"),
    (37, "REFERENCES", 146.6, 202.4, 538.2, 8.0, "g_d6_f3"),
    (38, "[1] Josh Achiam, Steven Adler, Sandhini Agarwal, Lama", 53.9, 300.0, 556.1, 10.0, "g_d6_f3"),
    (39, "Ahmad, Ilge Akkaya, Florencia Leoni Aleman, Diogo", 70.5, 300.0, 568.1, 10.0, "g_d6_f3"),
    (40, "Flamingo: a visual language model for few-shot learning.", 70.5, 300.0, 723.5, 10.0, "g_d6_f3"),
    (41, "Advances in neural information processing systems, 35:", 333.6, 563.0, 66.0, 10.0, "g_d6_f6"),
    (42, "23716–23736, 2022.", 333.6, 416.7, 77.9, 10.0, "g_d6_f3"),
    (43, "[4] Jorge Aldaco, Travis Armstrong, Robert Baruch,", 317.0, 563.0, 89.9, 10.0, "g_d6_f3"),
    (44, "Jeff Bingham, Sanky Chan, Kenneth Draper, De-", 333.6, 563.0, 101.8, 10.0, "g_d6_f3"),
    (45, "[8] Serkan Cabi, Sergio G´omez Colmenarejo, Alexander", 317.0, 563.0, 508.3, 10.0, "g_d6_f3"),
    (46, "Novikov, Ksenia Konyushkova, Scott Reed, Rae Jeong,", 333.6, 563.0, 520.3, 10.0, "g_d6_f3"),
    (47, "et al. Scaling data-driven robotics with reward sketch-", 333.6, 563.0, 544.2, 10.0, "g_d6_f3"),
)
STATS = DocStats(body_size=10.0, num_pages=22, reference_page=12, reference_y=538.2)


def test_the_column_after_a_mid_page_reference_heading_is_bibliography() -> None:
    # Act
    blocks = classify_page(page(12, PIZERO_P12, LETTER_W, LETTER_H), STATS)

    # Assert
    assert [kind_of(blocks, i) for i in range(37, 48)] == ["reference"] * 11


def test_the_prose_above_the_reference_heading_is_still_read() -> None:
    # Act
    blocks = classify_page(page(12, PIZERO_P12, LETTER_W, LETTER_H), STATS)

    # Assert
    assert kind_of(blocks, 36) == "body"


# U17c: an arXiv id inside a reference is part of the reference, not the side stamp.


def test_a_reference_line_citing_an_arxiv_id_stays_in_the_bibliography() -> None:
    # Arrange
    rows = (*PIZERO_P12,
            (48, "in robotic affordances. arXiv preprint arXiv:2204.01691,", 333.6, 563.0, 556.1, 10.0, "g_d6_f6"),
            (49, "arXiv: 2309.03905 [cs.MM].", 333.6, 450.0, 568.1, 10.0, "g_d6_f6"),
            (50, "preprint arXiv:2406.09246, 2024.", 333.6, 450.0, 580.0, 10.0, "g_d6_f6"))

    # Act
    blocks = classify_page(page(12, rows, LETTER_W, LETTER_H), STATS)

    # Assert
    assert [kind_of(blocks, i) for i in (48, 49, 50)] == ["reference"] * 3


def test_the_arxiv_and_preprint_stamps_are_still_furniture() -> None:
    # Arrange
    rows = ((0, "arXiv:2206.11894v2 [cs.CV] 6 Aug 2022", 32.0, 52.0, 211.7, 20.0, "g_d3_f8"),
            (1, "Preprint. February 17, 2026.", 72.0, 190.0, 760.0, 9.0, "g_d3_f8"))

    # Act
    blocks = classify_page(page(1, rows, LETTER_W, LETTER_H), STATS)

    # Assert
    assert [b.reason for b in blocks] == ["arXiv stamp", "preprint stamp"]
