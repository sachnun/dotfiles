#!/usr/bin/env bash
# GitHub Codespaces dotfiles installer (chezmoi).
# GitHub clones this repo and runs this script on codespace creation.
# Requires the CHEZMOI_PASSPHRASE secret to be set for non-interactive decryption.
set -euo pipefail

echo "==> Installing chezmoi..."
if ! command -v chezmoi >/dev/null 2>&1; then
  sh -c "$(curl -fsLS get.chezmoi.io/lb)"
  export PATH="$HOME/.local/bin:$PATH"
fi

echo "==> Applying dotfiles from chezmoi repo..."
chezmoi init --apply sachnun
echo "==> Dotfiles applied."