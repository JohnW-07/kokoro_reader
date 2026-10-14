"""N4: a sentence that runs over a page turn is read, highlighted and batched whole.

`fixtures/page_turns.json` holds real `pdfview.buildPageGeometry` pages, two or three per
paper, cut from the corpus. Before N4 `_continues` required both halves on one page, so
thinkstats p17 read "...the default name of the data file and the" and then, as a
sentence of its own, "type of record to create." -- and PiZero p2|p3 read
"vision-language-" then "action (VLA) model."
"""

from __future__ import annotations

import functools
import json
from dataclasses import replace
from pathlib import Path

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from kokoro_reader.config import ReadOptions
from kokoro_reader.routes import script as script_routes
from kokoro_reader.textpipe import pipeline
from kokoro_reader.textpipe.types import Block, DocStats, Line, PageGeometry

FIXTURE = Path(__file__).parent / "fixtures" / "page_turns.json"
COSMOS = "CosmosWorldFoundationModelPlatformforPhysicalAI"
THINKSTATS_TAIL = "default name of the data file and the"
THINKSTATS_HEAD = "type of record to create."


@functools.cache
def _fixture() -> dict:
    return json.loads(FIXTURE.read_text())


def pages_of(doc: str, numbers) -> tuple[PageGeometry, ...]:
    return tuple(PageGeometry.from_json(p) for p in _fixture()[doc]["pages"]
                 if p["page"] in numbers)


def stats_of(doc: str) -> DocStats:
    return DocStats.from_json(_fixture()[doc]["stats"])


def build(doc: str, numbers, options: ReadOptions | None = None, own=None, pages=None):
    geoms = pages if pages is not None else pages_of(doc, numbers)
    sentences, _, _ = pipeline.build_script(geoms, stats_of(doc), options, own=own)
    return sentences


def holding(sentences, text: str):
    return [s for s in sentences if text in s.text]


def page_items(geom: PageGeometry) -> set[int]:
    return {i for ln in geom.lines for i in ln.items}


def retext(geom: PageGeometry, find: str, swap) -> PageGeometry:
    """`geom` with `swap` applied to the one line, and its last item, that contains `find`."""
    def fix(ln: Line) -> Line:
        if find not in ln.text:
            return ln
        return replace(ln, text=swap(ln.text), item_text=(*ln.item_text[:-1], swap(ln.item_text[-1])))
    return replace(geom, lines=tuple(fix(ln) for ln in geom.lines))


# ── The join ──────────────────────────────────────────────────────────────────


def test_a_sentence_across_the_page_turn_is_one_sentence():
    sentences = build("thinkstats", (17, 18))

    [whole] = holding(sentences, f"{THINKSTATS_TAIL} {THINKSTATS_HEAD}")
    assert whole.page == 17, "page stays the start page, for every consumer that reads it"
    assert [page for page, _ in whole.parts] == [17, 18]
    assert not [s for s in sentences if s.text == THINKSTATS_HEAD]


def test_each_part_highlights_its_own_page_and_items_is_the_start_page():
    p17, p18 = pages_of("thinkstats", (17, 18))
    [whole] = holding(build("thinkstats", (17, 18)), THINKSTATS_HEAD)
    (first, first_items), (second, second_items) = whole.parts

    assert first_items and set(first_items) <= page_items(p17)
    assert second_items and set(second_items) <= page_items(p18)
    assert whole.items == first_items, "a client that knows no spans still paints the start"


def test_only_a_page_crossing_sentence_carries_spans_in_json():
    sentences = build("thinkstats", (17, 18))
    [whole] = holding(sentences, THINKSTATS_HEAD)

    assert [part["page"] for part in whole.to_json()["spans"]] == [17, 18]
    assert whole.to_json()["spans"][1]["items"] == list(whole.parts[1][1])
    single = [s for s in sentences if s is not whole]
    assert single and all("spans" not in s.to_json() for s in single)


