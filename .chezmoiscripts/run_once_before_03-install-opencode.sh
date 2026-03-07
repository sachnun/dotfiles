#!/bin/bash
set -euo pipefail

log() {
  printf '[install-opencode] %s\n' "$1"
}

if ! command -v curl >/dev/null 2>&1; then
  log "Skipping opencode install: 'curl' is unavailable."
  exit 0
fi

if ! command -v opencode &>/dev/null; then
  log "Installing opencode..."
  curl -fsSL https://opencode.ai/install | bash
else
  log "opencode already installed."
fi
