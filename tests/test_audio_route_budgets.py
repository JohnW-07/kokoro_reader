"""M9/M10 — routes must not hold the event loop, and must bound the work they accept.

M9 needs a real server too: `TestClient` drives the app through a portal, so an
`async def` handler that blocks looks identical to one that does not. Only a live loop
with a *concurrent* request shows the stall.
"""

from __future__ import annotations

import socket
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import httpx
import pytest
import uvicorn
from fastapi import FastAPI
from fastapi.testclient import TestClient

from kokoro_reader import config, notes_store
from kokoro_reader.routes import health as health_routes
from kokoro_reader.routes import notes as notes_routes
from kokoro_reader.routes import script as script_routes

SLOW_SAVE_SECONDS = 1.0       # a contended or sleeping disk
CONCURRENT_WRITERS = 3
LOOP_DEADLINE_S = 0.5         # R2: /api/health answers on the loop, in milliseconds
STARTUP_DEADLINE_S = 10.0
SHUTDOWN_DEADLINE_S = 5.0

DOC_ID = "a" * 40


def _free_port() -> int:
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        return int(sock.getsockname()[1])


@pytest.fixture
def slow_notes_server(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> str:
    monkeypatch.setattr(config, "DOCS_DIR", tmp_path / "docs")
    (tmp_path / "docs").mkdir(parents=True, exist_ok=True)

    real_save = notes_store.save

    def slow_save(record: notes_store.DocRecord) -> notes_store.DocRecord:
        time.sleep(SLOW_SAVE_SECONDS)
        return real_save(record)

    monkeypatch.setattr(notes_routes.notes_store, "save", slow_save)

    app = FastAPI()
    app.include_router(notes_routes.router)
    app.include_router(health_routes.router)
    port = _free_port()
    server = uvicorn.Server(
        uvicorn.Config(app, host="127.0.0.1", port=port, log_level="error", lifespan="off")
    )
    thread = threading.Thread(target=server.run, daemon=True, name="test-uvicorn-notes")
    thread.start()
    base = f"http://127.0.0.1:{port}"
    _await_ready(base)
    try:
        yield base
    finally:
        server.should_exit = True
        thread.join(timeout=SHUTDOWN_DEADLINE_S)


def _await_ready(base: str) -> None:
    deadline = time.monotonic() + STARTUP_DEADLINE_S
    while time.monotonic() < deadline:
        try:
            if httpx.get(f"{base}/api/health", timeout=0.5).status_code == 200:
                return
        except httpx.HTTPError:
            time.sleep(0.05)
    raise AssertionError(f"test server did not start within {STARTUP_DEADLINE_S}s")


# ── M9 ────────────────────────────────────────────────────────────────────────

def test_slow_notes_writes_do_not_stall_the_event_loop(slow_notes_server: str) -> None:
    """An `async def` handler doing `open()/fsync()` blocks every other route.

    Three concurrent saves of 1 s each held the loop for ~3 s, so `/api/health` — which
    is meant to prove the loop is free — could not answer at all until they finished.
    """
    body = {"doc_id": DOC_ID, "title": "Slow", "highlights": [], "last_index": 0}

    def put(i: int) -> int:
        return httpx.put(
            f"{slow_notes_server}/api/notes/{DOC_ID}", json=body, timeout=30.0
        ).status_code

    with ThreadPoolExecutor(max_workers=CONCURRENT_WRITERS) as pool:
        pending = [pool.submit(put, i) for i in range(CONCURRENT_WRITERS)]
        time.sleep(0.1)  # let every writer reach the handler

        started = time.monotonic()
        health = httpx.get(f"{slow_notes_server}/api/health", timeout=LOOP_DEADLINE_S)
        elapsed = time.monotonic() - started

        assert [f.result() for f in pending] == [200] * CONCURRENT_WRITERS

    assert health.status_code == 200
    assert elapsed < LOOP_DEADLINE_S, (
        f"/api/health took {elapsed:.2f}s — a notes handler is holding the event loop"
    )


def test_notes_handlers_run_in_the_threadpool_not_on_the_loop() -> None:
    import inspect

    for route in notes_routes.router.routes:
        assert not inspect.iscoroutinefunction(route.endpoint), route.path


# ── M10 ───────────────────────────────────────────────────────────────────────

def _line(idx: int) -> dict:
    text = "We show that the method improves the baseline on every task."
    return {
        "idx": idx, "text": text, "x0": 72.0, "x1": 520.0, "y": 100.0 + (idx % 60) * 11.0,
        "size": 9.9, "font": "f1", "items": [idx * 2, idx * 2 + 1],
        "item_x": [72.0, 110.0], "item_text": [text, ""], "item_size": [9.9, 9.9],
    }


def _request(pages: int, lines_per_page: int) -> dict:
    return {
        "doc_id": "b" * 40,
        "stats": {"body_size": 9.9, "num_pages": pages, "repeated": [],
                  "reference_page": None},
        "pages": [
            {"page": p + 1, "width": 612.0, "height": 792.0,
             "lines": [_line(i) for i in range(lines_per_page)]}
            for p in range(pages)
        ],
        "options": {},
    }


@pytest.fixture
def script_client() -> TestClient:
    app = FastAPI()
    app.include_router(script_routes.router)
    return TestClient(app)


def test_script_build_rejects_a_request_over_its_work_budget(
    script_client: TestClient,
) -> None:
    """Page and per-page caps alone admitted 320 000 lines — measured at 40.7 s of
    classification holding one threadpool worker. The budget is on the real work."""
    over = script_routes.MAX_TOTAL_LINES // 20 + 1

    response = script_client.post("/api/script/build", json=_request(20, over))

    assert response.status_code == 400
    assert "lines" in response.json()["detail"]


def test_script_build_still_accepts_a_dense_eighty_page_batch(
    script_client: TestClient,
) -> None:
    """The budget must not reject anything a real document produces."""
    response = script_client.post("/api/script/build", json=_request(80, 60))

    assert response.status_code == 200
    assert response.json()["sentences"]


def test_the_work_budget_bounds_a_worst_case_request(script_client: TestClient) -> None:
    """Worst case admitted must stay far under the 40.7 s the old caps allowed."""
    per_page = script_routes.MAX_TOTAL_LINES // script_routes.MAX_PAGES_PER_REQUEST

    started = time.monotonic()
    response = script_client.post(
        "/api/script/build", json=_request(script_routes.MAX_PAGES_PER_REQUEST, per_page)
    )
    elapsed = time.monotonic() - started

    assert response.status_code == 200
    assert elapsed < 20.0, f"the largest admitted request took {elapsed:.1f}s"
