"""Optional local-LLM script refinement.

Strictly an enhancement layer: the app must work with ``mlx_lm`` uninstalled and
the weights never downloaded, so **nothing here may raise into a caller and
nothing here may block longer than ``config.LLM_TIMEOUT_S``**. Every failure
degrades to returning the input unchanged. Importing this module is instant —
``mlx_lm`` is imported inside the worker thread on the first real ``refine()``.
"""

from __future__ import annotations

import hashlib
import json
import logging
import os
import re
import threading
import time
from concurrent.futures import Future
from concurrent.futures import TimeoutError as FutureTimeout
from importlib.util import find_spec
from pathlib import Path
from queue import SimpleQueue
from threading import Lock
from typing import Any, Callable, Protocol

from . import config, stats_store
from .hf_cache import cached_path_or_id

logger = logging.getLogger(__name__)

# ── Tunables local to this module ────────────────────────────────────────────
MIN_LENGTH_RATIO = 0.3          # output shorter than this * input -> reject
MAX_LENGTH_RATIO = 4.0          # output longer than this * input -> reject
MIN_DIGIT_RETENTION = 0.5       # dropping more than half the digits -> reject
TEMPERATURE = 0.1
LOG_TEXT_PREVIEW = 60           # never log more than this many chars of content
LLM_CACHE_MAX_ENTRIES = 5_000   # M7: refinement cache is LRU-capped, not unbounded
LLM_CACHE_SUFFIX = ".json"

LoadFn = Callable[[str], tuple[Any, Any]]
GenerateFn = Callable[[Any, Any, str, int], str]

_SYSTEM_BASE = (
    "You convert text extracted from an academic PDF into a clean script for a "
    "text-to-speech voice. Output ONLY the spoken text. No preamble, no markdown, "
    "no quotes, no explanation. Preserve meaning exactly; never add facts. Spell "
    "mathematical notation out in natural spoken English (e.g. 'x_i^2' becomes "
    "'x sub i squared'). Keep it concise and in the same order."
)
_KIND_SUFFIX = {
    "equation": (
        " This is a display equation. Render it as one natural spoken sentence a "
        "lecturer would say."
    ),
    "heading": " This is a section heading; keep it short.",
}

_THINK_RE = re.compile(r"<think>.*?</think>", re.DOTALL | re.IGNORECASE)
_REFUSAL_PREFIXES = (
    "sure", "here is", "here's", "here are", "the text", "i ", "i'm", "as an",
    "certainly", "of course", "okay", "note:",
)
_MARKDOWN_MARKERS = ("```", "**")
_TEMPLATE_MARKERS = ("<|", "|>")
_LEAK_WORDS = ("assistant", "system")
_QUOTE_PAIRS = (('"', '"'), ("'", "'"), ("“", "”"), ("‘", "’"))


class _LoadError(RuntimeError):
    """Model weights could not be loaded. Permanently disables the normalizer."""


# ── H7: a worker the interpreter will never wait for ─────────────────────────
class _SerialWorker:
    """One daemon thread running submitted jobs in order.

    Not a ``ThreadPoolExecutor``: that module registers every worker with an
    ``atexit`` hook (``_python_exit``) which **joins each thread unconditionally**.
    A generation wedged inside ``mlx_lm`` therefore keeps the whole interpreter
    alive and the app can never quit — the user's only exit is to kill it. A
    daemon thread is not joined at exit, so a wedged job costs one leaked thread
    and nothing else.
    """

    def __init__(self, name: str) -> None:
        self._jobs: SimpleQueue = SimpleQueue()
        self._thread = threading.Thread(target=self._run, name=name, daemon=True)
        self._thread.start()

    def submit(self, fn: Callable[[], str]) -> Future:
        future: Future = Future()
        self._jobs.put((fn, future))
        return future

    def shutdown(self) -> None:
        """Ask the worker to stop. A wedged worker simply never reads this."""
        self._jobs.put(None)

    def _run(self) -> None:
        while True:
            job = self._jobs.get()
            if job is None:
                return
            fn, future = job
            if not future.set_running_or_notify_cancel():
                continue
            try:
                future.set_result(fn())
            except BaseException as exc:  # noqa: BLE001 - delivered via the future
                future.set_exception(exc)


