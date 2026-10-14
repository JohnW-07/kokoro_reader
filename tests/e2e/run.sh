#!/bin/bash
# Usage: tests/e2e/run.sh <repo-dir> <chromium|webkit> <test-name|all> <port> [log-dir]
# One server (scratch data dir, KOKORO_LLM=0) and one browser, tests run in sequence.
# Writes <log-dir>/e2e_<browser>_<test>.log and prints one line per test. Exit 1 if any test fails.
# Env overrides: PLAYWRIGHT_DIR, PLAYWRIGHT_BROWSERS_PATH, KOKORO_E2E_PDF, KOKORO_E2E_PDF2.
set -u
R=$(cd "$1" && pwd); B=$2; T=$3; PORT=$4; L=${5:-$(mktemp -d)}
MAIN=${KOKORO_MAIN_REPO:-$(git -C "$R" worktree list --porcelain | sed -n '1s/^worktree //p')}   # holds the venv a worktree borrows
mkdir -p "$L"
D=$(mktemp -d)
cd "$R"
[ -e venv ] || { ln -s "$MAIN/venv" venv; LINKED=1; }
KOKORO_DATA_DIR=$D KOKORO_LLM=0 venv/bin/python -m uvicorn app:app --host 127.0.0.1 --port "$PORT" \
  --log-level warning > "$L/e2e_server_$B.log" 2>&1 &
SP=$!
trap 'kill $SP 2>/dev/null; wait $SP 2>/dev/null; rm -rf "$D"; [ -n "${LINKED:-}" ] && rm venv' EXIT
curl -s -o /dev/null --retry 30 --retry-connrefused --retry-delay 1 "http://127.0.0.1:$PORT/" \
  || { echo "server failed, see $L/e2e_server_$B.log"; exit 2; }
export KOKORO_URL=http://127.0.0.1:$PORT/ BROWSER=$B
export PLAYWRIGHT_DIR=${PLAYWRIGHT_DIR:-$HOME/.npm/_npx/e41f203b7505f1fb/node_modules}
export KOKORO_E2E_PDF=${KOKORO_E2E_PDF:-$HOME/UMD/Stanford/papers/GR00TN1.pdf}
export KOKORO_E2E_PDF2=${KOKORO_E2E_PDF2:-$HOME/UMD/Stanford/papers/MaskViT.pdf}
export SHOT_DIR=$L/shots_$B
mkdir -p "$SHOT_DIR"
if [ "$T" = all ]; then TESTS=(tests/e2e/*.mjs); else TESTS=("tests/e2e/$T.mjs"); fi
fail=0
for t in "${TESTS[@]}"; do
  n=$(basename "$t" .mjs)
  caffeinate -di node "$t" > "$L/e2e_${B}_$n.log" 2>&1; rc=$?
  echo "$B $n rc=$rc last: $(tail -1 "$L/e2e_${B}_$n.log" | cut -c1-120)"
  [ $rc -ne 0 ] && fail=1
done
exit $fail
