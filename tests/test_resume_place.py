"""N4: the resume position survives a rebuild that joins sentences across page turns.

`last_index` alone is a raw script index, and every join before it shifts it forward one
sentence, so John's place moved silently. The record now also keeps `last_sentence`, the
start page and opening text of the sentence he was on, which `static/js/resume.js` finds
again; the index stays as the fallback for older records.
"""

from __future__ import annotations

from pathlib import Path

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from kokoro_reader import config, notes_store
from kokoro_reader.notes_store import DocRecord
from kokoro_reader.routes import notes as notes_routes

DOC = "c" * 40
MARK = {"page": 18, "text": "Exercise 2.1 asks for the mean pregnancy length."}


@pytest.fixture(autouse=True)
def docs_dir(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    monkeypatch.setattr(config, "DOCS_DIR", tmp_path)
    return tmp_path


@pytest.fixture()
def client() -> TestClient:
    app = FastAPI()
    app.include_router(notes_routes.router)
    return TestClient(app)


def test_the_resume_mark_round_trips_through_the_store():
    notes_store.save(DocRecord(doc_id=DOC, last_index=4, last_sentence=dict(MARK)))

    loaded = notes_store.load(DOC)

    assert loaded.last_index == 4 and loaded.last_sentence == MARK


def test_the_resume_mark_round_trips_through_the_route(client):
    put = client.put(f"/api/notes/{DOC}", json={"last_index": 4, "last_sentence": MARK})

    assert put.status_code == 200
    assert client.get(f"/api/notes/{DOC}").json()["last_sentence"] == MARK


def test_an_older_record_has_no_mark(client):
    client.put(f"/api/notes/{DOC}", json={"last_index": 4})

    assert client.get(f"/api/notes/{DOC}").json()["last_sentence"] is None


@pytest.mark.parametrize("raw", [
    {"page": 0, "text": "x"}, {"page": "nope", "text": "x"}, {"page": 3}, {"page": 3, "text": ""},
    {"page": 3, "text": 7}, "page 3", None,
])
def test_a_malformed_mark_is_dropped_not_fatal(raw):
    assert notes_store.from_json({"doc_id": DOC, "last_sentence": raw}).last_sentence is None


def test_the_mark_text_is_capped():
    raw = {"page": 3, "text": "x" * 10_000}

    mark = notes_store.from_json({"doc_id": DOC, "last_sentence": raw}).last_sentence

    assert mark == {"page": 3, "text": "x" * notes_store.MAX_RESUME_TEXT_CHARS}
