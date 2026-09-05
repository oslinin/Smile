#!/usr/bin/env bash
# Start the Python vol-surface renderer on :8000.
# Uses uv to manage the environment — `uv run` auto-creates .venv and installs
# the deps declared in pyproject.toml (pinned by uv.lock) on first run.
set -euo pipefail

cd "$(dirname "$0")"
PORT="${PORT:-8000}"

if ! command -v uv >/dev/null 2>&1; then
  echo "uv not found. Install it first:" >&2
  echo "  curl -LsSf https://astral.sh/uv/install.sh | sh" >&2
  echo "  (docs: https://docs.astral.sh/uv/)" >&2
  exit 1
fi

echo "Vol-surface renderer → http://localhost:$PORT"
exec env PORT="$PORT" uv run server.py
