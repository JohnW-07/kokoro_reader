"""Kokoro TTS wrapper: chunking, in-memory WAV encoding, on-disk LRU cache.

Fixes D8 (no temp WAV in the process CWD) and D7 (cache key includes voice+speed).
All synthesis is blocking and thread-safe; callers run it in a threadpool.
"""

from __future__ import annotations

import hashlib
import io
import logging
import os
import re
import struct
import threading
import time
import uuid
from contextlib import contextmanager
from functools import wraps
from pathlib import Path
from typing import Any, Callable, Iterator, Sequence

import numpy as np
import soundfile as sf

from kokoro_reader import config, stats_store
from kokoro_reader.hf_cache import cached_path_or_id

log = logging.getLogger(__name__)

# ── Local tunables (not in config.py, which is owned elsewhere) ───────────────
CHUNK_GAP_MS = 120           # silence inserted between synthesised chunks
WAV_FORMAT = "WAV"
WAV_SUBTYPE = "PCM_16"
# RIFF layout, for pad_tail: "RIFF" <size> "WAVE", then chunks of <id> <size> <body>.
RIFF_SIZE_OFFSET = 4
RIFF_HEADER_BYTES = 12
CHUNK_HEADER_BYTES = 8
SIZE_FIELD_BYTES = 4
FMT_RATE_OFFSET = 4
FMT_BLOCK_ALIGN_OFFSET = 12
CACHE_SUFFIX = ".wav"
TMP_SUFFIX = ".tmp"
TMP_ORPHAN_MAX_AGE_S = 3600  # a .tmp older than this belongs to a dead process (M11)
MS_PER_S = 1000

# J5 — Kokoro pads every utterance with its own silence, and the client cannot see it.
# Measured 2026-09-13 over 12 real sentences from PI0_6.pdf at af_heart/1.0x: 315 ms of
# lead-in and 481 ms of tail on average, i.e. 795 ms of dead air at *every* sentence
# boundary. What sits in those regions is a steady low hiss, peaking at 0.0019 — about
# 47 dB below the speech peak (0.34–0.52) — and the cut is not threshold-sensitive:
# sweeping the threshold twentyfold, 0.001 to 0.02, moves it only from 312/471 ms to
# 328/512 ms. Strip it and re-pad to a fixed, natural beat: 150 ms per boundary, not 795.
SILENCE_THRESHOLD = 0.002    # just above the hiss, two orders of magnitude below speech
LEAD_PAD_MS = 30             # a hair of run-up so the first phoneme is never clipped
TAIL_PAD_MS = 120            # …and a short beat so consecutive sentences do not run on
# C1/N5 — the beat after a sentence depends on what follows it, which only the client
# knows, so it names one of these. Measured 2026-10-09 (af_aoede and af_heart, 10 PI0_6
# sentences, 1.0x; -35 dB on 10 ms RMS): past the pads the speech's own decay and onset
# add ~15 ms, and the model itself pauses 580–710 ms (median) between two sentences said
# in one pass. The old fixed 120 ms tail made every boundary ~165 ms. Heard in total now:
# ~295 ms inside a paragraph, ~645 at a paragraph's end, ~895 around a heading.
# The cached WAV keeps TAIL_PAD_MS; the rest is appended when serving (pad_tail), so the
# tier is not in the cache key and the existing cache stays valid.
PAUSE_TAIL_MS = {"sentence": 250, "paragraph": 600, "section": 850}
DEFAULT_PAUSE = "sentence"
#: Bumped whenever the produced WAV changes. Part of the cache key: without it the
#: on-disk cache would keep serving untrimmed audio for every sentence read before now.
AUDIO_FORMAT_VERSION = 2

# A1/A2 — admission control. Synthesis runs on anyio worker threads; without a bound on
# how many callers may *wait*, abandoned requests park the whole pool and every sync route
# stops answering. At most MAX_CONCURRENT_SYNTH + MAX_QUEUED_SYNTH threads are ever held,
# and no thread waits longer than SLOT_WAIT_TIMEOUT_S.
MAX_QUEUED_SYNTH = 4
SLOT_WAIT_TIMEOUT_S = 20.0
QUEUE_FULL_MESSAGE = "synthesis queue is full; retry shortly"

_SENTENCE_RE = re.compile(r"(?<=[.!?…])\s+")
_CLAUSE_RE = re.compile(r"(?<=[,;:—])\s+")