def test_a_compound_broken_at_the_page_turn_keeps_its_hyphen():
    """PiZero p2 right column foot | p3 left column head."""
    sentences = build("PiZero", (2, 3))

    assert holding(sentences, "turning it into a vision-language-action (VLA) model.")
    assert not [s for s in sentences if s.text == "action (VLA) model."]


def test_a_word_broken_at_the_page_turn_is_rejoined_past_the_captions_between():
    """VLALitReview: `Specifi-` ends p1; p2 opens on a figure whose caption is read first."""
    sentences = build("VLALitReview", (1, 2))

    [whole] = holding(sentences, "Specifically, beyond architecture")
    assert not holding(sentences, "Specifi-")
    caption = holding(sentences, "Structure of this survey.")[0]
    assert sentences.index(whole) < sentences.index(caption), "the sentence finishes first"


def test_captions_between_the_halves_are_read_after_the_sentence():
    sentences = build("iVideoGPT", (1, 2))

    [whole] = holding(sentences, "environments with simple visuals and have limited capability")
    captions = [s for s in sentences if s.kind == "caption" and s.page == 2]
    assert captions and all(sentences.index(c) > sentences.index(whole) for c in captions)


def test_a_footnote_read_between_the_halves_does_not_split_the_sentence():
    options = ReadOptions(read_footnotes=True)
    sentences = build("GR00TN1", (1, 2), options)

    [whole] = holding(sentences, "degrees of freedom, control modes, and other factors")
    footnote = holding(sentences, "list of contributors")[0]
    assert footnote.kind == "footnote" and sentences.index(footnote) > sentences.index(whole)


def test_a_one_line_head_that_ends_its_paragraph_joins():
    """Cosmos p3|p4: the head is the short last line of its paragraph."""
    sentences = build(COSMOS, (3, 4))

    assert holding(sentences, "can be fine-tuned for various autonomous driving-related tasks.")


# ── Where it must not join ────────────────────────────────────────────────────


def test_a_heading_at_the_top_of_the_next_page_ends_the_sentence():
    sentences = build("art_of_statistics", (10, 11))

    [tail] = holding(sentences, "desire to use data in the best way possible")
    assert len(tail.parts) == 1 and tail.text.endswith("possible")


def test_an_equation_between_the_halves_ends_the_sentence():
    sentences = build("thinkstats", (42, 43))

    assert [s.text for s in holding(sentences, "and you can download it from")] == [
        "and you can download it from"]


def test_a_label_set_narrower_than_the_column_is_not_glued_on():
    """Cosmos p2 ends on a one-line figure label; p3's prose is set to the full measure."""
    sentences = build(COSMOS, (2, 3))

    assert not holding(sentences, "Autonomous Driving videos")
    assert all(len(s.parts) == 1 for s in sentences)


def test_a_finished_sentence_or_a_capital_head_does_not_join():
    p17, p18 = pages_of("thinkstats", (17, 18))
    stopped = (retext(p17, "data file and the", lambda t: t + "."), p18)
    capital = (p17, retext(p18, "type of record to create", lambda t: t.replace("type", "Type", 1)))

    for pages in (stopped, capital):
        sentences = build("thinkstats", (), pages=pages)
        assert all(len(s.parts) == 1 for s in sentences)


COLUMN = (72.0, 472.0)


def synth_line(idx: int, page: int, x1: float = COLUMN[1]) -> Line:
    text = f"words on page {page} line {idx} that run on"
    return Line(idx=idx, text=text, x0=COLUMN[0], x1=x1, y=700.0 + idx * 12.0, size=10.0,
                items=(page * 10 + idx,), item_x=(COLUMN[0],), item_text=(text,), item_size=(10.0,))


def synth_block(page: int, lines: list[Line], kind: str = "body") -> Block:
    text = " ".join(ln.text for ln in lines)
    return Block(kind=kind, text=text, page=page, line_ids=tuple(ln.idx for ln in lines),
                 items=tuple(i for ln in lines for i in ln.items), spoken=text)


