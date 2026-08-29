#!/usr/bin/env bash
set -euo pipefail

export PATH="$HOME/.local/share/mise/shims:$HOME/.local/bin:$PATH"

MISE_BIN="$(command -v mise || true)"
if [ -z "$MISE_BIN" ]; then
  echo "mise not found; skipping mise up" >&2
  exit 0
fi

cd "$HOME"
"$MISE_BIN" bootstrap packages up --yes
"$MISE_BIN" up --yes
