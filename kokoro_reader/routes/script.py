"""Turn page geometry sent by the browser into a speakable script."""

from __future__ import annotations

import logging
import re

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field, field_validator, model_validator

from .. import config
from ..config import ReadOptions, Substitution
from ..textpipe import pipeline, subs
from ..textpipe.types import DocStats, PageGeometry

log = logging.getLogger(__name__)

router = APIRouter(prefix="/api/script", tags=["script"])

MAX_PAGES_PER_REQUEST = 80
MAX_LINES_PER_PAGE = 4000
#: M10 — a work budget, not just a shape check. The per-page and per-request caps alone
#: admit 320 000 lines, measured at 40.7 s of classification on one threadpool worker
#: (7 900 lines/s). A dense 80-page batch is ~4 800 lines, so this leaves 8x headroom
#: while bounding the worst case to roughly five seconds.
MAX_TOTAL_LINES = 40_000


#: NUL is `normalize`'s own period sentinel and a newline would split a line in two;
#: neither belongs in a word the reader is asked to say differently.
_CONTROL_CHARS_RE = re.compile(r"[\x00-\x1f\x7f]")


class SubstitutionModel(BaseModel):
    find: str = Field(max_length=config.MAX_SUB_FIND_CHARS)
    replace: str = Field(default="", max_length=config.MAX_SUB_REPLACE_CHARS)
    ignore_case: bool = False

    @field_validator("find", "replace")
    @classmethod
    def _no_control_chars(cls, value: str) -> str:
        if _CONTROL_CHARS_RE.search(value):
            raise ValueError("must not contain control characters")
        return value

    @field_validator("find")
    @classmethod
    def _find_is_a_term(cls, value: str) -> str:
        term = value.strip()
        if not term:
            raise ValueError("find text must not be empty")
        return term

    def to_substitution(self) -> Substitution:
        return Substitution(find=self.find, replace=self.replace.strip(), ignore_case=self.ignore_case)


class OptionsModel(BaseModel):
    read_captions: bool = True
    read_equations: bool = True
    read_headings: bool = True
    read_footnotes: bool = False
    read_tables: bool = False
    read_references: bool = False
    use_llm: bool = False
    substitutions: list[SubstitutionModel] = Field(
        default_factory=list, max_length=config.MAX_SUBSTITUTIONS
    )

    @model_validator(mode="after")
    def _no_duplicate_finds(self) -> "OptionsModel":
        duplicate = subs.first_duplicate(self._substitutions())
        if duplicate is not None:
            raise ValueError(f"duplicate substitution for {duplicate.find!r}")
        return self

    def _substitutions(self) -> tuple[Substitution, ...]:
        return tuple(s.to_substitution() for s in self.substitutions)

    def to_options(self) -> ReadOptions:
        return ReadOptions(
            **self.model_dump(exclude={"substitutions"}),
            substitutions=self._substitutions(),
        )


class ScriptRequest(BaseModel):
    doc_id: str = Field(default="", max_length=64)
    stats: dict = Field(default_factory=dict)
    pages: list[dict] = Field(default_factory=list)
    options: OptionsModel = Field(default_factory=OptionsModel)
    #: N4 — the pages this batch answers for. The others in `pages` are context, so a
    #: sentence over a batch seam is built whole; both or neither.
    own_from: int | None = Field(default=None, ge=1)
    own_to: int | None = Field(default=None, ge=1)

    @model_validator(mode="after")
    def _own_is_a_range(self) -> "ScriptRequest":
        if (self.own_from is None) != (self.own_to is None):
            raise ValueError("own_from and own_to go together")
        if self.own_from is not None and self.own_from > self.own_to:
            raise ValueError("own_from must not be after own_to")
        return self

    def own(self) -> tuple[int, int] | None:
        return None if self.own_from is None else (self.own_from, self.own_to)


@router.post("/build")
def build_script(req: ScriptRequest) -> dict:
    """Sync `def` on purpose: classification is CPU work and belongs in the threadpool."""
    if not req.pages:
        raise HTTPException(status_code=400, detail="No pages supplied")
    if len(req.pages) > MAX_PAGES_PER_REQUEST:
        raise HTTPException(
            status_code=400,
            detail=f"Too many pages in one request (max {MAX_PAGES_PER_REQUEST})",
        )
    if _total_lines(req.pages) > MAX_TOTAL_LINES:
        raise HTTPException(
            status_code=400,
            detail=f"Too much text in one request (max {MAX_TOTAL_LINES} lines)",
        )

    try:
        pages = tuple(PageGeometry.from_json(_capped(p)) for p in req.pages)
        stats = DocStats.from_json(req.stats)
    except (KeyError, TypeError, ValueError) as exc:
        raise HTTPException(status_code=400, detail=f"Malformed geometry: {exc}") from exc

    options = req.options.to_options()
    normalizer = _normalizer(options.use_llm)

    try:
        sentences, blocks, report = pipeline.build_script(pages, stats, options, normalizer,
                                                         own=req.own())
    except Exception as exc:  # noqa: BLE001
        log.exception("script build failed")
        raise HTTPException(status_code=500, detail=f"Script build failed: {exc}") from exc

    return {
        "doc_id": req.doc_id,
        "sentences": [s.to_json() for s in sentences],
        "blocks": [b.to_json() for b in blocks],
        "stats": report,
    }


def _total_lines(pages: list[dict]) -> int:
    """Lines this request would actually classify, after the per-page cap."""
    return sum(min(len(page.get("lines") or []), MAX_LINES_PER_PAGE) for page in pages)


def _capped(page: dict) -> dict:
    """Bound untrusted input before it reaches the classifier."""
    lines = page.get("lines") or []
    if len(lines) > MAX_LINES_PER_PAGE:
        return {**page, "lines": lines[:MAX_LINES_PER_PAGE]}
    return page


def _normalizer(use_llm: bool):
    """The LLM is optional; its absence must never fail a request."""
    if not use_llm or not config.LLM_ENABLED:
        return None
    try:
        from .. import llm

        return llm.get_normalizer(True)
    except Exception:  # noqa: BLE001
        log.warning("LLM normalizer unavailable; continuing with rules only")
        return None