def synth_sentences(blocks: list[tuple[int, list[Line], str]]):
    """`_to_sentences` over hand-made blocks: (page, lines, kind) each."""
    lines = {}
    for page, block_lines, _ in blocks:
        lines.setdefault(page, {}).update({ln.idx: ln for ln in block_lines})
    out, _ = pipeline._to_sentences([synth_block(page, ls, kind) for page, ls, kind in blocks],
                                    lines, dict.fromkeys(lines, 12.0))
    return [[page for page, _ in s.parts] for s in out]


def test_a_sentence_crosses_at_most_one_page_turn():
    """A page holding one unfinished clause joins the page before, not both neighbours."""
    blocks = [(page, [synth_line(0, page)], "body") for page in (1, 2, 3)]

    assert synth_sentences(blocks) == [[1, 2], [3]]


def test_a_sentence_that_turned_a_page_takes_no_second_head_past_a_caption():
    """Past the turn the page's own rules decide; the turn's caption skip does not apply again."""
    blocks = [(1, [synth_line(0, 1)], "body"), (2, [synth_line(0, 2)], "body"),
              (2, [synth_line(1, 2)], "caption"), (2, [synth_line(2, 2)], "body")]

    assert synth_sentences(blocks) == [[1, 2], [2], [2]]


def test_a_tail_whose_last_line_stops_short_ended_its_paragraph():
    short = COLUMN[0] + (COLUMN[1] - COLUMN[0]) / 2
    blocks = [(1, [synth_line(0, 1), synth_line(1, 1, x1=short)], "body"),
              (2, [synth_line(0, 2), synth_line(1, 2)], "body")]

    assert synth_sentences(blocks) == [[1], [2]]


# ── Page batches (the seam) ───────────────────────────────────────────────────


def test_a_batch_returns_only_sentences_starting_on_its_own_pages():
    before = build("thinkstats", (17, 18), own=(17, 17))
    after = build("thinkstats", (17, 18), own=(18, 18))

    assert holding(before, f"{THINKSTATS_TAIL} {THINKSTATS_HEAD}"), "the owner builds it whole"
    assert not holding(after, THINKSTATS_HEAD), "the next batch must not read the head again"
    assert all(s.page == 18 for s in after) and all(s.page == 17 for s in before)


def test_owned_batches_with_context_add_up_to_the_whole_build():
    whole = build("thinkstats", (17, 18))
    halves = build("thinkstats", (17, 18), own=(17, 17)) + build("thinkstats", (17, 18), own=(18, 18))

    assert [s.to_json() for s in halves] == [s.to_json() for s in whole]


def test_the_report_counts_only_owned_pages():
    pages, stats = pages_of("thinkstats", (17, 18)), stats_of("thinkstats")
    sentences, blocks, report = pipeline.build_script(pages, stats, own=(18, 18))

    assert report["sentences"] == len(sentences)
    assert blocks and all(b.page == 18 for b in blocks)


@pytest.fixture()
def script_client():
    app = FastAPI()
    app.include_router(script_routes.router)
    return TestClient(app)


def _request(own_from=None, own_to=None) -> dict:
    payload = {"stats": _fixture()["thinkstats"]["stats"],
               "pages": [p for p in _fixture()["thinkstats"]["pages"] if p["page"] in (17, 18)]}
    if own_from is not None:
        payload["own_from"] = own_from
    if own_to is not None:
        payload["own_to"] = own_to
    return payload


def test_the_route_filters_to_the_pages_a_batch_owns(script_client):
    res = script_client.post("/api/script/build", json=_request(18, 18))

    assert res.status_code == 200
    body = res.json()
    assert body["sentences"] and all(s["page"] == 18 for s in body["sentences"])
    assert all(b["page"] == 18 for b in body["blocks"])


@pytest.mark.parametrize("own_from, own_to", [(18, 17), (17, None), (0, 3)])
def test_the_route_refuses_a_malformed_page_range(script_client, own_from, own_to):
    assert script_client.post("/api/script/build", json=_request(own_from, own_to)).status_code == 422
