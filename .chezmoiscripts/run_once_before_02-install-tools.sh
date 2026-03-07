#!/bin/bash
set -euo pipefail

if command -v curl >/dev/null 2>&1; then
  if ! command -v opencode >/dev/null 2>&1; then
    curl -fsSL https://opencode.ai/install | bash
  fi

  if ! command -v starship >/dev/null 2>&1; then
    curl -sS https://starship.rs/install.sh | sh -s -- --yes
  fi

  if ! command -v uv >/dev/null 2>&1; then
    curl -LsSf https://astral.sh/uv/install.sh | sh
  fi

  if ! command -v bun >/dev/null 2>&1 && command -v bash >/dev/null 2>&1; then
    curl -fsSL https://bun.sh/install | bash
  fi
fi
