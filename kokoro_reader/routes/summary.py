"""POST /api/summary: notes on the text the client sends (N9, docs/17), and their spoken text.

A sync `def`: the model call blocks for seconds, so it runs in the thread pool and the event
loop stays free for /api/health and audio (R2). The server is stateless about pages; the
client sends the page's text, and `doc_id`/`page` only label the request in the log.
"""

from __future__ import annotations

import logging
from typing import Literal

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, ConfigDict, Field, field_validator

from kokoro_reader import notes_store, summary

log = logging.getLogger(__name__)

router = APIRouter(prefix="/api", tags=["summary"])

UNAVAILABLE = 503
FAILED = 502


class SummaryRequest(BaseModel):
    model_config = ConfigDict(extra="ignore")

    doc_id: str = ""
    page: int = Field(default=1, ge=1)
    text: str = Field(min_length=1, max_length=summary.MAX_TEXT_CHARS)
    backend: Literal[summary.BACKENDS] = "apple"

    @field_validator("doc_id")
    @classmethod
    def _doc_id(cls, value: str) -> str:
        return notes_store.validate_doc_id(value) if value else ""

    @field_validator("text")
    @classmethod
    def _text(cls, value: str) -> str:
        if not value.strip():
            raise ValueError("text is blank")
        return value


@router.post("/summary")
def post_summary(req: SummaryRequest) -> dict:
    try:
        made = summary.summarize(req.text, req.backend)
    except summary.SummaryUnavailable as exc:
        raise HTTPException(status_code=UNAVAILABLE, detail=str(exc)) from exc
    except summary.SummaryFailed as exc:
        log.warning("summary: %s failed for %s p%d: %s", req.backend, req.doc_id[:8], req.page, exc)
        raise HTTPException(status_code=FAILED, detail=str(exc)) from exc
    notes = made.notes
    return {"heading": notes.heading, "context": notes.context, "points": list(notes.points),
            "summary": notes.spoken, "backend": made.backend, "cached": made.cached}
