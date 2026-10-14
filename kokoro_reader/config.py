"""Central configuration. Every tunable in the app is named here, not inlined."""

from __future__ import annotations

import os
from dataclasses import dataclass, field
from pathlib import Path
from typing import Mapping

# ── Filesystem ────────────────────────────────────────────────────────────────
PROJECT_ROOT = Path(__file__).resolve().parent.parent
DATA_DIR = Path(os.environ.get("KOKORO_DATA_DIR", Path.home() / ".kokoro_reader"))
DOCS_DIR = DATA_DIR / "docs"
CACHE_DIR = DATA_DIR / "cache"
AUDIO_CACHE_DIR = CACHE_DIR / "audio"
LLM_CACHE_DIR = CACHE_DIR / "llm"

# ── TTS ───────────────────────────────────────────────────────────────────────
DEFAULT_VOICE = "af_aoede"
TTS_MODEL_ID = "mlx-community/Kokoro-82M-bf16"
# R6: the project's own copy (git-ignored) is safe from a cleared HuggingFace cache.
LOCAL_TTS_MODEL_DIR = PROJECT_ROOT / "weights" / "kokoro" / "Kokoro-82M-bf16"
#: What kokoro_mlx reads from a local model dir, plus the voice the app starts with.
LOCAL_TTS_MODEL_FILES = (
    "config.json", "kokoro-v1_0.safetensors", f"voices/{DEFAULT_VOICE}.safetensors",
)


def resolve_tts_model(env: Mapping[str, str], local_dir: Path = LOCAL_TTS_MODEL_DIR) -> str:
    """KOKORO_TTS_MODEL if set, else the local copy when complete, else the Hub id."""
    override = env.get("KOKORO_TTS_MODEL")
    if override:
        return override
    paths = [local_dir / name for name in LOCAL_TTS_MODEL_FILES]
    if all(p.is_file() and p.stat().st_size > 0 for p in paths):
        return str(local_dir)
    return TTS_MODEL_ID


def tts_cache_id(model: str) -> str:
    """The model's name in audio cache keys: the project copy is the Hub weights, so it keeps their key."""
    return TTS_MODEL_ID if model == str(LOCAL_TTS_MODEL_DIR) else model


TTS_MODEL = resolve_tts_model(os.environ)
SAMPLE_RATE = 24_000
MAX_CONCURRENT_SYNTH = 2
MAX_TTS_CHARS = 900          # Kokoro degrades on very long inputs; chunk above this
AUDIO_CACHE_MAX_BYTES = 512 * 1024 * 1024

# ── LLM script normalisation ─────────────────────────────────────────────────
LLM_MODEL = os.environ.get("KOKORO_LLM_MODEL", "mlx-community/Qwen3-4B-Instruct-2507-4bit")
LLM_ENABLED = os.environ.get("KOKORO_LLM", "1") != "0"
LLM_MAX_TOKENS = 400
LLM_TIMEOUT_S = 45.0
LLM_MAX_INPUT_CHARS = 1600