ModelLoader = Callable[[str], Any]


class TTSError(RuntimeError):
    """Any failure to produce audio, with a human-readable message."""


class TTSBusy(TTSError):
    """Refused rather than queued: the server is already at its synthesis bound.

    A refusal is the *correct* answer here — a caller that queues behind abandoned
    work holds a worker thread, and enough of those wedge the whole server (A1/A2).
    """


class TTSVoiceUnavailable(TTSError):
    """The voice is not on this machine at all, e.g. macOS removed the Siri voice (R6).

    Unlike a failed render, retrying cannot help: the client should switch voice.
    """


def _default_loader(model_id: str) -> Any:
    from kokoro_mlx import KokoroTTS  # imported lazily: heavy, MLX-only

    return KokoroTTS.from_pretrained(cached_path_or_id(model_id))


# ── Text chunking ─────────────────────────────────────────────────────────────

def _hard_wrap(text: str, limit: int) -> list[str]:
    """Last resort: wrap on word boundaries, slicing words longer than `limit`."""
    words: list[str] = []
    for word in text.split():
        if len(word) <= limit:
            words.append(word)
            continue
        words.extend(word[i : i + limit] for i in range(0, len(word), limit))
    return _pack(words, limit)


def _split_units(text: str, limit: int) -> list[str]:
    """Break text into speakable atoms, each at most `limit` characters."""
    units: list[str] = []
    for sentence in _SENTENCE_RE.split(text):
        stripped = sentence.strip()
        if not stripped:
            continue
        if len(stripped) <= limit:
            units.append(stripped)
            continue
        for clause in _CLAUSE_RE.split(stripped):
            clean = clause.strip()
            if not clean:
                continue
            if len(clean) <= limit:
                units.append(clean)
            else:
                units.extend(_hard_wrap(clean, limit))
    return units


def _pack(units: Sequence[str], limit: int) -> list[str]:
    """Greedily join atoms into the fewest chunks of at most `limit` characters."""
    chunks: list[str] = []
    current = ""
    for unit in units:
        candidate = f"{current} {unit}".strip()
        if current and len(candidate) > limit:
            chunks.append(current)
            current = unit
        else:
            current = candidate
    if current:
        chunks.append(current)
    return chunks


def split_for_synthesis(text: str, limit: int = config.MAX_TTS_CHARS) -> tuple[str, ...]:
    """Split `text` on sentence, then clause, then word boundaries."""
    stripped = text.strip()
    if len(stripped) <= limit:
        return (stripped,)
    return tuple(_pack(_split_units(stripped, limit), limit)) or (stripped[:limit],)


# ── Audio encoding ────────────────────────────────────────────────────────────

def _silence(sample_rate: int, ms: float = CHUNK_GAP_MS) -> np.ndarray:
    return np.zeros(int(sample_rate * ms / MS_PER_S), dtype=np.float32)


def strip_silence(audio: np.ndarray) -> np.ndarray:
    """Return the span from the first to the last audible sample (J5).

    Pure: a view of `audio`, never a mutation of it. Audio that is silent
    throughout is returned unchanged rather than emptied — an empty result would
    turn a quiet utterance into a media error on the client.
    """
    loud = np.flatnonzero(np.abs(audio) > SILENCE_THRESHOLD)
    if loud.size == 0:
        return audio
    return audio[int(loud[0]) : int(loud[-1]) + 1]


def encode_wav(audio: np.ndarray, sample_rate: int) -> bytes:
    """Encode float audio to WAV bytes in memory — never touches the filesystem."""
    buffer = io.BytesIO()
    sf.write(buffer, audio, sample_rate, format=WAV_FORMAT, subtype=WAV_SUBTYPE)
    return buffer.getvalue()


def _chunks(wav: bytes) -> Iterator[tuple[bytes, int, int]]:
    """Yield (id, body offset, body size) for each RIFF chunk of a WAV file."""
    if wav[:4] != b"RIFF" or wav[8:12] != b"WAVE":
        raise TTSError("not a WAV file")
    offset = RIFF_HEADER_BYTES
    while offset + CHUNK_HEADER_BYTES <= len(wav):
        chunk_id, size = struct.unpack_from("<4sI", wav, offset)
        yield chunk_id, offset + CHUNK_HEADER_BYTES, size
        offset += CHUNK_HEADER_BYTES + size + (size & 1)


