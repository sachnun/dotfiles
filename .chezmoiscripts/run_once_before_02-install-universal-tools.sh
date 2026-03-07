#!/bin/bash
set -euo pipefail

install_starship() {
  if command -v starship >/dev/null 2>&1; then
    return
  fi

  curl -sS https://starship.rs/install.sh | sh -s -- --yes
}

install_uv() {
  if command -v uv >/dev/null 2>&1; then
    return
  fi

  curl -LsSf https://astral.sh/uv/install.sh | sh
}

install_bun() {
  if command -v bun >/dev/null 2>&1; then
    return
  fi

  curl -fsSL https://bun.sh/install | bash
}

install_starship
install_uv
install_bun
