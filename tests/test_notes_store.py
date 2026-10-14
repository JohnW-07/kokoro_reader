"""Tests for the notes store and its routes (R9, R10, R11).

`config.DOCS_DIR` is redirected at `tmp_path` for every test, so the user's real
`~/.kokoro_reader` is never read or written.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from kokoro_reader import config, notes_store
from kokoro_reader.notes_store import Block, DocRecord, Highlight
from kokoro_reader.routes import notes as notes_routes

DOC_A = "a" * 40
DOC_B = "b" * 40
TRAVERSAL_ID = "../../etc/passwd"
RECT = {"x": 0.1, "y": 0.2, "w": 0.3, "h": 0.4}


@pytest.fixture(autouse=True)
def docs_dir(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    monkeypatch.setattr(config, "DOCS_DIR", tmp_path)
    return tmp_path


@pytest.fixture()
def client() -> TestClient:
    app = FastAPI()
    app.include_router(notes_routes.router)
    return TestClient(app)


def _highlight(hl_id: str = "h1", page: int = 1, **kwargs: object) -> Highlight:
    fields: dict = {
        "id": hl_id,
        "page": page,
        "color": "yellow",
        "text": "selected text",
        "note": "a note",
        "rects": (dict(RECT),),
        "created_at": "2026-09-10T00:00:00+00:00",
        "updated_at": "2026-09-10T00:00:00+00:00",
    }
    return Highlight(**{**fields, **kwargs})


# ── store: round trip and absence ─────────────────────────────────────────────


def test_save_then_load_returns_an_equal_record() -> None:
    # Arrange
    record = DocRecord(
        doc_id=DOC_A,
        title="My Paper",
        highlights=(_highlight(), _highlight("h2", page=3, color="green")),
        last_index=17,
        options={"use_llm": True},
    )

    # Act
    saved = notes_store.save(record)
    loaded = notes_store.load(DOC_A)

    # Assert
    assert loaded == saved
    assert loaded.last_index == 17
    assert loaded.options == {"use_llm": True}


def test_load_of_unknown_doc_returns_empty_record_and_creates_no_file(
    docs_dir: Path,
) -> None:
    # Act
    record = notes_store.load(DOC_A)

    # Assert
    assert record == DocRecord(doc_id=DOC_A)
    assert list(docs_dir.iterdir()) == []


def test_load_of_corrupt_json_returns_empty_record_and_renames_the_file_aside(
    docs_dir: Path,
) -> None:
    # Arrange
    path = docs_dir / f"{DOC_A}.json"
    path.write_text("{not json at all", encoding="utf-8")

    # Act
    record = notes_store.load(DOC_A)

    # Assert
    assert record == DocRecord(doc_id=DOC_A)
    assert not path.exists()
    aside = list(docs_dir.glob(f"{DOC_A}.corrupt-*.json"))
    assert len(aside) == 1
    assert aside[0].read_text(encoding="utf-8") == "{not json at all"


def test_load_of_wrongly_shaped_json_returns_empty_record(docs_dir: Path) -> None:
    # Arrange
    (docs_dir / f"{DOC_A}.json").write_text("[1, 2, 3]", encoding="utf-8")

    # Act
    record = notes_store.load(DOC_A)

    # Assert
    assert record == DocRecord(doc_id=DOC_A)
    assert len(list(docs_dir.glob(f"{DOC_A}.corrupt-*.json"))) == 1


def test_save_does_not_mutate_the_record_passed_in() -> None:
    # Arrange
    record = DocRecord(doc_id=DOC_A, title="t", updated_at="original")

    # Act
    saved = notes_store.save(record)

    # Assert
    assert record.updated_at == "original"
    assert saved.updated_at != "original"
    assert saved.title == "t"


def test_save_leaves_no_tmp_file_behind(docs_dir: Path) -> None:
    # Arrange
    record = DocRecord(doc_id=DOC_A, highlights=(_highlight(),))

    # Act
    notes_store.save(record)

    # Assert
    assert [p.name for p in docs_dir.iterdir()] == [f"{DOC_A}.json"]


def test_delete_reports_whether_a_record_existed() -> None:
    # Arrange
    notes_store.save(DocRecord(doc_id=DOC_A))

    # Act / Assert
    assert notes_store.delete(DOC_A) is True
    assert notes_store.delete(DOC_A) is False


# ── store: validation and path traversal ──────────────────────────────────────


@pytest.mark.parametrize("bad_id", [TRAVERSAL_ID, "", "XYZ", "abc", "a" * 65, "/etc/x"])
def test_load_rejects_a_doc_id_that_is_not_a_hex_digest(bad_id: str) -> None:
    with pytest.raises(ValueError):
        notes_store.load(bad_id)


def test_traversal_doc_id_writes_nothing_anywhere(docs_dir: Path) -> None:
    # Act / Assert
    with pytest.raises(ValueError):
        notes_store.save(DocRecord(doc_id=TRAVERSAL_ID))
    with pytest.raises(ValueError):
        notes_store.delete(TRAVERSAL_ID)
    with pytest.raises(ValueError):
        notes_store.export_markdown(TRAVERSAL_ID)
    assert list(docs_dir.iterdir()) == []


def test_unknown_colour_falls_back_to_yellow() -> None:
    # Act
    record = notes_store.from_json(
        {"doc_id": DOC_A, "highlights": [{"id": "h1", "color": "chartreuse"}]}
    )

    # Assert
    assert record.highlights[0].color == "yellow"


def test_out_of_range_rect_values_are_clamped_to_the_unit_square() -> None:
    # Arrange
    raw = {"x": -3, "y": 1.4, "w": "0.5", "h": 0.25}

    # Act
    record = notes_store.from_json(
        {"doc_id": DOC_A, "highlights": [{"id": "h1", "rects": [raw]}]}
    )

    # Assert
    assert record.highlights[0].rects == ({"x": 0.0, "y": 1.0, "w": 0.5, "h": 0.25},)


def test_malformed_rects_are_dropped_and_good_ones_kept() -> None:
    # Arrange
    rects = [
        {"x": 0.1, "y": 0.1, "w": 0.1, "h": 0.1},   # good
        {"x": 0.1, "y": 0.1, "w": 0.1},              # missing h
        [0.1, 0.1, 0.1, 0.1],                        # not a mapping
        {"x": "wide", "y": 0.1, "w": 0.1, "h": 0.1},  # not numeric
        "nonsense",
    ]

    # Act
    record = notes_store.from_json(
        {"doc_id": DOC_A, "highlights": [{"id": "h1", "rects": rects}]}
    )

    # Assert
    assert record.highlights[0].rects == ({"x": 0.1, "y": 0.1, "w": 0.1, "h": 0.1},)


def test_page_is_coerced_to_a_positive_int_and_long_text_is_truncated() -> None:
    # Act
    record = notes_store.from_json(
        {
            "doc_id": DOC_A,
            "highlights": [
                {"id": "h1", "page": "4"},
                {"id": "h2", "page": -9},
                {"id": "h3", "page": None, "note": "n" * 30_000},
            ],
        }
    )

    # Assert
    pages = [hl.page for hl in record.highlights]
    assert pages == [4, 1, 1]
    assert len(record.highlights[2].note) == notes_store.MAX_NOTE_CHARS


def test_duplicate_highlight_ids_keep_the_last_one() -> None:
    # Act
    record = notes_store.from_json(
        {
            "doc_id": DOC_A,
            "highlights": [
                {"id": "h1", "text": "first"},
                {"id": "h1", "text": "second"},
            ],
        }
    )

    # Assert
    assert len(record.highlights) == 1
    assert record.highlights[0].text == "second"


def test_highlights_beyond_the_cap_drop_the_oldest() -> None:
    # Arrange
    overflow = notes_store.MAX_HIGHLIGHTS + 3
    raw = [{"id": f"h{i}", "text": str(i)} for i in range(overflow)]

    # Act
    record = notes_store.from_json({"doc_id": DOC_A, "highlights": raw})

    # Assert
    assert len(record.highlights) == notes_store.MAX_HIGHLIGHTS
    assert record.highlights[0].id == "h3"
    assert record.highlights[-1].id == f"h{overflow - 1}"


def test_from_json_rejects_a_bad_doc_id() -> None:
    with pytest.raises(ValueError):
        notes_store.from_json({"doc_id": TRAVERSAL_ID})


# ── store: listing and export ─────────────────────────────────────────────────


def test_list_docs_orders_newest_first_with_correct_counts(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    # Arrange - a fake clock makes the ordering deterministic
    stamps = iter(["2026-01-01T00:00:00+00:00", "2026-06-01T00:00:00+00:00"])
    monkeypatch.setattr(notes_store, "_now_iso", lambda: next(stamps))
    notes_store.save(DocRecord(doc_id=DOC_A, title="older", highlights=(_highlight(),)))
    notes_store.save(
        DocRecord(
            doc_id=DOC_B,
            title="newer",
            highlights=(_highlight("h1"), _highlight("h2", page=2)),
        )
    )

    # Act
    docs = notes_store.list_docs()

    # Assert
    assert [d["doc_id"] for d in docs] == [DOC_B, DOC_A]
    assert [d["title"] for d in docs] == ["newer", "older"]
    assert [d["count"] for d in docs] == [2, 1]


def test_list_docs_ignores_quarantined_and_foreign_files(docs_dir: Path) -> None:
    # Arrange
    notes_store.save(DocRecord(doc_id=DOC_A))
    (docs_dir / f"{DOC_A}.corrupt-20260101T000000.json").write_text("x")
    (docs_dir / "notes.json").write_text("{}")

    # Act
    docs = notes_store.list_docs()

    # Assert
    assert [d["doc_id"] for d in docs] == [DOC_A]


EXPECTED_MARKDOWN = (
    "# My Paper\n"
    "\n"
    "## Page 1\n"
    "\n"
    "> alpha\n"
    "\n"
    "(yellow)\n"
    "\n"
    "> gamma\n"
    "\n"
    "*third*\n"
    "\n"
    "(blue)\n"
    "\n"
    "## Page 2\n"
    "\n"
    "> beta\n"
    "\n"
    "*second*\n"
    "\n"
    "(green)\n"
)


def test_export_markdown_groups_highlights_by_page_in_page_order() -> None:
    # Arrange - stored out of page order on purpose
    notes_store.save(
        DocRecord(
            doc_id=DOC_A,
            title="My Paper",
            highlights=(
                _highlight("h2", page=2, color="green", text="beta", note="second"),
                _highlight("h1", page=1, color="yellow", text="alpha", note=""),
                _highlight("h3", page=1, color="blue", text="gamma", note="third"),
            ),
        )
    )

    # Act
    markdown = notes_store.export_markdown(DOC_A)

    # Assert
    assert markdown == EXPECTED_MARKDOWN
    assert markdown == notes_store.export_markdown(DOC_A)  # deterministic


def test_export_markdown_of_an_empty_doc_uses_the_doc_id_as_the_title() -> None:
    # Act
    markdown = notes_store.export_markdown(DOC_A)

    # Assert
    assert markdown == f"# {DOC_A}\n\n*No highlights yet.*\n"


# ── routes ────────────────────────────────────────────────────────────────────


def test_get_unknown_doc_returns_200_with_an_empty_record(client: TestClient) -> None:
    # Act
    response = client.get(f"/api/notes/{DOC_A}")

    # Assert
    assert response.status_code == 200
    assert response.json() == {
        "doc_id": DOC_A,
        "title": "",
        "highlights": [],
        "last_index": 0,
        "last_sentence": None,
        "options": {},
        "updated_at": "",
        "blocks": [],
    }


def test_put_then_get_round_trips_the_record(client: TestClient) -> None:
    # Arrange
    body = {
        "doc_id": DOC_A,
        "title": "Paper",
        "highlights": [
            {"id": "h1", "page": 2, "color": "pink", "text": "sel", "note": "n",
             "rects": [RECT]}
        ],
        "last_index": 42,
        "options": {"use_llm": False},
    }

    # Act
    put = client.put(f"/api/notes/{DOC_A}", json=body)
    got = client.get(f"/api/notes/{DOC_A}")

    # Assert
    assert put.status_code == 200
    assert put.json()["updated_at"] != ""
    assert got.json() == put.json()
    assert got.json()["last_index"] == 42
    assert got.json()["highlights"][0]["color"] == "pink"


def test_put_lets_the_path_doc_id_win_over_the_body(client: TestClient) -> None:
    # Act
    response = client.put(f"/api/notes/{DOC_A}", json={"doc_id": DOC_B, "title": "x"})

    # Assert
    assert response.json()["doc_id"] == DOC_A
    assert notes_store.load(DOC_B) == DocRecord(doc_id=DOC_B)


def test_list_endpoint_reports_saved_docs(client: TestClient) -> None:
    # Arrange
    client.put(f"/api/notes/{DOC_A}", json={"title": "Paper", "highlights": []})

    # Act
    response = client.get("/api/notes")

    # Assert
    assert response.status_code == 200
    assert [d["doc_id"] for d in response.json()["docs"]] == [DOC_A]


def test_delete_endpoint_reports_whether_the_record_existed(client: TestClient) -> None:
    # Arrange
    client.put(f"/api/notes/{DOC_A}", json={"title": "Paper"})

    # Act / Assert
    assert client.delete(f"/api/notes/{DOC_A}").json() == {"deleted": True}
    assert client.delete(f"/api/notes/{DOC_A}").json() == {"deleted": False}


@pytest.mark.parametrize("method", ["get", "put", "delete"])
def test_a_bad_doc_id_returns_400_without_leaking_a_path(
    client: TestClient, method: str, tmp_path: Path
) -> None:
    # Act
    kwargs = {"json": {}} if method == "put" else {}
    response = getattr(client, method)("/api/notes/not-hex-at-all", **kwargs)

    # Assert
    assert response.status_code == 400
    assert "doc_id" in response.json()["detail"]
    assert str(tmp_path) not in response.text


def test_export_endpoint_returns_markdown_inline(client: TestClient) -> None:
    # Arrange
    client.put(
        f"/api/notes/{DOC_A}",
        json={
            "title": "Paper",
            "highlights": [{"id": "h1", "page": 1, "color": "blue", "text": "sel",
                            "note": "n"}],
        },
    )

    # Act
    response = client.get(f"/api/notes/{DOC_A}/export.md")

    # Assert
    assert response.status_code == 200
    assert response.headers["content-type"].startswith("text/markdown")
    assert response.headers["content-disposition"].startswith("inline")
    assert response.text == "# Paper\n\n## Page 1\n\n> sel\n\n*n*\n\n(blue)\n"


def test_export_endpoint_rejects_a_bad_doc_id(client: TestClient) -> None:
    # Act
    response = client.get("/api/notes/nothex/export.md")

    # Assert
    assert response.status_code == 400


def test_put_survives_junk_values_in_the_body(client: TestClient) -> None:
    # Arrange - a client sending nonsense must not corrupt the store
    body = {
        "title": "t",
        "highlights": [
            {"id": "h1", "page": 0, "color": "neon", "text": "x",
             "rects": [{"x": 5, "y": 0.5, "w": 0.5, "h": 0.5}, "junk"]}
        ],
        "last_index": -5,
    }

    # Act
    response = client.put(f"/api/notes/{DOC_A}", json=body)

    # Assert
    highlight = response.json()["highlights"][0]
    assert response.status_code == 200
    assert (highlight["page"], highlight["color"]) == (1, "yellow")
    assert highlight["rects"] == [{"x": 1.0, "y": 0.5, "w": 0.5, "h": 0.5}]
    assert response.json()["last_index"] == 0


def test_stored_file_is_valid_json_with_the_expected_keys(docs_dir: Path) -> None:
    # Arrange
    notes_store.save(DocRecord(doc_id=DOC_A, title="t", highlights=(_highlight(),)))

    # Act
    payload = json.loads((docs_dir / f"{DOC_A}.json").read_text(encoding="utf-8"))

    # Assert
    assert set(payload) == {
        "doc_id", "title", "highlights", "last_index", "last_sentence", "options", "updated_at",
        "blocks",
    }
    assert payload["highlights"][0]["rects"] == [RECT]


# ── T7: the notes editor's blocks ─────────────────────────────────────────────


def _block(block_id: str = "b1", **kwargs: object) -> Block:
    fields: dict = {"id": block_id, "type": "p", "text": "note", "checked": False}
    fields.update(kwargs)
    return Block(**fields)  # type: ignore[arg-type]


def test_a_record_written_before_blocks_existed_still_loads(docs_dir: Path) -> None:
    # Arrange - exactly the on-disk shape of the previous release
    legacy = {
        "doc_id": DOC_A,
        "title": "Old paper",
        "highlights": [{"id": "h1", "page": 2, "color": "green", "text": "kept"}],
        "last_index": 12,
        "options": {"read_tables": True},
        "updated_at": "2024-01-01T00:00:00+00:00",
    }
    (docs_dir / f"{DOC_A}.json").write_text(json.dumps(legacy), encoding="utf-8")

    # Act
    record = notes_store.load(DOC_A)

    # Assert
    assert record.blocks == ()
    assert record.title == "Old paper"
    assert record.last_index == 12
    assert [h.text for h in record.highlights] == ["kept"]


def test_blocks_survive_a_save_load_round_trip() -> None:
    # Arrange
    blocks = (
        _block("b1", type="h1", text="Findings"),
        _block("b2", type="todo", text="reread §3", checked=True),
    )

    # Act
    notes_store.save(DocRecord(doc_id=DOC_A, blocks=blocks))

    # Assert
    assert notes_store.load(DOC_A).blocks == blocks


@pytest.mark.parametrize(
    ("raw", "expected"),
    [
        ({"id": "b", "type": "marquee", "text": "x"}, Block(id="b", type="p", text="x")),
        ({"id": "b", "type": "divider", "text": "dropped"}, Block(id="b", type="divider")),
        ({"id": "b", "type": "p", "checked": True}, Block(id="b", type="p", checked=False)),
        ({"id": "b", "type": "todo", "checked": "yes"}, Block(id="b", type="todo")),
        ({"id": "b", "type": "p", "text": 7}, Block(id="b", type="p")),
    ],
)
def test_block_values_are_validated_at_the_boundary(raw: dict, expected: Block) -> None:
    # Act
    record = notes_store.from_json({"doc_id": DOC_A, "blocks": [raw]})

    # Assert
    assert record.blocks == (expected,)


def test_block_text_and_count_are_clamped() -> None:
    # Arrange
    too_many = [{"id": f"b{i}", "type": "p", "text": "x"} for i in range(notes_store.MAX_BLOCKS + 5)]
    long_text = [{"id": "b", "type": "p", "text": "y" * (notes_store.MAX_BLOCK_CHARS + 100)}]

    # Act
    capped = notes_store.from_json({"doc_id": DOC_A, "blocks": too_many})
    truncated = notes_store.from_json({"doc_id": DOC_A, "blocks": long_text})

    # Assert
    assert len(capped.blocks) == notes_store.MAX_BLOCKS
    assert len(truncated.blocks[0].text) == notes_store.MAX_BLOCK_CHARS


@pytest.mark.parametrize("raw", ["not a list", 5, {"id": "b"}, None, [None, 3, "x"]])
def test_bad_stored_blocks_never_raise(raw: object) -> None:
    # Act
    record = notes_store.from_json({"doc_id": DOC_A, "blocks": raw})

    # Assert
    assert record.blocks == ()


def test_a_block_without_an_id_gets_one() -> None:
    # Act
    record = notes_store.from_json({"doc_id": DOC_A, "blocks": [{"type": "p", "text": "x"}]})

    # Assert
    assert record.blocks[0].id


# ── U8: where a note is pinned in the paper ───────────────────────────────────


ANCHOR = {"page": 3, "y": 0.25, "hl": "h7"}


def test_a_notes_anchor_survives_a_save_load_round_trip() -> None:
    # Arrange - the anchored block opens the note; the next one continues it
    blocks = (_block("b1", anchor=dict(ANCHOR)), _block("b2"))

    # Act
    notes_store.save(DocRecord(doc_id=DOC_A, blocks=blocks))
    loaded = notes_store.load(DOC_A).blocks

    # Assert
    assert loaded[0].anchor == ANCHOR
    assert loaded[1].anchor is None


def test_blocks_written_before_anchors_existed_load_unpinned() -> None:
    # Act
    record = notes_store.from_json(
        {"doc_id": DOC_A, "blocks": [{"id": "b", "type": "p", "text": "x"}]},
    )

    # Assert
    assert record.blocks[0].anchor is None


@pytest.mark.parametrize(
    ("raw", "expected"),
    [
        ({"page": 2, "y": 0.5, "hl": "h"}, {"page": 2, "y": 0.5, "hl": "h"}),
        ({"page": 2}, {"page": 2, "y": 0.0, "hl": ""}),
        ({"page": "2", "y": "0.5"}, {"page": 2, "y": 0.5, "hl": ""}),
        ({"page": 1, "y": 9}, {"page": 1, "y": 1.0, "hl": ""}),
        ({"page": 1, "y": -9}, {"page": 1, "y": 0.0, "hl": ""}),
        ({"page": 1, "hl": 5}, {"page": 1, "y": 0.0, "hl": ""}),
        ({"page": 0, "y": 0.5}, None),
        ({"page": -3}, None),
        ({"page": notes_store.MAX_ANCHOR_PAGE}, {"page": notes_store.MAX_ANCHOR_PAGE, "y": 0.0, "hl": ""}),
        ({"page": notes_store.MAX_ANCHOR_PAGE + 1}, None),
        ({"page": 1e20}, None),
        ({"y": 0.5}, None),
        ({"page": 1, "y": float("nan")}, None),
        ("page 3", None),
        (None, None),
    ],
)
def test_an_anchor_is_validated_at_the_boundary(raw: object, expected: object) -> None:
    # Act
    record = notes_store.from_json(
        {"doc_id": DOC_A, "blocks": [{"id": "b", "type": "p", "anchor": raw}]},
    )

    # Assert
    assert record.blocks[0].anchor == expected


def test_a_stored_anchor_is_written_back_verbatim(docs_dir: Path) -> None:
    # Arrange
    notes_store.save(
        DocRecord(doc_id=DOC_A, blocks=(_block("b1", anchor=dict(ANCHOR)), _block("b2"))),
    )

    # Act
    payload = json.loads((docs_dir / f"{DOC_A}.json").read_text(encoding="utf-8"))

    # Assert
    assert payload["blocks"][0]["anchor"] == ANCHOR
    assert payload["blocks"][1]["anchor"] is None


def test_an_anchored_block_still_exports_as_plain_markdown() -> None:
    # Arrange - the anchor is where the note lives, not something the reader reads
    notes_store.save(
        DocRecord(doc_id=DOC_A, title="P", blocks=(_block("b1", text="pinned", anchor=dict(ANCHOR)),)),
    )

    # Act
    exported = notes_store.export_markdown(DOC_A)

    # Assert
    assert "pinned" in exported
    assert "h7" not in exported


EXPECTED_BLOCK_MARKDOWN = (
    "# My Paper\n"
    "\n"
    "## Notes\n"
    "\n"
    "### Findings\n"
    "\n"
    "#### Method\n"
    "\n"
    "##### Setup\n"
    "\n"
    "Body text\n"
    "\n"
    "- one\n"
    "- two\n"
    "\n"
    "1. first\n"
    "2. second\n"
    "\n"
    "- [x] done\n"
    "- [ ] todo\n"
    "\n"
    "> quoted\n"
    "> — p. 3\n"
    "\n"
    "```\n"
    "x = 1\n"
    "```\n"
    "\n"
    "---\n"
    "\n"
    "## Page 1\n"
    "\n"
    "> alpha\n"
    "\n"
    "*a note*\n"
    "\n"
    "(yellow)\n"
)


def test_export_markdown_renders_blocks_before_the_highlights() -> None:
    # Arrange
    notes_store.save(
        DocRecord(
            doc_id=DOC_A,
            title="My Paper",
            highlights=(_highlight("h1", page=1, color="yellow", text="alpha"),),
            blocks=(
                _block("b1", type="h1", text="Findings"),
                _block("b1a", type="h2", text="Method"),
                _block("b1b", type="h3", text="Setup"),
                _block("b2", text="Body text"),
                _block("b3", type="ul", text="one"),
                _block("b4", type="ul", text="two"),
                _block("b5", type="ol", text="first"),
                _block("b6", type="ol", text="second"),
                _block("b7", type="todo", text="done", checked=True),
                _block("b8", type="todo", text="todo"),
                _block("b9", type="quote", text="quoted\n— p. 3"),
                _block("b10", type="code", text="x = 1"),
                _block("b11", type="divider", text=""),
                _block("b12", text="   "),  # an empty trailing paragraph is not exported
            ),
        )
    )

    # Act
    markdown = notes_store.export_markdown(DOC_A)

    # Assert
    assert markdown == EXPECTED_BLOCK_MARKDOWN
    assert markdown == notes_store.export_markdown(DOC_A)  # deterministic


def test_export_markdown_with_blocks_but_no_highlights() -> None:
    # Arrange
    notes_store.save(DocRecord(doc_id=DOC_A, title="P", blocks=(_block(text="just a note"),)))

    # Act
    markdown = notes_store.export_markdown(DOC_A)

    # Assert
    assert markdown == "# P\n\n## Notes\n\njust a note\n\n*No highlights yet.*\n"


def test_export_markdown_ignores_an_editor_holding_only_blank_blocks() -> None:
    # Arrange
    notes_store.save(DocRecord(doc_id=DOC_A, title="P", blocks=(_block(text="  "),)))

    # Act & Assert
    assert notes_store.export_markdown(DOC_A) == "# P\n\n*No highlights yet.*\n"


def test_put_stores_blocks(client: TestClient) -> None:
    # Act
    response = client.put(
        f"/api/notes/{DOC_A}",
        json={"blocks": [{"id": "b1", "type": "h2", "text": "Method", "checked": False}]},
    )

    # Assert
    assert response.status_code == 200
    assert response.json()["blocks"] == [
        {"id": "b1", "type": "h2", "text": "Method", "checked": False, "anchor": None}
    ]


def test_put_keeps_the_anchor_a_block_arrives_with(client: TestClient) -> None:
    """The route models the wire form itself, so a field it does not declare is
    dropped before the store ever sees it -- and the note comes back loose (U8)."""
    # Act
    response = client.put(
        f"/api/notes/{DOC_A}",
        json={"blocks": [{"id": "b1", "type": "p", "text": "pinned", "anchor": ANCHOR}]},
    )

    # Assert
    assert response.status_code == 200
    assert response.json()["blocks"][0]["anchor"] == ANCHOR
    assert notes_store.load(DOC_A).blocks[0].anchor == ANCHOR


def test_a_put_that_does_not_mention_blocks_keeps_them(client: TestClient) -> None:
    # Arrange - the editor saved, then an older client (or a resume-position save
    # built without the field) writes the record back
    client.put(f"/api/notes/{DOC_A}", json={"blocks": [{"id": "b1", "type": "p", "text": "keep me"}]})

    # Act
    response = client.put(f"/api/notes/{DOC_A}", json={"last_index": 42})

    # Assert
    assert [b["text"] for b in response.json()["blocks"]] == ["keep me"]
    assert response.json()["last_index"] == 42
    assert [b.text for b in notes_store.load(DOC_A).blocks] == ["keep me"]


def test_an_explicit_empty_list_clears_the_blocks(client: TestClient) -> None:
    # Arrange
    client.put(f"/api/notes/{DOC_A}", json={"blocks": [{"id": "b1", "type": "p", "text": "x"}]})

    # Act
    response = client.put(f"/api/notes/{DOC_A}", json={"blocks": []})

    # Assert
    assert response.json()["blocks"] == []


def test_put_survives_junk_blocks(client: TestClient) -> None:
    # Act
    response = client.put(
        f"/api/notes/{DOC_A}",
        json={"blocks": [{"id": "b1", "type": "<script>", "text": "x", "checked": "sure"}]},
    )

    # Assert
    assert response.status_code == 200
    assert response.json()["blocks"] == [
        {"id": "b1", "type": "p", "text": "x", "checked": False, "anchor": None}
    ]
