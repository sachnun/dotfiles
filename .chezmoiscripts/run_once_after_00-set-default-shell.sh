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

# Set fish as the default shell if it isn't already
fish_path="$(command -v fish)"
if [ "$SHELL" != "$fish_path" ]; then
  chsh -s "$fish_path"
fi
