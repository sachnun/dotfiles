#!/bin/bash
set -euo pipefail

command -v curl >/dev/null 2>&1 || { echo "Skipping: curl unavailable."; exit 0; }

has() { command -v "$1" >/dev/null 2>&1; }

has opencode || curl -fsSL https://opencode.ai/install | bash
has starship || curl -fsSL https://starship.rs/install.sh | sh -s -- --yes
has uv       || curl -fsSL https://astral.sh/uv/install.sh | sh
has bun      || curl -fsSL https://bun.sh/install | bash
