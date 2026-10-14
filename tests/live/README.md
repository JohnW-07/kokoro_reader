# Live checks

None of these run under `pytest`. Each needs a running server and real PDFs, and each
prints numbers a human should read. They exist because the claims they verify — "the
event loop is not blocked", "real papers read in the right order", "a wedge is
recoverable" — cannot be proved with fakes.

## Setup

```bash
venv/bin/python -m uvicorn app:app --host 127.0.0.1 --port 8000   # leave running

npm --prefix /tmp/pdfjs i pdfjs-dist@3.11.174                     # dev-only, once
export PDFJS_DIR=/tmp/pdfjs
export PAPERS_DIR=/path/to/papers            # a directory of real PDFs (required)
export KOKORO_FIXTURES=/tmp                  # where the sentence fixtures are written
```

Beware: `uvicorn` without `--reload` keeps the Python modules it started with. After
editing server code, restart it — otherwise you are testing the old code, and a "fix that
did not work" costs an hour. Check `lsof -nP -iTCP:8000 -sTCP:LISTEN` before believing a
result.

## The checks

| Script | What it proves | Runtime |
|---|---|---|
| `smoke_tts.py` | TTS latency, WAV validity, disk cache, and the R2 event-loop guarantee | ~10 s |
| `corpus_sweep.mjs` | every PDF in `PAPERS_DIR` end to end: reading order, no running head or bibliography reaching the voice, no failed batch | ~5 s |
| `corpus_integrity.mjs` | a batched build equals an unbatched one; every highlight index exists on its page; no duplicate sentence at a batch seam; bibliography pages are silent | ~20 s |
| `long_document.mjs` | a synthetic 400-page book batches correctly, keeps reading order across every seam, and survives a failed batch — the single-request path is rejected by the server, which is what used to fall back silently (H1) | ~15 s |
| `notes_roundtrip.py` | notes survive a round trip, concurrent writers of one document, a 4000-rect selection, and writes to a *different* document; export leaks no path (N1, N2, M8) | ~5 s |
| `audio_under_load.py` | 40 real sentences synthesise to non-silent audio at a plausible speech rate; the cache is byte-identical; speed is applied once; 60 abandoned requests leave every sync route answering (A1, A2, H3) | ~2 min |
| `player_against_server.mjs` | the real `playback.js` + `ttsclient.js` against the real server: 25 sentences in order, re-anchoring when the script shrinks under the cursor, watchdog recovery from a wedged media element, and no cascade on an unsynthesisable document (H2, H5) | ~40 s |
| `real_paper.mjs <file> <first> <last> <n>` | prints the skip tally, a sample of skipped blocks with reasons, and the first N spoken sentences — reading those aloud in your head is the test | ~5 s |

`player_against_server.mjs` and `audio_under_load.py` read sentence fixtures from
`$KOKORO_FIXTURES`. Generate them with `real_paper.mjs` or the snippet in
`player_against_server.mjs`'s header.

## What none of these cover

There is no browser here. Selection, the notes panel, drag-and-drop, scrolling and the
reading highlight are exercised only through the hand-written DOM fakes in `tests/js/`.
The only way to close that gap is to open the app.
