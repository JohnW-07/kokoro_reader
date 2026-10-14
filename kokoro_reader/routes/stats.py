"""Reading-stats endpoints for the "Wrapped" page.

Sync `def` handlers (M9): the summary reads every notes record, and a reset fsyncs.
Everything is local; nothing here is load-bearing for reading or playback.
"""

from __future__ import annotations

import logging
import math
import re

from fastapi import APIRouter, HTTPException, Query
from pydantic import BaseModel, ConfigDict, Field, field_validator

from kokoro_reader import notes_store, stats_store, stats_summary

log = logging.getLogger(__name__)

router = APIRouter(prefix="/api/stats", tags=["stats"])

ALL_TIME = "all"
YEAR_RE = re.compile(r"^\d{4}$")
VOICE_RE = re.compile(r"^[A-Za-z0-9_]{0,64}$")
RESET_WORD = "reset"
#: One client batch is flushed every ~15 s; these bounds only stop nonsense, not use.
MAX_BATCH_SECONDS = 24 * 60 * 60
MAX_BATCH_COUNT = 1_000_000
BAD_YEAR = "year must be a four-digit year or 'all'"


class ListenBatch(BaseModel):
    """What the reader actually played since its last flush (see static/js/listenlog.js)."""

    model_config = ConfigDict(extra="ignore")

    doc_id: str = ""
    title: str = Field(default="", max_length=1000)
    voice: str = ""
    seconds: float = Field(default=0, ge=0, le=MAX_BATCH_SECONDS)
    sentences: int = Field(default=0, ge=0, le=MAX_BATCH_COUNT)
    words: int = Field(default=0, ge=0, le=MAX_BATCH_COUNT)
    pages: int = Field(default=0, ge=0, le=MAX_BATCH_COUNT)
    progress: float = Field(default=0, ge=0, le=1)

    @field_validator("seconds", "sentences", "words", "pages", "progress", mode="before")
    @classmethod
    def _finite(cls, value: object) -> object:
        # NaN/Infinity parse from JSON; echoed back in a 422 they would not serialise (a 500).
        is_bad_float = isinstance(value, float) and not math.isfinite(value)
        return None if is_bad_float else value

    @field_validator("doc_id")
    @classmethod
    def _doc_id(cls, value: str) -> str:
        return notes_store.validate_doc_id(value) if value else ""

    @field_validator("voice")
    @classmethod
    def _voice(cls, value: str) -> str:
        if not VOICE_RE.match(value):
            raise ValueError("invalid voice")
        return value


class ResetBody(BaseModel):
    confirm: str = ""


def _year(raw: str | None, current: int) -> int | None:
    if raw is None or raw == "":
        return current
    if raw == ALL_TIME:
        return None
    if not YEAR_RE.match(raw):
        raise HTTPException(status_code=400, detail=BAD_YEAR)
    return int(raw)


def _records() -> list[dict]:
    """Every notes record as wire JSON; a summary never fails because of one bad file."""
    records = []
    for doc in notes_store.list_docs():
        try:
            records.append(notes_store.to_json(notes_store.load(doc["doc_id"])))
        except (OSError, ValueError) as exc:
            log.warning("stats: skipped notes for %s: %s", doc.get("doc_id"), exc)
    return records


def _doc(raw: str | None) -> str:
    if not raw:
        return ""
    try:
        return notes_store.validate_doc_id(raw)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@router.get("")
def get_stats(year: str | None = Query(None), doc: str | None = Query(None)) -> dict:
    """``doc`` adds that paper's all-time numbers as ``paper`` (N11: the "This paper" section)."""
    store = stats_store.get_store()
    chosen = _year(year, store.today().year)
    return stats_summary.summarize(store.snapshot(), chosen, _records(), _doc(doc))


@router.post("/listen")
def post_listen(batch: ListenBatch) -> dict[str, bool]:
    stats_store.record_listen(batch.model_dump())
    return {"ok": True}


@router.post("/reset")
def post_reset(body: ResetBody) -> dict:
    if body.confirm != RESET_WORD:
        raise HTTPException(status_code=400, detail=f"send {{\"confirm\": \"{RESET_WORD}\"}}")
    return {"ok": True, "since": stats_store.get_store().reset()}
