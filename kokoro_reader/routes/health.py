"""Liveness endpoint.

Proof that the event loop is free (requirement R2): this handler must answer in
well under 100 ms while a synthesis is in flight, so it loads nothing and never
raises.
"""

from __future__ import annotations

import asyncio
import logging

from fastapi import APIRouter

from kokoro_reader import config

log = logging.getLogger(__name__)

router = APIRouter(prefix="/api", tags=["health"])

API_VERSION = "2.0"
LLM_PROBE_TIMEOUT_S = 0.05  # a slow probe reports "unavailable" rather than stalling R2


def _tts_ready() -> bool:
    """Whether the model is already loaded. Never triggers a load."""
    try:
        from kokoro_reader.tts_engine import get_engine

        return bool(get_engine().is_ready())
    except Exception as exc:  # noqa: BLE001 - health must never raise
        log.debug("tts readiness probe failed: %s", exc)
        return False


def _llm_available() -> bool:
    """Whether the LLM normaliser reports itself usable. Never raises."""
    try:
        from kokoro_reader import llm

        return bool(llm.get_normalizer(config.LLM_ENABLED).available())
    except (ImportError, AttributeError):
        return False
    except Exception as exc:  # noqa: BLE001 - health must never raise
        log.debug("llm availability probe failed: %s", exc)
        return False


@router.get("/health")
async def health() -> dict[str, object]:
    try:
        llm_available = await asyncio.wait_for(
            asyncio.to_thread(_llm_available), LLM_PROBE_TIMEOUT_S
        )
    except Exception as exc:  # noqa: BLE001 - health must never raise (incl. timeout)
        log.debug("llm probe timed out or failed: %s", exc)
        llm_available = False
    return {
        "ok": True,
        "tts_ready": _tts_ready(),
        "llm_available": llm_available,
        "llm_model": config.LLM_MODEL,
        "version": API_VERSION,
    }
