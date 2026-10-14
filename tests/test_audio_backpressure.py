"""A1/A2 — abandoned synthesis requests must not park the server's worker threads.

These tests drive a **real uvicorn server** rather than `TestClient`, because the defect
only exists over a real socket: the client aborts, uvicorn keeps running the handler, and
the handler parks on the engine's slot semaphore. `TestClient` cannot abort a request.

Reproduction (fails before the fix):
  60 clients each issue `GET /api/tts` with a 0.25 s timeout and hang up. Every one of
  them occupies an anyio worker thread waiting on the un-timed `with self._slots`. The
  pool holds 40 threads, so the next *sync* route — `GET /api/voices` — cannot be
  dispatched at all until the whole abandoned backlog has been synthesised.
"""

from __future__ import annotations

import socket
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from typing import Any

import httpx
import numpy as np
import pytest
import uvicorn
from fastapi import FastAPI

from kokoro_reader import config, tts_engine
from kokoro_reader.routes import health as health_routes
from kokoro_reader.routes import tts as tts_routes
from kokoro_reader.tts_engine import TTSBusy, TTSEngine

# ── Knobs chosen so the test is decisive in a couple of seconds ──────────────
RENDER_SECONDS = 0.5          # one synthesised chunk
ABANDONED_CLIENTS = 60        # the reviewer's number
CLIENT_TIMEOUT_S = 0.25       # < RENDER_SECONDS, so every client hangs up mid-synth
SYNC_ROUTE_DEADLINE_S = 2.0   # a free threadpool answers /api/voices in milliseconds
STARTUP_DEADLINE_S = 10.0
SHUTDOWN_DEADLINE_S = 5.0