# ── Protocol + null implementation ───────────────────────────────────────────
class Normalizer(Protocol):
    def available(self) -> bool: ...
    def refine(self, text: str, kind: str) -> str: ...
    def name(self) -> str: ...


class NullNormalizer:
    """Identity normalizer. The rules-only rung of the degradation ladder."""

    def available(self) -> bool:
        return False

    def refine(self, text: str, kind: str = "body") -> str:
        return text

    def name(self) -> str:
        return "null"


# ── Availability probe (cheap, no download, no import of mlx_lm) ─────────────
def _hf_hub_dir() -> Path:
    """HuggingFace hub cache root, honouring the usual environment overrides."""
    explicit = os.environ.get("HUGGINGFACE_HUB_CACHE") or os.environ.get("HF_HUB_CACHE")
    if explicit:
        return Path(explicit)
    home = os.environ.get("HF_HOME")
    return Path(home) / "hub" if home else Path.home() / ".cache/huggingface/hub"


def model_is_local(model_id: str = "") -> bool:
    """True if the weights already exist on disk. Never downloads."""
    model_id = model_id or config.LLM_MODEL
    try:
        if Path(model_id).expanduser().is_dir():
            return True
        return (_hf_hub_dir() / ("models--" + model_id.replace("/", "--"))).is_dir()
    except OSError as exc:  # unreadable cache dir, weird path
        logger.debug("llm: model presence check failed: %s", exc)
        return False


def is_llm_available() -> bool:
    """Cheap probe: is ``mlx_lm`` importable and are the weights already local?"""
    if not config.LLM_ENABLED:
        return False
    try:
        if find_spec("mlx_lm") is None:
            return False
    except (ImportError, ValueError) as exc:
        logger.debug("llm: find_spec(mlx_lm) failed: %s", exc)
        return False
    return model_is_local(config.LLM_MODEL)


# ── Disk cache (failures degrade to "no cache", never raise) ─────────────────
def _cache_path(key: str) -> Path:
    return Path(config.LLM_CACHE_DIR) / f"{key}{LLM_CACHE_SUFFIX}"


def _cache_key(model_id: str, kind: str, text: str) -> str:
    return hashlib.sha1(f"{model_id}|{kind}|{text}".encode("utf-8")).hexdigest()


def _cache_read(key: str) -> dict | None:
    """The cached entry (``out`` is always a str), or None."""
    try:
        raw = _cache_path(key).read_text(encoding="utf-8")
        entry = json.loads(raw)
        return entry if isinstance(entry, dict) and isinstance(entry.get("out"), str) else None
    except FileNotFoundError:
        return None
    except (OSError, ValueError) as exc:
        logger.debug("llm: cache read failed: %s", exc)
        return None


def _cache_write(
    key: str, inp: str, out: str, model_id: str, usage: tuple[int, int] = (0, 0)
) -> None:
    path = _cache_path(key)
    payload = {"in": inp, "out": out, "model": model_id, "ts": time.time(),
               "tokens_in": usage[0], "tokens_out": usage[1]}
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        tmp = path.with_suffix(".tmp")
        tmp.write_text(json.dumps(payload), encoding="utf-8")
        tmp.replace(path)
    except (OSError, ValueError) as exc:
        logger.debug("llm: cache write failed: %s", exc)
        return
    evict_cache()


def evict_cache(max_entries: int | None = None) -> int:
    """Drop oldest-by-mtime entries past the cap (M7). Returns the number removed.

    A long book refines thousands of blocks and every one of them was kept forever.
    Counting entries rather than bytes is enough here: an entry is one short block.
    """
    cap = LLM_CACHE_MAX_ENTRIES if max_entries is None else max_entries
    try:
        entries = [(p, p.stat().st_mtime) for p in
                   Path(config.LLM_CACHE_DIR).glob(f"*{LLM_CACHE_SUFFIX}")]
    except OSError as exc:
        logger.debug("llm: cache scan failed: %s", exc)
        return 0
    if len(entries) <= cap:
        return 0
    removed = 0
    for path, _ in sorted(entries, key=lambda item: item[1])[: len(entries) - cap]:
        try:
            path.unlink(missing_ok=True)
            removed += 1
        except OSError as exc:
            logger.debug("llm: could not evict %s: %s", path.name, exc)
    return removed


