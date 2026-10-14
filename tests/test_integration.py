"""End-to-end checks across module boundaries.

These are the tests that catch the failures unit tests structurally cannot: a route
wired to the wrong function, a dataclass field renamed on one side of the HTTP
boundary, or the app failing to import at all.
"""

from __future__ import annotations

import inspect

import pytest
from fastapi.testclient import TestClient


@pytest.fixture()
def client(tmp_path, monkeypatch):
    from kokoro_reader import config, notes_store

    monkeypatch.setattr(config, "DOCS_DIR", tmp_path / "docs")
    monkeypatch.setattr(notes_store, "DOCS_DIR", tmp_path / "docs", raising=False)
    (tmp_path / "docs").mkdir(parents=True, exist_ok=True)

    from fastapi import FastAPI

    from kokoro_reader.routes import health, notes, pdf, script

    app = FastAPI()
    for router in (health.router, notes.router, pdf.router, script.router):
        app.include_router(router)
    return TestClient(app)


# ── Fixtures shaped like real pdf.js output ──────────────────────────────────


def _line(idx, text, y, *, x0=72.0, x1=520.0, size=9.9, font="g_d0_f1", items=None):
    items = items or [idx * 3, idx * 3 + 1]
    return {
        "idx": idx,
        "text": text,
        "x0": x0,
        "x1": x1,
        "y": y,
        "size": size,
        "font": font,
        "items": items,
        "item_x": [x0 + 10 * i for i in range(len(items))],
        "item_text": [text] + [""] * (len(items) - 1),
        "item_size": [size] * len(items),
    }


def _paper_page():
    """One page carrying body prose, a running head, a page number and a table."""
    return {
        "page": 3,
        "width": 612.0,
        "height": 792.0,
        "lines": [
            _line(0, "Under review as a conference paper at ICLR 2026", 40.0, size=8.5),
            _line(1, "We show that the estimator converges at the expected rate.", 140.0),
            _line(2, "This holds under the assumptions stated in the previous section.", 155.0),
            _line(3, "Table 2: Accuracy across three datasets.", 320.0, size=8.6),
            _line(4, "Method   MNIST   CIFAR   IMDB", 340.0,
                  items=[40, 41, 42, 43]),
            _line(5, "Ours     99.1    84.3    91.0", 355.0, items=[44, 45, 46, 47]),
            _line(6, "Base     98.2    80.1    88.4", 370.0, items=[48, 49, 50, 51]),
            _line(7, "Prior    97.9    79.6    87.2", 385.0, items=[52, 53, 54, 55]),
            _line(8, "760", 760.0, x0=300.0, x1=310.0, size=9.0),
        ],
    }


def _payload(**overrides):
    base = {
        "doc_id": "a" * 40,
        "stats": {
            "body_size": 9.9,
            "num_pages": 12,
            "repeated": ["under review as a conference paper at iclr ####"],
            "reference_page": None,
        },
        "pages": [_paper_page()],
        "options": {},
    }
    base.update(overrides)
    return base


# ── Health ───────────────────────────────────────────────────────────────────


def test_health_reports_ok_without_loading_any_model(client):
    body = client.get("/api/health").json()

    assert body["ok"] is True
    assert body["tts_ready"] is False
    assert "llm_model" in body


def test_tts_route_is_sync_so_it_cannot_block_the_event_loop():
    """Requirement R2. An async handler here is the defect that froze the old app."""
    from kokoro_reader.routes import health as health_mod
    from kokoro_reader.routes import tts as tts_mod

    handler = tts_mod.router.routes[0].endpoint
    assert not inspect.iscoroutinefunction(handler)
    assert inspect.iscoroutinefunction(health_mod.router.routes[0].endpoint)


# ── Script building ──────────────────────────────────────────────────────────


def test_script_build_returns_sentences_and_blocks(client):
    res = client.post("/api/script/build", json=_payload())

    assert res.status_code == 200
    body = res.json()
    assert body["sentences"], "a page of prose must produce at least one sentence"
    assert body["blocks"]
    assert "skipped" in body["stats"]


def test_running_head_and_page_number_are_never_spoken(client):
    body = client.post("/api/script/build", json=_payload()).json()

    spoken = " ".join(s["text"] for s in body["sentences"]).lower()
    assert "under review" not in spoken
    assert "iclr" not in spoken
    assert not any(s["text"].strip() == "760" for s in body["sentences"])


