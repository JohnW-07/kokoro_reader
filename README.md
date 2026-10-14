# Kokoro Reader

![Platform](https://img.shields.io/badge/platform-macOS%20%C2%B7%20Apple%20Silicon-lightgrey)
![Python](https://img.shields.io/badge/python-3.12-blue)
![Tests](https://img.shields.io/badge/tests-1163%20pytest%20%C2%B7%2040%20JS-brightgreen)
![License](https://img.shields.io/badge/license-MIT-green)

A local desktop app that reads PDFs aloud: structure-aware, math-aware and offline.
[Kokoro-82M](https://huggingface.co/mlx-community/Kokoro-82M-bf16) runs natively on Apple
Silicon via MLX, and nothing leaves the machine.

It is built for the documents that read badly in every other TTS tool: two-column, math-heavy,
full of running heads, footnotes, figures, tables and a bibliography you do not want narrated.

## Features

| | |
|---|---|
| **Skips the furniture** | Running heads and feet, page numbers, arXiv stamps, footnotes, figure labels, table bodies, code listings and the bibliography are classified and left unread. The sidebar lists what was skipped and why. |
| **Speaks the maths** | `‖x‖₂` → "the L2 norm of x", `Σ_{i=1}^n` → "the sum from i equals 1 to n of", `O(n log n)` → "big O of n log n". Flattened matrices are collapsed, not recited. |
| **Reading order** | Two-column papers read down each column instead of zig-zagging across the gutter. |
| **Follow** | One switch keeps the page scrolled to the sentence being read; turning it on snaps straight there. |
| **Contents tree** | Navigate by section, or start reading from any selected passage. |
| **Highlights and notes** | Four colours, notes in the margin beside their highlight, a searchable notes column and Markdown export. Stored per document. |
| **Voices** | Ten Kokoro voices, US and UK English (default `af_aoede`), plus an optional Siri natural voice. |
| **Summaries** | Spoken summary of a page or section on Apple's on-device model, or the optional local LLM. |
| **Listening stats** | Time listened, pages and documents finished, per voice and per day, with a reading-time ETA. |
| **Resilient playback** | Remembers where you stopped, supports the hardware media keys, and repairs a stalled audio pipeline without a restart. |
| **Optional local LLM** | A 4-bit Qwen3-4B can rewrite equations into spoken English. Off unless you enable it; the app is fully usable without it. |

It does not do EPUB, HTML or cloud voices. It reads one PDF in one window on one Mac.

## Requirements

| | |
|---|---|
| Hardware | Apple Silicon Mac (M1 or later). MLX has no CPU-only or CUDA path, so Intel Macs, Linux and Windows are not supported. |
| OS | macOS 13.5+ (MLX's minimum). Page summaries on Apple's model need macOS 26+ (FoundationModels). |
| Python | 3.12 |
| Disk | ~400 MB for Kokoro weights; +2.1 GB if you enable the LLM |
| Optional | Node (developed on v22) for the front-end tests; Playwright for the browser e2e tests |

## Quickstart

```bash
git clone https://github.com/JohnW-07/kokoro_reader.git
cd kokoro_reader
python3.12 -m venv venv
venv/bin/pip install -r requirements.txt
venv/bin/python -m spacy download en_core_web_sm   # optional: otherwise fetched on first use
venv/bin/python app.py
```

A window opens. Drop a PDF on it (or click to browse) and press `Space`.

On first launch the Kokoro weights (~330 MB) download into the Hugging Face cache. Notes,
highlights, stats and the audio cache live in `~/.kokoro_reader`.

### Keep the weights offline (optional)

The app prefers a project-local copy of the weights when one is present, so a cleared Hugging
Face cache cannot take the voice away. `weights/` is git-ignored.

```bash
venv/bin/hf download mlx-community/Kokoro-82M-bf16 --local-dir weights/kokoro/Kokoro-82M-bf16
```

### Siri voice (optional)

`Siri · Nora` in the voice menu uses macOS's own Siri natural voice through the system `swift`
interpreter (Xcode Command Line Tools). Download it first in **System Settings › Accessibility ›
Spoken Content › System voice › Manage Voices**. If the voice is missing, the app falls back to
Kokoro and says so.

## Keyboard

| Key | Action |
|---|---|
| `Space` | Play / pause |
| `←` `→` | Previous / next sentence |
| `F` or `S` | Toggle Follow |
| `B` | Toggle the sidebar |
| `N` | Toggle the notes column (or add a note to the active highlight) |
| `R` | Force-recover the audio pipeline |
| `F7` `F8` `F9` | Hardware media keys: previous / play-pause / next |

## Configuration

All tunables live in [`kokoro_reader/config.py`](kokoro_reader/config.py). Environment overrides:

| Variable | Default | Effect |
|---|---|---|
| `KOKORO_PORT` | `8000` | Port of the local server |
| `KOKORO_DATA_DIR` | `~/.kokoro_reader` | Notes, stats and caches |
| `KOKORO_TTS_MODEL` | local copy, else `mlx-community/Kokoro-82M-bf16` | Kokoro weights (Hub id or path) |
| `KOKORO_LLM` | `1` | `0` disables the LLM entirely |
| `KOKORO_LLM_MODEL` | `mlx-community/Qwen3-4B-Instruct-2507-4bit` | LLM used for equations and summaries |
| `KOKORO_LOG` | `INFO` | Log level |

## Tests

```bash
venv/bin/pip install -r requirements-dev.txt
venv/bin/python -m pytest -q   # 1163 tests
node tests/js/run.mjs          # 40 browser-module harnesses
```

The front-end modules take their collaborators as arguments and import nothing, so they run in
Node against small fakes, with no browser and no build step.

- `tests/e2e/` drives Chromium and WebKit through Playwright:
  `tests/e2e/run.sh . <chromium|webkit> all <port>`. It needs `KOKORO_E2E_PDF` and, if
  Playwright is installed elsewhere, `PLAYWRIGHT_DIR`.
- `tests/live/` holds checks that need a running server and real papers (`PAPERS_DIR`); see
  [`tests/live/README.md`](tests/live/README.md).

## Architecture

The UI is a pywebview window on a FastAPI server bound to localhost. Text is extracted in the
browser by pdf.js, classified and normalised in Python, and synthesised sentence by sentence
with a disk-backed audio cache.

```
app.py                  FastAPI + pywebview bootstrap
kokoro_reader/
  config.py             every tunable, with the measurement behind it
  tts_engine.py         Kokoro wrapper: thread pool, chunking, WAV encode, disk LRU cache
  apple_engine.py       Siri voice through apple_host.swift
  summary.py            page/section summaries (Apple on-device model or local LLM)
  llm.py                optional MLX normaliser; times out and degrades to pass-through
  notes_store.py        atomic per-document JSON
  stats_store.py        listening stats
  textpipe/             classify → normalize → mathspeak → pipeline
  routes/               tts, pdf, script, notes, summary, stats, health
static/
  index.html, stats.html
  js/                   ES modules: pdfview, playback, ttsclient, highlights, notes, toc, …
  pdf.min.js            pdf.js 3.11.174 (vendored)
tests/                  pytest, Node harnesses, Playwright e2e, live checks
```

## License

MIT; see [`LICENSE`](LICENSE). pdf.js is vendored under Apache 2.0. Kokoro-82M weights are
Apache 2.0.
