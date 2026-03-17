#!/bin/bash
set -euo pipefail

if ! command -v curl >/dev/null 2>&1; then
  echo "Skipping tool installation: curl is unavailable."
  exit 0
fi

install_with_bash() {
  local tool_name="$1"
  local install_url="$2"

  if command -v "$tool_name" >/dev/null 2>&1; then
    return 0
  fi

  yes | bash <(curl -fsSL "$install_url")
}

install_with_sh() {
  local tool_name="$1"
  local install_url="$2"
  shift 2

  if command -v "$tool_name" >/dev/null 2>&1; then
    return 0
  fi

  curl -fsSL "$install_url" | sh -s -- "$@"
}

install_with_bash opencode https://opencode.ai/install
install_with_sh starship https://starship.rs/install.sh --yes
install_with_sh uv https://astral.sh/uv/install.sh
install_with_bash bun https://bun.sh/install
install_with_bash hf https://hf.co/cli/install.sh
install_with_bash vp https://vite.plus