def pad_tail(wav: bytes, ms: float) -> bytes:
    """Return `wav` with `ms` of digital silence appended to its PCM data (C1/N5).

    Pure byte surgery — no decode, no re-encode — with the RIFF and data sizes fixed.
    """
    chunks = {chunk_id: (body, size) for chunk_id, body, size in _chunks(wav)}
    if b"fmt " not in chunks or b"data" not in chunks:
        raise TTSError("WAV has no fmt or data chunk")
    fmt = chunks[b"fmt "][0]
    sample_rate, = struct.unpack_from("<I", wav, fmt + FMT_RATE_OFFSET)
    block_align, = struct.unpack_from("<H", wav, fmt + FMT_BLOCK_ALIGN_OFFSET)
    extra = int(sample_rate * ms / MS_PER_S) * block_align
    if extra <= 0:
        return wav
    body, size = chunks[b"data"]
    end = body + size
    out = (wav[: body - SIZE_FIELD_BYTES] + struct.pack("<I", size + extra)
           + wav[body:end] + bytes(extra) + wav[end:])
    riff_size = struct.pack("<I", len(out) - CHUNK_HEADER_BYTES)
    return out[:RIFF_SIZE_OFFSET] + riff_size + out[CHUNK_HEADER_BYTES:]


# ── On-disk LRU cache (failures degrade to "no cache", never raise) ───────────

def cache_key(model_id: str, voice: str, speed: float, text: str) -> str:
    raw = f"{model_id}|{voice}|{speed:.2f}|v{AUDIO_FORMAT_VERSION}|{text}"
    return hashlib.sha1(raw.encode("utf-8")).hexdigest()


def _cache_path(key: str) -> Path:
    return config.AUDIO_CACHE_DIR / f"{key}{CACHE_SUFFIX}"


def cache_read(key: str) -> bytes | None:
    """Return cached WAV bytes and bump mtime, or None if unavailable."""
    path = _cache_path(key)
    try:
        data = path.read_bytes()
    except FileNotFoundError:
        return None
    except OSError as exc:
        log.warning("audio cache read failed for %s: %s", key, exc)
        return None
    try:
        now = time.time()
        os.utime(path, (now, now))
    except OSError as exc:
        log.debug("could not bump mtime for %s: %s", key, exc)
    return data


def _tmp_path(path: Path) -> Path:
    """A tmp name unique to this writer (H4).

    A deterministic `<key>.wav.tmp` is shared by every concurrent writer of the same
    key: one writer's `os.replace` moves the file another is still writing into, so the
    *live* cache entry gets the rest of the second writer's bytes and is served, torn,
    as HTTP 200.
    """
    return path.with_name(f"{path.name}.{os.getpid()}.{uuid.uuid4().hex}{TMP_SUFFIX}")


def cache_write(key: str, wav: bytes) -> None:
    """Store WAV bytes atomically, then evict down to the byte cap."""
    path = _cache_path(key)
    tmp = _tmp_path(path)
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        tmp.write_bytes(wav)
        os.replace(tmp, path)
    except OSError as exc:
        log.warning("audio cache write failed for %s: %s", key, exc)
        _unlink_quietly(tmp)
        return
    evict_cache()


def _unlink_quietly(path: Path) -> None:
    try:
        path.unlink(missing_ok=True)
    except OSError as exc:
        log.debug("could not remove %s: %s", path, exc)


def sweep_tmp_orphans(max_age_s: float = TMP_ORPHAN_MAX_AGE_S) -> int:
    """Remove `.tmp` files left behind by a crashed or killed writer (M11).

    Returns the number removed. Only files older than `max_age_s` are touched, so a
    concurrent writer's tmp file is never pulled out from under it.
    """
    cutoff = time.time() - max_age_s
    removed = 0
    try:
        candidates = list(config.AUDIO_CACHE_DIR.glob(f"*{TMP_SUFFIX}"))
    except OSError as exc:
        log.warning("audio cache tmp scan failed: %s", exc)
        return 0
    for path in candidates:
        try:
            if path.stat().st_mtime > cutoff:
                continue
        except OSError:
            continue
        _unlink_quietly(path)
        removed += 1
    return removed


