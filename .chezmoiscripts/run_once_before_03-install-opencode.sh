#!/bin/bash
set -euo pipefail

if ! command -v opencode &>/dev/null; then
  curl -fsSL https://opencode.ai/install | bash
fi