def test_table_rows_are_not_spoken_but_the_caption_is(client):
    body = client.post("/api/script/build", json=_payload()).json()

    spoken = " ".join(s["text"] for s in body["sentences"])
    assert "99.1" not in spoken, "table cell values leaked into the script"
    assert "Accuracy across three datasets" in spoken


def test_body_prose_survives_the_filters(client):
    body = client.post("/api/script/build", json=_payload()).json()

    spoken = " ".join(s["text"] for s in body["sentences"])
    assert "estimator converges" in spoken


def test_enabling_tables_makes_them_speakable(client):
    payload = _payload(options={"read_tables": True})

    body = client.post("/api/script/build", json=payload).json()

    spoken = " ".join(s["text"] for s in body["sentences"])
    assert "99.1" in spoken


def test_every_skipped_block_explains_itself(client):
    body = client.post("/api/script/build", json=_payload()).json()

    skipped = [b for b in body["blocks"] if not b["speak"]]
    assert skipped, "this fixture is meant to exercise the filters"
    assert all(b["reason"] for b in skipped), "a silent skip is indistinguishable from a bug"


def test_sentences_carry_item_indices_for_on_page_highlighting(client):
    body = client.post("/api/script/build", json=_payload()).json()

    assert all(isinstance(s["items"], list) for s in body["sentences"])
    assert any(s["items"] for s in body["sentences"])


def test_empty_page_list_is_rejected(client):
    res = client.post("/api/script/build", json=_payload(pages=[]))

    assert res.status_code == 400


def test_malformed_geometry_is_rejected_not_crashed(client):
    res = client.post("/api/script/build", json=_payload(pages=[{"nope": True}]))

    assert res.status_code == 400


def test_math_in_body_text_is_verbalised(client):
    page = {
        "page": 1,
        "width": 612.0,
        "height": 792.0,
        "lines": [
            _line(0, "The bound holds whenever x ≤ n for all i in the index set.", 200.0),
        ],
    }

    body = client.post("/api/script/build", json=_payload(pages=[page])).json()

    spoken = " ".join(s["text"] for s in body["sentences"])
    assert "≤" not in spoken, "a raw glyph reached the voice"
    assert "less than or equal" in spoken.lower()


# ── Notes ────────────────────────────────────────────────────────────────────


def test_notes_round_trip_through_the_api(client):
    doc_id = "b" * 40
    record = {
        "doc_id": doc_id,
        "title": "Attention Is All You Need",
        "highlights": [{
            "id": "h1", "page": 2, "color": "green", "text": "scaled dot-product",
            "note": "compare with additive attention",
            "rects": [{"x": 0.1, "y": 0.2, "w": 0.3, "h": 0.02}],
        }],
        "last_index": 42,
        "options": {},
    }

    client.put(f"/api/notes/{doc_id}", json=record)
    got = client.get(f"/api/notes/{doc_id}").json()

    assert got["last_index"] == 42
    assert len(got["highlights"]) == 1
    assert got["highlights"][0]["note"] == "compare with additive attention"


def test_unknown_document_returns_an_empty_record_not_a_404(client):
    res = client.get(f"/api/notes/{'c' * 40}")

    assert res.status_code == 200
    assert res.json()["highlights"] == []


def test_markdown_export_contains_the_highlight(client):
    doc_id = "d" * 40
    client.put(f"/api/notes/{doc_id}", json={
        "doc_id": doc_id, "title": "Paper", "last_index": 0, "options": {},
        "highlights": [{"id": "x", "page": 1, "color": "yellow",
                        "text": "the key claim", "note": "check this", "rects": []}],
    })

    res = client.get(f"/api/notes/{doc_id}/export.md")

    assert res.status_code == 200
    assert "the key claim" in res.text
    assert "check this" in res.text


def test_traversal_attempt_in_doc_id_is_rejected(client):
    res = client.get("/api/notes/..%2F..%2Fetc%2Fpasswd")

    assert res.status_code in (400, 404)


# ── PDF route ────────────────────────────────────────────────────────────────


def test_pdf_route_reports_no_selection(client):
    assert client.get("/api/pdf").status_code == 404
