set -U fish_greeting

if status is-interactive
    # Commands to run in interactive sessions can go here
end

# PATH
fish_add_path $HOME/.config/herd-lite/bin
fish_add_path $HOME/.bun/bin
fish_add_path $HOME/.opencode/bin

# Environment variables
set -gx BUN_INSTALL $HOME/.bun
set -gx PHP_INI_SCAN_DIR "$HOME/.config/herd-lite/bin:$PHP_INI_SCAN_DIR"

# OpenCode experimental features
set -gx OPENCODE_EXPERIMENTAL_DISABLE_COPY_ON_SELECT true
set -gx OPENCODE_EXPERIMENTAL_EXA true
set -gx OPENCODE_EXPERIMENTAL_MARKDOWN true
set -gx PENCODE_EXPERIMENTAL_PLAN_MODE true

if command -q starship
    starship init fish | source
end

if command -q zoxide
    zoxide init fish | source
end