# ── Text pipeline ─────────────────────────────────────────────────────────────
# Running heads sit further in than you'd guess: a textbook with generous margins puts
# its head at ~13.5% of page height. The band is only a *candidate* filter — a line in it
# is skipped solely when its text also repeats across pages — so erring wide is safe.
HEADER_BAND = 0.16           # top fraction of the page treated as header zone
FOOTER_BAND = 0.16           # bottom fraction treated as footer zone
FOOTNOTE_BAND = 0.28         # bottom fraction where small text may be a footnote
# 0.86 was below every arXiv paper on this machine: iVideoGPT, VJEPA_2, PSI and PiZero all
# set footnotes at 9.0 against a 10.0 body (0.90), so the rule saw no candidate at all and
# caught zero footnotes across five papers. Widening the candidate pool is only safe
# because the marker test below is what actually decides — see `_starts_footnote`.
FOOTNOTE_SIZE_RATIO = 0.92   # font size <= body * this, inside the band -> footnote
# A footnote's marker is set as a superscript: 6.0 on a 9.0 line in iVideoGPT.pdf p5 and
# 6.0 on an 8.0 line in RLbook2020.pdf p70. A digit at the line's own size is a number in
# the text — an axis tick, a demo count — and must never start a footnote.
FOOTNOTE_MARKER_SIZE_RATIO = 0.85
HEADING_SIZE_RATIO = 1.12    # font size >= body * this -> heading candidate
# Text printed inside a figure is set well below body size: 3.7-7.5 against a 10.0 body
# across the figures on PiZero.pdf p1. 0.80 sits above every figure label measured and
# below every footnote (0.90) and abstract (0.90), which must not be swept up with them.
FIGURE_SIZE_RATIO = 0.80     # font size <= body * this, in a caption-anchored run -> figure
# The figure region is bounded by the prose around it, not by the run of lines the
# reader happens to have ordered next to the caption. `col_width` is the widest line on
# the page, so 0.25 of it is a quarter of the text measure: wide enough that no figure
# label measured reaches it, narrow enough that every wrapped body line clears it.
FIGURE_PROSE_WIDTH_RATIO = 0.25  # body-size and wider than this -> prose, not a figure
REPEAT_PAGE_FRACTION = 0.30  # a line repeating on >= this fraction of pages is furniture
REPEAT_Y_FRACTION = 0.50     # a short edge line at the same y on >= this fraction of pages
REPEAT_Y_TOLERANCE = 2       # baselines within this many units count as the same position
MAX_RUNNING_HEAD_CHARS = 70  # a running head is short; a body line at the same y is not
RUNNING_HEAD_GAP_RATIO = 1.5 # ...and is set off from the body by more whitespace than a line break
# Browser print chrome (N10): Safari and Chrome print a title/date header and a URL/page
# footer at 3% and 95% of the page. The size cap is the body, not below it: on a printed
# web form ("View Submitted Waiver") the 7 pt chrome outweighs the text and *is* the mode.
PRINT_CHROME_BAND = 0.06     # outer fraction of the page where print chrome sits
PRINT_CHROME_SIZE_RATIO = 1.0  # chrome is set no larger than body * this
# Small type in that outer band counts as furniture from two pages up, below the four a
# body-size line needs: a 2-3 page printout is otherwise too short for any repetition.
SMALL_EDGE_SIZE_RATIO = 0.75
MIN_SMALL_EDGE_REPEAT_PAGES = 2
MIN_SPEAKABLE_CHARS = 12
SENTENCE_MAX_CHARS = 400

# ── Server ────────────────────────────────────────────────────────────────────
HOST = "127.0.0.1"
PORT = int(os.environ.get("KOKORO_PORT", "8000"))

BLOCK_KINDS = (
    "body", "heading", "caption", "table", "figure", "equation",
    "header", "footer", "pagenum", "footnote", "reference", "code",
)

#: Kinds that are spoken by default. Overridable per-request via ReadOptions.
DEFAULT_SPEAK_KINDS = frozenset({"body", "heading", "caption", "equation"})

# ── Substitutions (T6) ────────────────────────────────────────────────────────
# Mirrored in static/js/subs.js; tests/js/subs.test.mjs fails if the two drift apart.
MAX_SUBSTITUTIONS = 100      # a glossary of terms, not a second document
MAX_SUB_FIND_CHARS = 80      # a term or short phrase as printed
MAX_SUB_REPLACE_CHARS = 200  # what to say instead, which may spell a term out


@dataclass(frozen=True)
class Substitution:
    """Say `replace` wherever the whole word `find` is printed (D3)."""

    find: str
    replace: str
    ignore_case: bool = False


@dataclass(frozen=True)
class ReadOptions:
    """What the reader should say out loud. Immutable; build a new one to change it."""

    read_captions: bool = True
    read_equations: bool = True
    read_headings: bool = True
    read_footnotes: bool = False
    read_tables: bool = False
    read_references: bool = False
    use_llm: bool = False
    substitutions: tuple[Substitution, ...] = ()

    def speak_kinds(self) -> frozenset[str]:
        kinds = {"body"}
        if self.read_headings:
            kinds.add("heading")
        if self.read_captions:
            kinds.add("caption")
        if self.read_equations:
            kinds.add("equation")
        if self.read_footnotes:
            kinds.add("footnote")
        if self.read_tables:
            kinds.add("table")
        if self.read_references:
            kinds.add("reference")
        return frozenset(kinds)


def ensure_dirs() -> None:
    for d in (DATA_DIR, DOCS_DIR, CACHE_DIR, AUDIO_CACHE_DIR, LLM_CACHE_DIR):
        d.mkdir(parents=True, exist_ok=True)
