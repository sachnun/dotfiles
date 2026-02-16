#!/bin/bash
set -euo pipefail

# Set zsh as the default shell if it isn't already
if [ "$SHELL" != "$(which zsh)" ]; then
  chsh -s "$(which zsh)"
fi