def _count(value: Any) -> int:
    return value if isinstance(value, int) and not isinstance(value, bool) and value > 0 else 0


# ── Cleaning + validation ────────────────────────────────────────────────────
def _clean(raw: str) -> str:
    """Drop `<think>` blocks and surrounding quotes before validation."""
    if not raw:
        return ""
    text = _THINK_RE.sub("", raw)
    if "<think>" in text.lower():
        # Unterminated reasoning block: the model spent its budget thinking.
        return ""
    text = text.strip()
    for lead, trail in _QUOTE_PAIRS:
        while len(text) >= 2 and text.startswith(lead) and text.endswith(trail):
            text = text[1:-1].strip()
    return text


def _drops_digits(inp: str, out: str) -> bool:
    in_digits = sum(c.isdigit() for c in inp)
    out_digits = sum(c.isdigit() for c in out)
    return in_digits > 0 and out_digits < in_digits * MIN_DIGIT_RETENTION


def _reject_reason(inp: str, out: str, kind: str) -> str | None:
    if not out.strip():
        return "empty"
    lower = out.lower()
    if any(marker in out for marker in _MARKDOWN_MARKERS):
        return "markdown"
    if any(marker in out for marker in _TEMPLATE_MARKERS):
        return "template-leak"
    if any(word in lower and word not in inp.lower() for word in _LEAK_WORDS):
        return "role-leak"
    if lower.startswith(_REFUSAL_PREFIXES):
        return "preamble"
    if len(out) < len(inp) * MIN_LENGTH_RATIO:
        return "too-short"
    if len(out) > len(inp) * MAX_LENGTH_RATIO:
        return "too-long"
    if kind != "equation" and _drops_digits(inp, out):
        return "digits-dropped"
    return None


def _validate(inp: str, out: str, kind: str = "body") -> str:
    """Return ``out`` when it is trustworthy, otherwise the untouched ``inp``."""
    reason = _reject_reason(inp, out, kind)
    if reason is None:
        return out
    logger.debug("llm: rejected output (%s) for %r", reason, inp[:LOG_TEXT_PREVIEW])
    return inp


# ── Prompting ────────────────────────────────────────────────────────────────
def _system_prompt(kind: str) -> str:
    return _SYSTEM_BASE + _KIND_SUFFIX.get(kind, "")


def _build_prompt(tokenizer: Any, text: str, kind: str) -> str:
    return _chat_prompt(tokenizer, _system_prompt(kind), text)


def _chat_prompt(tokenizer: Any, system: str, text: str) -> str:
    messages = [{"role": "system", "content": system}, {"role": "user", "content": text}]
    apply = getattr(tokenizer, "apply_chat_template", None)
    if callable(apply) and getattr(tokenizer, "chat_template", None):
        try:
            return apply(messages, tokenize=False, add_generation_prompt=True)
        except (TypeError, ValueError) as exc:
            logger.debug("llm: chat template unusable, using plain prompt: %s", exc)
    return f"{system}\n\nText:\n{text}\n\nSpoken script:"


# ── Real mlx_lm bindings (imported lazily, inside the worker thread) ─────────
def _default_load(model_id: str) -> tuple[Any, Any]:
    from mlx_lm import load
    return load(cached_path_or_id(model_id))


def _default_generate(model: Any, tokenizer: Any, prompt: str, max_tokens: int) -> str:
    from mlx_lm import generate
    from mlx_lm.sample_utils import make_sampler

    sampler = make_sampler(temp=TEMPERATURE)
    return generate(
        model, tokenizer, prompt=prompt, max_tokens=max_tokens,
        sampler=sampler, verbose=False,
    )


