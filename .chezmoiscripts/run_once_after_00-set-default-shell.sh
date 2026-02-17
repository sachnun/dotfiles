#!/bin/bash
set -euo pipefail

# Set fish as the default shell if it isn't already
if [ "$SHELL" != "$(which fish)" ]; then
  chsh -s "$(which fish)"
fi
