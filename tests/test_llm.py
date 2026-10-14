"""Tests for the optional LLM normalization layer.

No real model is ever downloaded or loaded here: ``MlxNormalizer`` takes
injectable ``load_fn`` / ``generate_fn`` hooks and every test supplies fakes.
"""

from __future__ import annotations

import json
import time
from pathlib import Path
from typing import Any

import pytest

from kokoro_reader import config, llm


@pytest.fixture(autouse=True)
def isolated_cache(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    """Every test gets its own empty LLM cache and a clean factory."""
    monkeypatch.setattr(config, "LLM_CACHE_DIR", tmp_path)
    llm.reset_normalizers()
    yield tmp_path
    llm.reset_normalizers()


class FakeTokenizer:
    """Tokenizer without a chat template -> exercises the plain-prompt path."""

    chat_template = None


def make_normalizer(
    output: str = "spoken output",
    *,
    delay: float = 0.0,
    load_error: Exception | None = None,
) -> tuple[llm.MlxNormalizer, dict[str, int]]:
    calls = {"load": 0, "generate": 0}

    def load_fn(model_id: str) -> tuple[Any, Any]:
        calls["load"] += 1
        if load_error is not None:
            raise load_error
        return object(), FakeTokenizer()

    def generate_fn(model: Any, tokenizer: Any, prompt: str, max_tokens: int) -> str:
        calls["generate"] += 1
        if delay:
            time.sleep(delay)
        return output

    normalizer = llm.MlxNormalizer(
        model_id="fake/model", generate_fn=generate_fn, load_fn=load_fn
    )
    return normalizer, calls


# ── NullNormalizer + factory ─────────────────────────────────────────────────
def test_null_normalizer_is_the_identity() -> None:
    null = llm.NullNormalizer()

    assert null.refine("x_i^2 <= n", "equation") == "x_i^2 <= n"
    assert null.available() is False
    assert null.name() == "null"


def test_get_normalizer_false_returns_null_normalizer() -> None:
    assert isinstance(llm.get_normalizer(False), llm.NullNormalizer)


def test_get_normalizer_is_memoised_per_flag() -> None:
    assert llm.get_normalizer(False) is llm.get_normalizer(False)


def test_importing_llm_does_not_import_mlx_lm() -> None:
    import subprocess
    import sys

    code = "import kokoro_reader.llm, sys; print('mlx_lm' in sys.modules)"
    out = subprocess.run([sys.executable, "-c", code], capture_output=True, text=True)

    assert out.stdout.strip() == "False", out.stderr


# ── Happy path ───────────────────────────────────────────────────────────────
def test_refine_returns_model_output_when_it_validates() -> None:
    normalizer, calls = make_normalizer("x sub i squared is at most n.")

    result = normalizer.refine("x_i^2 <= n", "equation")

    assert result == "x sub i squared is at most n."
    assert calls["generate"] == 1


def test_refine_passes_through_empty_and_oversized_input() -> None:
    normalizer, calls = make_normalizer()
    huge = "a" * (config.LLM_MAX_INPUT_CHARS + 1)

    assert normalizer.refine("   ", "body") == "   "
    assert normalizer.refine(huge, "body") == huge
    assert calls["generate"] == 0


# ── _validate rejection rules ────────────────────────────────────────────────
INPUT_TEXT = "We report 12 accuracy 345 on 6789 samples"

REJECTIONS = [
    ("empty", INPUT_TEXT, ""),
    ("markdown_fence", INPUT_TEXT, "```\nWe report 12 accuracy 345 on 6789 samples\n```"),
    ("bold_markdown", INPUT_TEXT, "We report **12** accuracy 345 on 6789 samples"),
    ("preamble", INPUT_TEXT, "Sure, here is the text: 12 accuracy 345 on 6789 samples"),
    ("too_short", INPUT_TEXT, "12 345"),
    ("too_long", "Short text.", "T" + "his is a padded rendition of it. " * 8),
    ("template_leak", INPUT_TEXT, "<|assistant|>We report 12 accuracy 345 on 6789"),
    ("digits_dropped", INPUT_TEXT, "We report accuracy on a number of samples here"),
]


@pytest.mark.parametrize(
    "inp,out", [(i, o) for _, i, o in REJECTIONS], ids=[n for n, _, _ in REJECTIONS]
)
def test_validate_rejects_and_returns_the_input(inp: str, out: str) -> None:
    assert llm._validate(inp, out, "body") == inp


def test_validate_accepts_a_faithful_rewrite() -> None:
    out = "We report 12 accuracy, 345 on 6789 samples."

    assert llm._validate(INPUT_TEXT, out, "body") == out


def test_equation_kind_is_exempt_from_the_digit_rule() -> None:
    inp = "\\sum_{i=1}^{10} x_i"
    out = "the sum from i equals one to ten of x sub i"

    assert llm._validate(inp, out, "equation") == out


def test_rejected_output_makes_refine_return_the_input() -> None:
    normalizer, _ = make_normalizer("```fenced garbage that is long enough```")

    assert normalizer.refine(INPUT_TEXT, "body") == INPUT_TEXT


# ── <think> stripping ────────────────────────────────────────────────────────
def test_clean_strips_think_block() -> None:
    assert llm._clean("<think>reasoning</think>Actual output") == "Actual output"


def test_clean_strips_surrounding_quotes() -> None:
    assert llm._clean('"Actual output"') == "Actual output"


def test_refine_strips_think_block_end_to_end() -> None:
    text = "The gradient descends along the steepest direction."
    normalizer, _ = make_normalizer(f"<think>hmm, plain prose</think>{text}")

    assert normalizer.refine(text, "body") == text


# ── Disk cache ───────────────────────────────────────────────────────────────
def test_cache_hit_skips_generation(isolated_cache: Path) -> None:
    normalizer, calls = make_normalizer("x sub i squared is at most n.")

    first = normalizer.refine("x_i^2 <= n", "equation")
    second = normalizer.refine("x_i^2 <= n", "equation")

    assert first == second == "x sub i squared is at most n."
    assert calls["generate"] == 1
    assert len(list(isolated_cache.glob("*.json"))) == 1


def test_seeded_cache_hit_never_loads_the_model(isolated_cache: Path) -> None:
    text = "x_i^2 <= n"
    key = llm._cache_key("fake/model", "equation", text)
    payload = {"in": text, "out": "cached script", "model": "fake/model", "ts": 0}
    (isolated_cache / f"{key}.json").write_text(json.dumps(payload), encoding="utf-8")
    normalizer, calls = make_normalizer("SHOULD NOT BE USED")

    assert normalizer.refine(text, "equation") == "cached script"
    assert calls == {"load": 0, "generate": 0}


def test_unwritable_cache_dir_degrades_to_no_cache(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(config, "LLM_CACHE_DIR", Path("/proc/nonexistent/nope"))
    normalizer, calls = make_normalizer("x sub i squared is at most n.")

    assert normalizer.refine("x_i^2 <= n", "equation") == "x sub i squared is at most n."
    assert calls["generate"] == 1


# ── Load failure -> permanent pass-through ───────────────────────────────────
def test_load_failure_is_permanent_and_loads_only_once() -> None:
    normalizer, calls = make_normalizer(load_error=RuntimeError("no weights"))
    inputs = ["first block of text", "second block of text", "third block of text"]

    results = [normalizer.refine(t, "body") for t in inputs]

    assert results == inputs
    assert calls["load"] == 1
    assert calls["generate"] == 0
    assert normalizer.available() is False


# ── Timeout -> pass-through, fast, and no queueing behind the stuck job ──────
def test_timeout_returns_input_unchanged_and_fast(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(config, "LLM_TIMEOUT_S", 0.05)
    normalizer, _ = make_normalizer("never delivered", delay=1.0)
    text = "a block the model will never finish"

    started = time.monotonic()
    result = normalizer.refine(text, "body")
    elapsed = time.monotonic() - started

    assert result == text
    assert elapsed < 0.5


def test_after_a_timeout_later_calls_do_not_queue_behind_the_stuck_job(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(config, "LLM_TIMEOUT_S", 0.05)
    normalizer, calls = make_normalizer("never delivered", delay=1.0)

    normalizer.refine("the first block that wedges the worker", "body")
    started = time.monotonic()
    second = normalizer.refine("a later block that must not wait", "body")
    elapsed = time.monotonic() - started

    assert second == "a later block that must not wait"
    assert elapsed < 0.05
    assert calls["generate"] == 1
    assert normalizer.available() is False


# ── Availability probe + prompts ─────────────────────────────────────────────
def test_is_llm_available_never_raises_and_returns_a_bool() -> None:
    assert isinstance(llm.is_llm_available(), bool)


def test_model_is_local_is_false_for_a_bogus_model() -> None:
    assert llm.model_is_local("nobody/definitely-not-a-real-model-xyz") is False


@pytest.mark.parametrize(
    "kind,marker",
    [("equation", "display equation"), ("heading", "section heading"), ("body", "")],
)
def test_system_prompt_varies_by_kind(kind: str, marker: str) -> None:
    prompt = llm._system_prompt(kind)

    assert "Output ONLY the spoken text" in prompt
    assert marker in prompt


def test_build_prompt_falls_back_when_no_chat_template() -> None:
    prompt = llm._build_prompt(FakeTokenizer(), "x_i^2", "equation")

    assert "x_i^2" in prompt
    assert "display equation" in prompt


# ── H7: a wedged generation must not hold up interpreter exit ────────────────

EXIT_DEADLINE_S = 10.0

WEDGE_AND_EXIT = """
import time
from kokoro_reader import config, llm

config.LLM_TIMEOUT_S = 0.05


def load_fn(model_id):
    return object(), type("T", (), {"chat_template": None})()


def generate_fn(model, tokenizer, prompt, max_tokens):
    time.sleep(3600)          # the wedge: a generation that never returns
    return "never delivered"


text = "a block the model will never finish"
norm = llm.MlxNormalizer(model_id="fake/model", generate_fn=generate_fn, load_fn=load_fn)
assert norm.refine(text, "body") == text
print("refined")
"""


def test_a_wedged_generation_does_not_stop_the_interpreter_from_exiting(
    tmp_path: Path,
) -> None:
    """`concurrent.futures` registers an atexit hook that joins every worker thread.

    With a `ThreadPoolExecutor` a wedged `mlx_lm` generation therefore kept the whole
    process alive after `refine()` had already returned — measured: still running after
    8 s with nothing left to do. The app could only be killed, never quit.
    """
    import subprocess
    import sys

    script = tmp_path / "wedge_and_exit.py"
    script.write_text(WEDGE_AND_EXIT, encoding="utf-8")
    env = {"PYTHONPATH": str(Path(__file__).resolve().parent.parent), "PATH": "/usr/bin:/bin"}

    try:
        done = subprocess.run(
            [sys.executable, str(script)],
            capture_output=True, text=True, timeout=EXIT_DEADLINE_S, env=env,
        )
    except subprocess.TimeoutExpired:
        raise AssertionError(
            f"the interpreter did not exit within {EXIT_DEADLINE_S}s with a wedged "
            f"generation thread alive"
        ) from None

    assert done.returncode == 0, done.stderr
    assert "refined" in done.stdout


def test_the_generation_worker_thread_is_a_daemon() -> None:
    normalizer, _ = make_normalizer("spoken output")

    normalizer.refine("a block that starts the worker", "body")

    assert normalizer._worker is not None
    assert normalizer._worker._thread.daemon is True


# ── H8: refine() must never trigger a model download ─────────────────────────

def test_refine_does_not_download_weights_that_are_not_already_local(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """`mlx_lm.load` fetches a 2.1 GB repo when the weights are absent."""
    attempts: list[str] = []

    def spy_load(model_id: str) -> tuple[Any, Any]:
        attempts.append(model_id)
        raise AssertionError("a download was started")

    monkeypatch.setattr(llm, "_default_load", spy_load)
    normalizer = llm.MlxNormalizer(model_id="nobody/definitely-not-a-real-model-xyz")
    text = "a block that must come back untouched"

    result = normalizer.refine(text, "body")

    assert result == text
    assert attempts == []
    assert normalizer.available() is False


def test_an_injected_loader_is_never_blocked_by_the_download_guard() -> None:
    """The guard is about the network, not about loading: fakes must still work."""
    normalizer, calls = make_normalizer("spoken output")

    assert normalizer.refine("x_i^2 <= n", "equation") == "spoken output"
    assert calls["load"] == 1


# ── M7: the refinement cache is capped ───────────────────────────────────────

def test_refinement_cache_is_capped_and_evicts_the_oldest(isolated_cache: Path) -> None:
    for i in range(12):
        path = isolated_cache / f"{i:040x}{llm.LLM_CACHE_SUFFIX}"
        path.write_text(json.dumps({"out": f"entry {i}"}), encoding="utf-8")
        import os
        os.utime(path, (1_700_000_000 + i, 1_700_000_000 + i))

    removed = llm.evict_cache(max_entries=5)

    survivors = sorted(p.name for p in isolated_cache.glob(f"*{llm.LLM_CACHE_SUFFIX}"))
    assert removed == 7
    assert len(survivors) == 5
    assert survivors == sorted(f"{i:040x}{llm.LLM_CACHE_SUFFIX}" for i in range(7, 12))


def test_writing_a_refinement_keeps_the_cache_under_the_cap(
    isolated_cache: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(llm, "LLM_CACHE_MAX_ENTRIES", 4)
    normalizer, _ = make_normalizer("a spoken rendering of the block")

    for i in range(20):
        normalizer.refine(f"block number {i} of the document", "body")

    assert len(list(isolated_cache.glob(f"*{llm.LLM_CACHE_SUFFIX}"))) <= 4


# ── Offline launch: cached weights are loaded without asking the Hub ─────────
LLM_REPO_ID = "mlx-community/Qwen3-4B-Instruct-2507-4bit"


def _fake_hub_and_mlx_lm(
    monkeypatch: pytest.MonkeyPatch, snapshot: Path, cached: bool
) -> tuple[list[bool], list[str]]:
    """Patch snapshot_download and stand in for `mlx_lm.load`, which downloads a non-path id."""
    import sys
    import types

    import huggingface_hub
    from huggingface_hub.errors import LocalEntryNotFoundError

    calls: list[bool] = []
    loaded: list[str] = []

    def fake_snapshot_download(repo_id: str, local_files_only: bool = False, **_: Any) -> str:
        calls.append(local_files_only)
        if local_files_only and not cached:
            raise LocalEntryNotFoundError("not cached")
        return str(snapshot)

    def fake_load(path_or_hf_repo: str) -> tuple[Any, Any]:
        path = path_or_hf_repo
        if not Path(path).exists():
            path = huggingface_hub.snapshot_download(path)
        loaded.append(path)
        return object(), object()

    monkeypatch.setattr(huggingface_hub, "snapshot_download", fake_snapshot_download)
    monkeypatch.setitem(sys.modules, "mlx_lm", types.SimpleNamespace(load=fake_load))
    return calls, loaded


def test_cached_llm_weights_load_without_an_online_call(monkeypatch, tmp_path) -> None:
    calls, loaded = _fake_hub_and_mlx_lm(monkeypatch, tmp_path, cached=True)

    llm._default_load(LLM_REPO_ID)

    assert calls == [True]
    assert loaded == [str(tmp_path)]


def test_uncached_llm_weights_are_downloaded_once(monkeypatch, tmp_path) -> None:
    calls, loaded = _fake_hub_and_mlx_lm(monkeypatch, tmp_path, cached=False)

    llm._default_load(LLM_REPO_ID)

    assert calls == [True, False]
    assert loaded == [str(tmp_path)]
