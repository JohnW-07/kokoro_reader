"""Kokoro Reader — a local, structure-aware PDF read-aloud desktop app.

Run with:  venv/bin/python app.py
The UI is a pywebview window pointed at a FastAPI server bound to localhost.
"""

from __future__ import annotations

import logging
import os
import threading
from pathlib import Path

import uvicorn
import webview
from fastapi import FastAPI
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

from kokoro_reader import config
from kokoro_reader.routes import health, notes, pdf, script, stats, summary, tts

logging.basicConfig(
    level=os.environ.get("KOKORO_LOG", "INFO"),
    format="%(asctime)s %(levelname)s %(name)s: %(message)s",
)
log = logging.getLogger("kokoro_reader")

ROOT = Path(__file__).parent
STATIC_DIR = ROOT / "static"
INDEX = STATIC_DIR / "index.html"

WINDOW_WIDTH = 1440
WINDOW_HEIGHT = 960
# Small enough to snap into half of a 1512 pt MacBook screen (756 pt); below 900 px the page folds its panels.
MIN_WINDOW_WIDTH = 600
MIN_WINDOW_HEIGHT = 480
NO_STORE = {"Cache-Control": "no-store"}
# pywebview defaults to private mode, which wipes WKWebView's localStorage at every launch and so loses the
# saved voice, speed, inclusions and subs. On macOS `storage_path` is ignored; the default data store persists.
WEBVIEW_START_ARGS = {"private_mode": False}
# Notes exports the window may save; WKWebView under pywebview drops both window.open and <a download>.
EXPORT_SUFFIXES = frozenset({".md", ".json"})


class NoStoreStaticFiles(StaticFiles):
    """Static files the desktop window must never serve from a stale cache after an update."""

    def file_response(self, *args, **kwargs):
        response = super().file_response(*args, **kwargs)
        response.headers.update(NO_STORE)
        return response


app = FastAPI(title="Kokoro Reader", version="2.0")
app.mount("/static", NoStoreStaticFiles(directory=STATIC_DIR), name="static")
for router in (health.router, tts.router, pdf.router, script.router, notes.router, stats.router, summary.router):
    app.include_router(router)


@app.get("/")
def index() -> FileResponse:
    return FileResponse(INDEX, media_type="text/html", headers=NO_STORE)


class PyWebViewApi:
    """Exposed to JavaScript as `window.pywebview.api`.

    WKWebView's `<input type=file>` is unreliable inside pywebview, so the native
    dialog is the primary path and the hidden file input is only a browser fallback.
    """

    def select_pdf(self) -> str | None:
        result = webview.windows[0].create_file_dialog(
            webview.OPEN_DIALOG,
            file_types=("PDF Files (*.pdf)",),
        )
        if not result:
            return None
        chosen = result[0]
        pdf.set_selected(chosen)
        return os.path.basename(chosen)

    def clear_pdf(self) -> bool:
        pdf.set_selected(None)
        return True

    def save_export(self, filename: str, text: str) -> str | None:
        """Save a notes export through the native Save dialog; returns the saved name, or None on cancel.

        Raises ValueError for a bad name or body and OSError with a short reason if the write fails;
        pywebview turns either into a rejected promise the UI shows.
        """
        if not isinstance(filename, str) or os.path.basename(filename) != filename:
            raise ValueError("Export name must be a plain file name.")
        if Path(filename).suffix.lower() not in EXPORT_SUFFIXES or not isinstance(text, str):
            raise ValueError("Only .md or .json notes can be exported.")
        result = webview.windows[0].create_file_dialog(webview.SAVE_DIALOG, save_filename=filename)
        if not result:
            return None
        # macOS returns the chosen path as a str; other backends return a one-item tuple.
        chosen = result if isinstance(result, str) else result[0]
        try:
            Path(chosen).write_text(text, encoding="utf-8")
        except OSError as err:
            log.warning("Could not save export to %s: %s", chosen, err)
            raise OSError(f"Could not save {os.path.basename(chosen)}: {err.strerror or err}") from None
        return os.path.basename(chosen)


def _serve() -> None:
    uvicorn.run(app, host=config.HOST, port=config.PORT, log_level="warning")


def main() -> None:
    config.ensure_dirs()
    threading.Thread(target=_serve, daemon=True).start()
    log.info("Serving on http://%s:%s", config.HOST, config.PORT)

    webview.create_window(
        title="Kokoro Reader",
        url=f"http://{config.HOST}:{config.PORT}",
        width=WINDOW_WIDTH,
        height=WINDOW_HEIGHT,
        min_size=(MIN_WINDOW_WIDTH, MIN_WINDOW_HEIGHT),
        js_api=PyWebViewApi(),
    )
    webview.start(**WEBVIEW_START_ARGS)


if __name__ == "__main__":
    main()
