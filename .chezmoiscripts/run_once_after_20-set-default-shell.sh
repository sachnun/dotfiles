#!/bin/bash
set -euo pipefail

if [ "${CODESPACES:-false}" = "true" ]; then
  echo "Skipping default shell change in GitHub Codespaces."
  exit 0
fi

if ! command -v fish >/dev/null 2>&1; then
  echo "Skipping default shell change: fish is unavailable."
  exit 0
fi

if ! command -v chsh >/dev/null 2>&1; then
  echo "Skipping default shell change: chsh is unavailable."
  exit 0
fi

if [ ! -t 0 ]; then
  echo "Skipping default shell change: no interactive TTY."
  exit 0
fi

fish_path="$(command -v fish)"
current_shell="${SHELL:-}"
if [ "$current_shell" != "$fish_path" ]; then
  chsh -s "$fish_path"
fi
