"""U16: the figure walk stops at prose, not at a diagram's own wide labels.

The fixtures (`fixtures/u16_pages.json`) are whole pages of real `pdfview.buildPageGeometry`
output, as the U16 client dumps them; the walk reads a page's column edges and prose font,
so it cannot be trimmed to a few lines. Before U16 the first wide body-size label under a
caption spanning both columns ended the walk: VLALitReview.pdf p2 filed its diagram as
section headings ("Challenges of VLA Section II"), VLAW.pdf p5 read its panel titles
("Stack blocks Open book"), and the table under VLALitReview.pdf p23's `TABLE 2.` was read
aloud cell by cell.
"""

from __future__ import annotations

import json
from functools import cache
from pathlib import Path

import pytest

from kokoro_reader.textpipe import wrapfig
from kokoro_reader.textpipe.classify import classify_page
from kokoro_reader.textpipe.types import DocStats, PageGeometry

FIXTURES = Path(__file__).parent / "fixtures" / "u16_pages.json"
VLAW = "VLAW_CoImprovementOfVision"


@cache
def _fixtures() -> dict:
    return json.loads(FIXTURES.read_text(encoding="utf-8"))


@cache
def page_kinds(paper: str, page: int) -> tuple[tuple[str, str | None], ...]:
    """(text, kind) for each line of a fixture page, as the served pipeline tags it:
    `wrapfig.unwrap_page` first (it can reorder lines), then `classify_page`."""
    doc = _fixtures()[paper]
    stats = DocStats.from_json(doc["stats"])
    geom = wrapfig.unwrap_page(PageGeometry.from_json(doc["pages"][str(page)]), stats)
    kinds = {i: b.kind for b in classify_page(geom, stats) for i in b.line_ids}
    return tuple((ln.text, kinds.get(ln.idx)) for ln in geom.lines)


def kind_of(paper: str, page: int, prefix: str) -> str | None:
    """The kind of the one line on the page that starts with `prefix`."""
    found = [kind for text, kind in page_kinds(paper, page) if text.startswith(prefix)]
    assert len(found) == 1, f"{paper} p{page}: {len(found)} lines start {prefix!r}"
    return found[0]


@pytest.mark.parametrize("paper, page, label", [
    ("VLALitReview", 2, "Challenges of VLA Section II"),
    ("VLALitReview", 2, "Design Strategy Vision-Language-Action Model"),
    ("VLALitReview", 2, "Recommendation for Practitioners"),
    ("VLALitReview", 8, "World Model Inverse Dynamics Model"),
    ("VLALitReview", 8, "(1) Action generation (2) Latent action generation"),
    ("VLALitReview", 17, "Robot Data Collection"),
    ("VLALitReview", 17, "Manipulator Teleoperation"),
    (VLAW, 5, "Stack blocks Open book"),
    (VLAW, 5, "Erase markers Scooping Draw circle"),
    (VLAW, 6, "Pretrained Ctrl-world 16.32 0.634"),
    ("Cosmos", 5, "Tokenizers World Foundation Guardrail"),
])
def test_a_wide_diagram_label_is_figure_text(paper, page, label):
    assert kind_of(paper, page, label) == "figure"


@pytest.mark.parametrize("row", [
    "RoboCasa [383]", "LIBERO [343]", "LeVERB-Bench [385]",
    "AI2-THOR [398]", "CHORES [399]", "RoboArena [401]",
])
def test_table_cells_under_a_full_width_caption_stay_silent(row):
    """The cells are sub-body lines one leading apart, but not flush at a column's edge or
    centred on a prose line, so `_set_with` does not take them for a paragraph. Nor are they wide enough to
    be one, which is all that keeps the AI2-THOR, CHORES and RoboArena rows silent."""
    assert kind_of("VLALitReview", 23, row) == "figure"


def test_a_page_diagram_files_no_section_headings():
    headings = [text for text, kind in page_kinds("VLALitReview", 2) if kind == "heading"]
    assert headings == ["II. CHALLENGES"]


@pytest.mark.parametrize("paper, page, prefix, kind", [
    # A 9pt abstract straight under a five-line 10pt caption is prose, not figure type.
    ("PiZero", 1, "Abstract—Robot learning holds tremendous promise", "body"),
    ("PiZero", 1, "the full potential of flexible, general, and dexterous", "body"),
    # Sub-body authors in a centred block are set one leading from each other.
    ("PI0_6", 1, "Ali Amin, Raichelle Aniceto", "body"),
    ("PI0_6", 1, "James Tanner, Marcel Torne", "body"),
    # A flush 12pt section title bounds the walk up from `Figure 4:`.
    ("Cosmos", 5, "2.2. Current Cosmos", "heading"),
    # Prose after a body-type caption is not walked into.
    ("GR00TN1", 7, "end. Only successful demonstrations are retained", "body"),
    ("GR00TN1", 7, "supplement the real-robot data with minimal human costs.", "body"),
    # A title set in the page's prose font is prose, however wide or centred.
    ("InContextLimitation", 1, "In-Context Imitation Learning via Next-Token Prediction", "heading"),
    # A paragraph's short last line: a blank line across both columns must not set the
    # measure its width is judged against (`_measure`).
    ("VLALitReview", 14, "shown in Fig. 7.", "body"),
])
def test_prose_around_a_figure_is_still_read(paper, page, prefix, kind):
    assert kind_of(paper, page, prefix) == kind