class MlxNormalizer:
    """Lazy, disk-cached, timeout-guarded LLM normalizer that never raises.

    **The un-killable-thread problem.** Generation runs on a single
    ``_SerialWorker`` daemon thread so the weights load once and are used
    serially. Python cannot kill a thread, so when ``future.result(timeout=...)``
    expires we must not simply return and leave the worker in place: the stuck
    job still owns the only thread, so every later call would queue behind it and
    burn the full timeout before failing — the "wedges forever" failure this app
    already suffered elsewhere. Instead a timeout *poisons* the instance via
    ``_disable``: the worker is dropped and the normalizer flips permanently to
    pass-through. The orphaned thread finishes on its own and its result is
    discarded (nobody holds the future); it is bounded to one thread, can never
    block a caller again, and — being a daemon — can never hold up interpreter
    exit either (H7).
    """

    def __init__(
        self,
        model_id: str | None = None,
        generate_fn: GenerateFn | None = None,
        load_fn: LoadFn | None = None,
    ) -> None:
        self._model_id = model_id or config.LLM_MODEL
        self._generate_fn: GenerateFn = generate_fn or _default_generate
        self._load_fn: LoadFn | None = load_fn
        # Only the real loader reaches the network, so only it needs the H8 guard.
        self._may_download = load_fn is None
        self._model: Any = None
        self._tokenizer: Any = None
        # Two locks on purpose: a timeout must be able to flip state flags while
        # the worker thread is still holding the load lock, or we deadlock.
        self._load_lock = Lock()
        self._state_lock = Lock()
        self._worker: _SerialWorker | None = None
        self._disabled = False

    # ── public API ───────────────────────────────────────────────────────────
    def name(self) -> str:
        return self._model_id

    def available(self) -> bool:
        with self._state_lock:
            if self._disabled:
                return False
            loaded = self._model is not None
        return loaded or is_llm_available()

    def refine(self, text: str, kind: str = "body") -> str:
        """Return a spoken-script version of ``text``, or ``text`` unchanged."""
        try:
            return self._refine(text, kind)
        except Exception as exc:  # last-resort net: callers must never see this
            logger.warning("llm: refine failed unexpectedly (%s); passing through", exc)
            return text

    def complete(self, system: str, text: str, max_tokens: int) -> tuple[str, int, int] | None:
        """One free-form generation on the shared worker (N9 summaries).

        ``(raw output, prompt tokens, output tokens)``, or None when the model is unavailable,
        disabled, failed or timed out (same timeout and disable rule as ``refine``). No cache,
        no validation and no stats: the caller owns all three.
        """
        if not self.available():
            return None
        raw = self._generate_guarded(lambda: self._load_and_complete(system, text, max_tokens))
        if raw is None:
            return None
        return (raw, *self._count_tokens(lambda tokenizer: _chat_prompt(tokenizer, system, text), raw))

    # ── internals ────────────────────────────────────────────────────────────
    def _refine(self, text: str, kind: str) -> str:
        if not text or not text.strip():
            return text
        if len(text) > config.LLM_MAX_INPUT_CHARS:
            logger.debug("llm: input over %d chars; skipped", config.LLM_MAX_INPUT_CHARS)
            return text

        key = _cache_key(self._model_id, kind, text)
        cached = _cache_read(key)
        if cached is not None:
            # Entries written before token counting simply save 0 tokens.
            stats_store.record_llm(_count(cached.get("tokens_in")),
                                   _count(cached.get("tokens_out")), hit=True)
            return cached["out"]

        with self._state_lock:
            if self._disabled:
                return text

        raw = self._generate_guarded(lambda: self._load_and_generate(text, kind))
        if raw is None:
            return text

        usage = self._count_tokens(lambda tokenizer: _build_prompt(tokenizer, text, kind), raw)
        stats_store.record_llm(*usage)
        result = _validate(text, _clean(raw), kind)
        _cache_write(key, text, result, self._model_id, usage)
        return result

    def _count_tokens(self, prompt_of: Callable[[Any], str], raw: str) -> tuple[int, int]:
        """(prompt tokens in, completion tokens out), counted by the model's own tokenizer.

        Re-encodes the prompt and the decoded output: milliseconds next to a generation,
        and exact for the prompt. The output count can differ from the sampled one by the
        end-of-sequence token. (0, 0) when the tokenizer cannot encode.
        """
        tokenizer = self._tokenizer
        try:
            return len(tokenizer.encode(prompt_of(tokenizer))), len(tokenizer.encode(raw))
        except Exception as exc:  # noqa: BLE001 - counting is never worth a failure
            logger.debug("llm: token count unavailable: %s", exc)
            return 0, 0

    def _generate_guarded(self, job: Callable[[], str]) -> str | None:
        future = self._submit(job)
        if future is None:
            return None
        try:
            out = future.result(timeout=config.LLM_TIMEOUT_S)
        except FutureTimeout:
            self._disable(f"generation exceeded {config.LLM_TIMEOUT_S}s")
            return None
        except _LoadError as exc:
            self._disable(f"model load failed: {exc}")
            return None
        except Exception as exc:
            # A hard generation error is structural (bad tokenizer, OOM); retrying
            # it once per block across a long paper is worse than degrading now.
            self._disable(f"generation error: {exc}")
            return None
        return out if isinstance(out, str) else None

    def _submit(self, job: Callable[[], str]) -> Future | None:
        with self._state_lock:
            if self._disabled:
                return None
            if self._worker is None:
                self._worker = _SerialWorker("kokoro-llm")
            worker = self._worker
        try:
            return worker.submit(job)
        except RuntimeError as exc:  # worker torn down underneath us
            logger.debug("llm: submit rejected: %s", exc)
            return None

    def _load_and_generate(self, text: str, kind: str) -> str:
        """Runs on the worker thread. Loading is inside the timeout on purpose."""
        model, tokenizer = self._ensure_loaded()
        prompt = _build_prompt(tokenizer, text, kind)
        return self._generate_fn(model, tokenizer, prompt, config.LLM_MAX_TOKENS)

    def _load_and_complete(self, system: str, text: str, max_tokens: int) -> str:
        """Runs on the worker thread, like ``_load_and_generate``."""
        model, tokenizer = self._ensure_loaded()
        return self._generate_fn(model, tokenizer, _chat_prompt(tokenizer, system, text), max_tokens)

    def _ensure_loaded(self) -> tuple[Any, Any]:
        with self._load_lock:
            if self._model is None:
                self._refuse_download()
                loader = self._load_fn or _default_load
                try:
                    self._model, self._tokenizer = loader(self._model_id)
                except Exception as exc:
                    raise _LoadError(str(exc) or type(exc).__name__) from exc
            return self._model, self._tokenizer

    def _refuse_download(self) -> None:
        """H8: a refinement must never kick off a multi-GB weight download.

        ``mlx_lm.load`` fetches the whole repo when it is not cached, so the first
        ``refine()`` on a machine without the weights would silently start a 2.1 GB
        download inside a request. Absent weights mean "no LLM", not "go get one".
        """
        if self._may_download and not model_is_local(self._model_id):
            raise _LoadError(f"weights for {self._model_id!r} are not present locally")

    def _disable(self, reason: str) -> None:
        """Flip permanently to pass-through, logging exactly one warning.

        The worker is never joined: a timed-out job may still be running, and it is
        a daemon thread precisely so nobody ever has to wait for it.
        """
        with self._state_lock:
            worker, self._worker = self._worker, None
            already, self._disabled = self._disabled, True
        if worker is not None:
            worker.shutdown()
        if not already:
            logger.warning("llm: disabled for this process — %s", reason)


# ── Process-wide factory, memoised per flag ──────────────────────────────────
_normalizers: dict[bool, Normalizer] = {}
_factory_lock = Lock()


def get_normalizer(use_llm: bool) -> Normalizer:
    """Return the shared normalizer for ``use_llm``. Never raises."""
    want_llm = bool(use_llm) and config.LLM_ENABLED
    with _factory_lock:
        if want_llm not in _normalizers:
            _normalizers[want_llm] = MlxNormalizer() if want_llm else NullNormalizer()
        return _normalizers[want_llm]


def reset_normalizers() -> None:
    """Drop the memoised instances. For tests and settings changes."""
    with _factory_lock:
        _normalizers.clear()