def evict_cache(max_bytes: int | None = None) -> None:
    """Delete `.tmp` orphans, then oldest-by-mtime entries until the cache fits the cap."""
    sweep_tmp_orphans()
    cap = config.AUDIO_CACHE_MAX_BYTES if max_bytes is None else max_bytes
    try:
        entries = [(p, p.stat()) for p in config.AUDIO_CACHE_DIR.glob(f"*{CACHE_SUFFIX}")]
    except OSError as exc:
        log.warning("audio cache scan failed: %s", exc)
        return
    total = sum(st.st_size for _, st in entries)
    if total <= cap:
        return
    for path, st in sorted(entries, key=lambda item: item[1].st_mtime):
        if total <= cap:
            break
        _unlink_quietly(path)
        total -= st.st_size


# ── Engine ────────────────────────────────────────────────────────────────────

class TTSEngine:
    """Lazily-loaded Kokoro wrapper. `synthesize` is blocking and thread-safe."""

    def __init__(
        self,
        model_id: str = config.TTS_MODEL,
        loader: ModelLoader = _default_loader,
        max_queued: int = MAX_QUEUED_SYNTH,
        slot_timeout: float = SLOT_WAIT_TIMEOUT_S,
    ) -> None:
        self._model_id = model_id
        self._cache_id = config.tts_cache_id(model_id)
        self._loader = loader
        self._model: Any | None = None
        self._load_lock = threading.Lock()
        self._slots = threading.Semaphore(config.MAX_CONCURRENT_SYNTH)
        self._slot_timeout = float(slot_timeout)
        self._max_inflight = config.MAX_CONCURRENT_SYNTH + max(0, int(max_queued))
        self._inflight_lock = threading.Lock()
        self._inflight = 0

    @property
    def model_id(self) -> str:
        return self._model_id

    @property
    def cache_id(self) -> str:
        return self._cache_id

    def is_ready(self) -> bool:
        return self._model is not None

    def warmup(self) -> None:
        self._model_or_load()

    def voices(self) -> list[str]:
        model = self._model_or_load()
        try:
            return list(model.list_voices())
        except Exception as exc:  # noqa: BLE001 - surfaced as TTSError
            raise TTSError(f"could not list voices: {exc}") from exc

    def synthesize(
        self, text: str, voice: str, speed: float = 1.0, pause: str = DEFAULT_PAUSE
    ) -> bytes:
        """Return a complete WAV byte string for `text`, ending in the `pause` beat."""
        clean = text.strip()
        if not clean:
            raise TTSError("cannot synthesise empty text")
        if pause not in PAUSE_TAIL_MS:
            raise TTSError(f"unknown pause {pause!r}")
        speed = float(speed)
        key = cache_key(self._cache_id, voice, speed, clean)
        wav = cache_read(key)
        if wav is None:
            with self._slot():
                wav = self._render(clean, voice, speed)
            cache_write(key, wav)
        return pad_tail(wav, PAUSE_TAIL_MS[pause] - TAIL_PAD_MS)

    @property
    def inflight(self) -> int:
        """Callers currently rendering or waiting for a slot. For diagnostics."""
        with self._inflight_lock:
            return self._inflight

    # ── internals ────────────────────────────────────────────────────────────

    @contextmanager
    def _slot(self) -> Iterator[None]:
        """Hold a synthesis slot, or refuse (A1/A2).

        Two bounds, both required. The *admission* bound caps how many worker threads
        this engine can hold at once, so a burst of abandoned requests can never drain
        the server's threadpool. The *wait* bound means an admitted caller still cannot
        park indefinitely if a render wedges.
        """
        with self._inflight_lock:
            if self._inflight >= self._max_inflight:
                raise TTSBusy(QUEUE_FULL_MESSAGE)
            self._inflight += 1
        try:
            if not self._slots.acquire(timeout=self._slot_timeout):
                raise TTSBusy(f"waited {self._slot_timeout:.0f}s for a synthesis slot")
            try:
                yield
            finally:
                self._slots.release()
        finally:
            with self._inflight_lock:
                self._inflight -= 1

    def _model_or_load(self) -> Any:
        if self._model is not None:
            return self._model
        with self._load_lock:
            if self._model is None:
                self._model = self._load()
        return self._model

    def _load(self) -> Any:
        try:
            return count_phoneme_tokens(self._loader(self._model_id))
        except Exception as exc:  # noqa: BLE001 - surfaced as TTSError
            raise TTSError(f"could not load TTS model {self._model_id!r}: {exc}") from exc

    def _render(self, text: str, voice: str, speed: float) -> bytes:
        model = self._model_or_load()
        parts: list[np.ndarray] = []
        sample_rate = config.SAMPLE_RATE
        for index, chunk in enumerate(split_for_synthesis(text)):
            audio, sample_rate = self._generate(model, chunk, voice, speed)
            if index:
                parts.append(_silence(sample_rate))
            # Each chunk carries its own lead-in and tail; left in place, a chunked
            # sentence stutters internally as well as at its ends (J5).
            parts.append(strip_silence(audio))
        if not parts:
            raise TTSError("synthesis produced no audio")
        padded = [
            _silence(sample_rate, LEAD_PAD_MS),
            *parts,
            _silence(sample_rate, TAIL_PAD_MS),
        ]
        return encode_wav(np.concatenate(padded), sample_rate)

    def _generate(
        self, model: Any, chunk: str, voice: str, speed: float
    ) -> tuple[np.ndarray, int]:
        _counted.tokens = 0
        try:
            result = model.generate(
                chunk, voice=voice, speed=speed, sample_rate=config.SAMPLE_RATE
            )
            audio = np.asarray(result.audio, dtype=np.float32).reshape(-1)
            rate = int(getattr(result, "sample_rate", config.SAMPLE_RATE) or config.SAMPLE_RATE)
        except TTSVoiceUnavailable:
            raise
        except Exception as exc:  # noqa: BLE001 - surfaced as TTSError
            raise TTSError(f"synthesis failed for voice {voice!r}: {exc}") from exc
        if audio.size == 0:
            raise TTSError(f"synthesis returned empty audio for voice {voice!r}")
        stats_store.record_tokens(_counted.tokens, voice)
        return audio, rate