class SlowModel:
    """Stands in for KokoroTTS. Every `generate` takes RENDER_SECONDS."""

    def __init__(self) -> None:
        self.renders = 0
        self._lock = threading.Lock()

    def generate(self, text: str, voice: str = "af_heart", speed: float = 1.0,
                 sample_rate: int = config.SAMPLE_RATE) -> Any:
        time.sleep(RENDER_SECONDS)
        with self._lock:
            self.renders += 1
        return _Result(np.zeros(sample_rate // 10, dtype=np.float32), sample_rate)

    def list_voices(self) -> list[str]:
        return ["af_heart"]


class _Result:
    def __init__(self, audio: np.ndarray, sample_rate: int) -> None:
        self.audio = audio
        self.sample_rate = sample_rate


@pytest.fixture
def slow_engine(tmp_path, monkeypatch: pytest.MonkeyPatch) -> TTSEngine:
    monkeypatch.setattr(config, "AUDIO_CACHE_DIR", tmp_path / "audio")
    (tmp_path / "audio").mkdir(parents=True, exist_ok=True)
    model = SlowModel()
    engine = TTSEngine(model_id="fake/model", loader=lambda _: model)
    engine.warmup()
    return engine


def _free_port() -> int:
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        return int(sock.getsockname()[1])


@pytest.fixture
def live_server(slow_engine: TTSEngine, monkeypatch: pytest.MonkeyPatch) -> str:
    """A real uvicorn server on an ephemeral port. Yields its base URL."""
    monkeypatch.setattr(tts_routes, "get_engine", lambda: slow_engine)
    app = FastAPI()
    app.include_router(tts_routes.router)
    app.include_router(health_routes.router)

    port = _free_port()
    server = uvicorn.Server(
        uvicorn.Config(app, host="127.0.0.1", port=port, log_level="error", lifespan="off")
    )
    thread = threading.Thread(target=server.run, daemon=True, name="test-uvicorn")
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


def _abandon(base: str, index: int) -> None:
    """Issue a synthesis request and hang up before it can possibly finish."""
    try:
        httpx.get(
            f"{base}/api/tts",
            params={"text": f"Abandoned request number {index}.", "voice": "af_heart"},
            timeout=CLIENT_TIMEOUT_S,
        )
    except httpx.HTTPError:
        pass  # the abort is the point of this call


def _flood(base: str, count: int = ABANDONED_CLIENTS) -> None:
    with ThreadPoolExecutor(max_workers=count) as pool:
        list(pool.map(lambda i: _abandon(base, i), range(count)))


# ── A2: the threadpool must survive a flood of abandoned requests ────────────

def test_sync_route_still_answers_after_sixty_abandoned_tts_requests(
    live_server: str,
) -> None:
    _flood(live_server)

    started = time.monotonic()
    response = httpx.get(f"{live_server}/api/voices", timeout=SYNC_ROUTE_DEADLINE_S)
    elapsed = time.monotonic() - started

    assert response.status_code == 200
    assert elapsed < SYNC_ROUTE_DEADLINE_S, (
        f"/api/voices took {elapsed:.1f}s — the anyio threadpool is parked on abandoned "
        f"synthesis work"
    )


# ── A1: the backlog a burst can create is bounded ────────────────────────────

def test_abandoned_burst_leaves_a_bounded_backlog(
    live_server: str, slow_engine: TTSEngine
) -> None:
    """After the flood, a *fresh* request must not queue behind the whole burst."""
    _flood(live_server)

    started = time.monotonic()
    response = httpx.get(
        f"{live_server}/api/tts",
        params={"text": "The request a real user is waiting for.", "voice": "af_heart"},
        timeout=30.0,
    )
    elapsed = time.monotonic() - started

    assert response.status_code in (200, 503)
    bound = (tts_engine.MAX_QUEUED_SYNTH + config.MAX_CONCURRENT_SYNTH) * RENDER_SECONDS + 1.0
    assert elapsed < bound, (
        f"a fresh request waited {elapsed:.1f}s behind abandoned work (bound {bound:.1f}s)"
    )


# ── Engine-level unit proof: the wait queue is bounded and timed ─────────────

def test_engine_rejects_work_once_the_wait_queue_is_full(slow_engine: TTSEngine) -> None:
    engine = TTSEngine(
        model_id="fake/model",
        loader=lambda _: SlowModel(),
        max_queued=1,
        slot_timeout=5.0,
    )
    engine.warmup()
    outcomes: list[str] = []
    lock = threading.Lock()

    def run(i: int) -> None:
        try:
            engine.synthesize(f"Sentence number {i}.", voice="af_heart")
            with lock:
                outcomes.append("ok")
        except TTSBusy:
            with lock:
                outcomes.append("busy")

    threads = [threading.Thread(target=run, args=(i,)) for i in range(10)]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join(timeout=20)

    assert len(outcomes) == 10, "every caller must return; none may park forever"
    assert outcomes.count("busy") > 0, "an unbounded queue accepted all 10 callers"
    assert outcomes.count("ok") <= config.MAX_CONCURRENT_SYNTH + 1


def test_engine_slot_wait_is_timed_not_indefinite(monkeypatch: pytest.MonkeyPatch,
                                                  tmp_path) -> None:
    monkeypatch.setattr(config, "AUDIO_CACHE_DIR", tmp_path / "audio")
    engine = TTSEngine(
        model_id="fake/model",
        loader=lambda _: SlowModel(),
        max_queued=8,
        slot_timeout=0.05,
    )
    engine.warmup()
    blockers = [
        threading.Thread(target=lambda i=i: _swallow(engine, f"Blocker {i}."), daemon=True)
        for i in range(config.MAX_CONCURRENT_SYNTH)
    ]
    for thread in blockers:
        thread.start()
    time.sleep(RENDER_SECONDS / 3)  # let the blockers take both slots

    try:
        started = time.monotonic()
        with pytest.raises(TTSBusy):
            engine.synthesize("A caller that must not park.", voice="af_heart")
        elapsed = time.monotonic() - started
    finally:
        # N1: a blocker still rendering after teardown writes its WAV into whatever
        # AUDIO_CACHE_DIR is by then, which is no longer tmp_path.
        for thread in blockers:
            thread.join(timeout=SHUTDOWN_DEADLINE_S)

    assert elapsed < 1.0, f"slot wait took {elapsed:.2f}s; it is not bounded"


def _swallow(engine: TTSEngine, text: str) -> None:
    try:
        engine.synthesize(text, voice="af_heart")
    except Exception:  # noqa: BLE001 - blocker threads only exist to hold slots
        pass


# ── Route mapping ────────────────────────────────────────────────────────────

def test_busy_engine_maps_to_503_with_retry_after(monkeypatch: pytest.MonkeyPatch) -> None:
    from fastapi.testclient import TestClient

    class BusyEngine:
        def synthesize(self, *args: Any, **kwargs: Any) -> bytes:
            raise TTSBusy("too many requests in flight")

    monkeypatch.setattr(tts_routes, "get_engine", lambda: BusyEngine())
    app = FastAPI()
    app.include_router(tts_routes.router)

    response = TestClient(app).get("/api/tts", params={"text": "Hello."})

    assert response.status_code == 503
    assert response.headers.get("retry-after")
