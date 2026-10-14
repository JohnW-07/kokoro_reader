"""Highlight / note endpoints (R9, R10, R11).

Handlers are sync `def` so FastAPI runs them in the threadpool (M9). They look cheap —
one small JSON file each — but `list_docs()` reads *every* record, `save()` fsyncs, and a
slow or contended disk turns any of them into a multi-second block. An `async def` doing
that holds the event loop and stalls every other route, which is exactly what R2 forbids.

Validation happens twice on purpose -- Pydantic rejects the wrong *shape*,
`notes_store.from_json` sanitises the *values* -- and no error message ever names a
filesystem path.
"""

from __future__ import annotations

import logging
from typing import Any

from fastapi import APIRouter, HTTPException
from fastapi.responses import Response
from pydantic import BaseModel, ConfigDict, Field

from kokoro_reader import notes_store, stats_store

log = logging.getLogger(__name__)

router = APIRouter(prefix="/api/notes", tags=["notes"])

MARKDOWN_MEDIA_TYPE = "text/markdown; charset=utf-8"
BAD_DOC_ID = "invalid doc_id: expected 8-64 lowercase hex characters"
WRITE_FAILED = "could not save notes for this document"


class HighlightBody(BaseModel):
    """Loose on purpose: `notes_store.from_json` is the real sanitiser."""

    model_config = ConfigDict(extra="ignore")

    id: str = ""
    page: int = 1
    color: str = notes_store.DEFAULT_COLOR
    text: str = ""
    note: str = ""
    rects: list[Any] = Field(default_factory=list)
    created_at: str = ""
    updated_at: str = ""


class BlockBody(BaseModel):
    """One notes-editor block (T7). Loose like `HighlightBody`: a junk *value*
    is sanitised by `notes_store.from_json`, never answered with a 422."""

    model_config = ConfigDict(extra="ignore")

    id: Any = ""
    type: Any = notes_store.DEFAULT_BLOCK_TYPE
    text: Any = ""
    checked: Any = False
    #: Where in the paper the note this block opens is pinned (U8). Declared here or
    #: `extra="ignore"` would drop it on the way in and the note would come back loose.
    anchor: Any = None


class DocRecordBody(BaseModel):
    model_config = ConfigDict(extra="ignore")

    doc_id: str = ""
    title: str = ""
    highlights: list[HighlightBody] = Field(default_factory=list)
    last_index: int = 0
    #: N4: the sentence at `last_index`, so a rebuild cannot move the place (notes_store).
    last_sentence: Any = None
    options: dict[str, Any] = Field(default_factory=dict)
    updated_at: str = ""
    #: `None` (the key absent) means "this client does not manage notes blocks" and
    #: keeps whatever is stored; an explicit `[]` clears them. See `put_doc`.
    blocks: list[BlockBody] | None = None


def _stored_blocks(doc_id: str) -> list[dict]:
    """The blocks currently on disk, in wire form. Empty for an unknown document."""
    return notes_store.to_json(notes_store.load(doc_id))["blocks"]


def _checked(doc_id: str) -> str:
    try:
        return notes_store.validate_doc_id(doc_id)
    except ValueError:
        raise HTTPException(status_code=400, detail=BAD_DOC_ID) from None


@router.get("")
def get_docs() -> dict[str, list[dict]]:
    return {"docs": notes_store.list_docs()}


@router.get("/{doc_id}")
def get_doc(doc_id: str) -> dict:
    """200 with an empty record for an unknown document: the client always asks first.

    The reader asks exactly once per document it opens, so this is where an open is counted.
    """
    checked = _checked(doc_id)
    stats_store.record_open(checked)
    return notes_store.to_json(notes_store.load(checked))


@router.put("/{doc_id}")
def put_doc(doc_id: str, body: DocRecordBody) -> dict:
    """The path's `doc_id` wins over the body's.

    A PUT is a whole-record replace, so a writer that knows nothing about the T7
    notes blocks (an older client, or the resume-position save of one) would erase
    them. Omitting the key keeps the stored blocks; sending `[]` clears them.
    """
    checked = _checked(doc_id)
    payload = {**body.model_dump(), "doc_id": checked}
    if payload.get("blocks") is None:
        payload["blocks"] = _stored_blocks(checked)
    try:
        record = notes_store.from_json(payload)
    except ValueError:
        raise HTTPException(status_code=400, detail=BAD_DOC_ID) from None
    try:
        return notes_store.to_json(notes_store.save(record))
    except OSError as exc:
        log.error("saving notes for %s failed: %s", doc_id, exc)
        raise HTTPException(status_code=500, detail=WRITE_FAILED) from None


@router.delete("/{doc_id}")
def delete_doc(doc_id: str) -> dict[str, bool]:
    return {"deleted": notes_store.delete(_checked(doc_id))}


@router.get("/{doc_id}/export.md")
def export_doc(doc_id: str) -> Response:
    checked = _checked(doc_id)
    return Response(
        content=notes_store.export_markdown(checked),
        media_type=MARKDOWN_MEDIA_TYPE,
        headers={"Content-Disposition": f'inline; filename="{checked}.md"'},
    )
