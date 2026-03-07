#!/bin/bash
set -euo pipefail

log() {
  printf '[install-universal-tools] %s\n' "$1"
}

require_command() {
  if command -v "$1" >/dev/null 2>&1; then
    return
  fi

  log "Skipping $2: '$1' is unavailable."
  return 1
}

install_starship() {
  if command -v starship >/dev/null 2>&1; then
    log "starship already installed."
    return
  fi

  require_command curl starship || return
  log "Installing starship..."
  curl -sS https://starship.rs/install.sh | sh -s -- --yes
}

install_uv() {
  if command -v uv >/dev/null 2>&1; then
    log "uv already installed."
    return
  fi

  require_command curl uv || return
  log "Installing uv..."
  curl -LsSf https://astral.sh/uv/install.sh | sh
}

install_bun() {
  if command -v bun >/dev/null 2>&1; then
    log "bun already installed."
    return
  fi

  require_command curl bun || return
  require_command bash bun || return
  log "Installing bun..."
  curl -fsSL https://bun.sh/install | bash
}

install_starship
install_uv
install_bun
