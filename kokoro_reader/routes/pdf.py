"""Serving the PDF the user picked in the native file dialog."""

from __future__ import annotations

import os
from pathlib import Path

from fastapi import APIRouter, HTTPException
from fastapi.responses import Response

router = APIRouter(prefix="/api", tags=["pdf"])

MAX_PDF_BYTES = 400 * 1024 * 1024

_selected: Path | None = None


def set_selected(path: str | os.PathLike[str] | None) -> None:
    """Called by the pywebview bridge after the native dialog closes."""
    global _selected
    _selected = Path(path).expanduser().resolve() if path else None


def selected() -> Path | None:
    return _selected


@router.get("/pdf")
def get_pdf() -> Response:
    path = _selected
    if path is None:
        raise HTTPException(status_code=404, detail="No PDF selected")
    if not path.is_file():
        raise HTTPException(status_code=404, detail="The selected file no longer exists")
    if path.stat().st_size > MAX_PDF_BYTES:
        raise HTTPException(status_code=413, detail="PDF is too large to open")
    try:
        content = path.read_bytes()
    except OSError as exc:
        raise HTTPException(status_code=500, detail=f"Could not read the file: {exc.strerror}") from exc
    return Response(
        content=content,
        media_type="application/pdf",
        headers={"Cache-Control": "no-store", "X-Filename": path.name},
    )