# ── W2: Kokoro's own token count, taken from its single G2P pass ─────────────
_counted = threading.local()   # per thread: generate runs G2P on the caller's thread
_COUNTING_MARK = "_kokoro_reader_counts_tokens"


def _counting(phonemize_long: Callable[[str], Any]) -> Callable[[str], Any]:
    """Wrap a phonemizer's ``phonemize_long`` so this thread keeps the token ids' count."""

    @wraps(phonemize_long)
    def counted(text: str) -> Any:
        chunks = phonemize_long(text)
        try:
            _counted.tokens = getattr(_counted, "tokens", 0) + sum(len(ids) for _, ids in chunks)
        except Exception as exc:  # noqa: BLE001 - a stats count must never fail synthesis
            log.debug("phoneme count skipped: %s", exc)
        return chunks

    setattr(counted, _COUNTING_MARK, True)
    return counted


def count_phoneme_tokens(model: Any) -> Any:
    """Have ``model`` report Kokoro's input tokens, pads included, from the G2P it already runs.

    kokoro_mlx does not return the count, but every ``generate`` fetches its cached
    phonemizer with ``_get_phonemizer`` and calls ``phonemize_long`` once, under the
    model's lock. Wrapping that call adds no second G2P pass and no lock time. A model
    without these internals, or a phonemizer that cannot be wrapped, counts 0.
    """
    get_phonemizer = getattr(model, "_get_phonemizer", None)
    if get_phonemizer is None or getattr(get_phonemizer, _COUNTING_MARK, False):
        return model

    @wraps(get_phonemizer)
    def counting_get(language: str | None, voice: str) -> Any:
        phonemizer = get_phonemizer(language, voice)
        try:
            if not getattr(phonemizer.phonemize_long, _COUNTING_MARK, False):
                phonemizer.phonemize_long = _counting(phonemizer.phonemize_long)
        except Exception as exc:  # noqa: BLE001 - a stats count must never fail synthesis
            log.debug("phoneme count unavailable: %s", exc)
        return phonemizer

    setattr(counting_get, _COUNTING_MARK, True)
    try:
        model._get_phonemizer = counting_get
    except Exception as exc:  # noqa: BLE001 - a stats count must never fail loading
        log.debug("phoneme count unavailable: %s", exc)
    return model


_engine: TTSEngine | None = None
_engine_lock = threading.Lock()


def get_engine() -> TTSEngine:
    """Process-wide singleton, lazily constructed (the model itself loads later)."""
    global _engine
    if _engine is None:
        with _engine_lock:
            if _engine is None:
                _engine = TTSEngine()
    return _engine
