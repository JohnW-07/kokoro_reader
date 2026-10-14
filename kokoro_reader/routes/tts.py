"""TTS endpoints.

`GET /api/tts` is deliberately a **sync** `def`: FastAPI then runs it in the
threadpool, so synthesis never blocks the event loop (defect D3).

The threadpool is finite (40 threads), so the engine refuses work past its bound
rather than queueing it; that refusal surfaces here as `503` + `Retry-After`. A queued
request holds a worker thread, and enough abandoned ones stop every sync route from
being dispatched at all (A1/A2).
"""

from __future__ import annotations

import importlib.util
import logging
import re
from typing import Sequence

from fastapi import APIRouter, HTTPException, Query
from fastapi.responses import Response

from kokoro_reader import config, stats_store
from kokoro_reader.apple_engine import get_apple_engine, is_siri_voice
from kokoro_reader.tts_engine import (
    CACHE_SUFFIX, DEFAULT_PAUSE, PAUSE_TAIL_MS, TTSBusy, TTSError, TTSVoiceUnavailable, cache_key,
    get_engine,
)

log = logging.getLogger(__name__)

router = APIRouter(prefix="/api", tags=["tts"])

MAX_TEXT_CHARS = 20_000
MIN_SPEED = 0.5
MAX_SPEED = 2.0
VOICE_RE = re.compile(r"^[A-Za-z0-9_]+$")
NO_STORE_HEADERS = {"Cache-Control": "no-store"}
GENERIC_ERROR = "internal error while synthesising audio"
#: A refusal is fast and honest; queueing behind abandoned work wedges the server (A1/A2).
BUSY_HEADERS = {"Retry-After": "1", "Cache-Control": "no-store"}
#: R6: the voice is not on this machine (macOS removed Siri's); the client switches voice.
VOICE_UNAVAILABLE_STATUS = 424

#: Voice-name prefix -> modules its grapheme-to-phoneme backend needs. Measured by
#: synthesising "The result is clear." with one voice of each of the nine families on
#: 2026-09-11: `jf_alpha` failed with "No module named 'pyopenjtalk'" and `zf_xiaobei`
#: with "No module named 'ordered_set'"; a, b, e, f, h, i and p all produced audio.
LANGUAGE_REQUIREMENTS: dict[str, tuple[str, ...]] = {
    "j": ("pyopenjtalk",),      # Japanese, 5 voices
    "z": ("ordered_set",),      # Chinese, 8 voices -- a misaki[zh] dependency
}
#: Below this the filter is assumed wrong and the unfiltered list is returned.
MIN_USABLE_VOICES = 2

#: Used when the model cannot report its own voices.
FALLBACK_VOICES: tuple[str, ...] = (
    "af_aoede", "af_alloy", "af_heart", "af_bella", "af_sarah", "am_fenrir",
    "am_puck", "bf_alice", "bm_daniel", "bm_george",
)


def _validated_text(text: str) -> str:
    clean = text.strip()
    if not clean:
        raise HTTPException(status_code=400, detail="text must not be empty")
    if len(clean) > MAX_TEXT_CHARS:
        raise HTTPException(
            status_code=400, detail=f"text exceeds {MAX_TEXT_CHARS} characters"
        )
    return clean


def _validated_voice(voice: str) -> str:
    if not VOICE_RE.match(voice):
        raise HTTPException(status_code=400, detail=f"invalid voice: {voice!r}")
    return voice


def _validated_pause(pause: str) -> str:
    if pause not in PAUSE_TAIL_MS:
        raise HTTPException(status_code=400, detail=f"invalid pause: {pause!r}")
    return pause


def _clamped_speed(speed: float) -> float:
    return min(MAX_SPEED, max(MIN_SPEED, speed))


@router.get("/tts")
def get_tts(
    text: str = Query(..., description="Text to speak"),
    voice: str = Query(config.DEFAULT_VOICE),
    speed: float = Query(1.0),
    pause: str = Query(DEFAULT_PAUSE, description="Beat after the sentence (C1/N5)"),
) -> Response:
    """Synthesise `text` and return WAV bytes. Sync on purpose — see D3."""
    clean = _validated_text(text)
    voice = _validated_voice(voice)
    speed = _clamped_speed(speed)
    pause = _validated_pause(pause)
    hit = False
    try:
        engine = get_apple_engine() if is_siri_voice(voice) else get_engine()  # siri_*: dev switch
        hit = _is_cached(engine, clean, voice, speed)
        wav = engine.synthesize(clean, voice=voice, speed=speed, pause=pause)
    except TTSBusy as exc:
        log.info("tts refused: %s", exc)
        raise HTTPException(
            status_code=503, detail=str(exc), headers=dict(BUSY_HEADERS)
        ) from exc
    except TTSVoiceUnavailable as exc:
        log.warning("tts voice unavailable: %s", exc)
        raise HTTPException(
            status_code=VOICE_UNAVAILABLE_STATUS, detail=str(exc), headers=dict(NO_STORE_HEADERS)
        ) from exc
    except TTSError as exc:
        log.warning("tts failed: %s", exc)
        raise HTTPException(status_code=500, detail=str(exc)) from exc
    except Exception as exc:  # noqa: BLE001 - never leak internals to the client
        log.exception("unexpected tts failure")
        raise HTTPException(status_code=500, detail=GENERIC_ERROR) from exc
    stats_store.record_tts(len(clean), wav, hit, voice)
    return Response(content=wav, media_type="audio/wav", headers=NO_STORE_HEADERS)


def _is_cached(engine: object, text: str, voice: str, speed: float) -> bool:
    """Whether this request will be a disk-cache hit: one `stat`, for the stats page only."""
    try:
        key = cache_key(engine.cache_id, voice, float(speed), text)
        return (config.AUDIO_CACHE_DIR / f"{key}{CACHE_SUFFIX}").is_file()
    except Exception as exc:  # noqa: BLE001 - a stats probe must never fail a request
        log.debug("tts cache probe failed: %s", exc)
        return False


def usable_voices(voices: Sequence[str]) -> list[str]:
    """Drop voices whose language pack is not installed (M15).

    The model lists all 54 voices whether or not their grapheme-to-phoneme backend is
    present. Offering one that cannot speak turns picking a voice into a dead player.
    """
    kept = [v for v in voices if _language_available(v)]
    # Never hand back an empty picker: if the table is wrong, too much choice beats none.
    return kept if len(kept) >= MIN_USABLE_VOICES else list(voices)


def _language_available(voice: str) -> bool:
    for module in LANGUAGE_REQUIREMENTS.get(voice[:1], ()):
        try:
            if importlib.util.find_spec(module) is None:
                return False
        except (ImportError, ValueError):      # a broken parent package
            return False
    return True


@router.get("/voices")
def get_voices() -> dict[str, list[str]]:
    """Available voice names; falls back to the known set if the model cannot answer."""
    try:
        voices = get_engine().voices()
    except Exception as exc:  # noqa: BLE001 - a listing failure must not 500
        log.warning("voice listing failed, using fallback list: %s", exc)
        voices = []
    return {"voices": usable_voices(voices) if voices else list(FALLBACK_VOICES)}
