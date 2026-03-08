set -U fish_greeting

if status is-interactive
    # Commands to run in interactive sessions can go here
end

# PATH
fish_add_path $HOME/.bun/bin
fish_add_path /root/.opencode/bin

# Environment variables
set -gx BUN_INSTALL $HOME/.bun

# OpenCode experimental features
set -gx OPENCODE_EXPERIMENTAL_DISABLE_COPY_ON_SELECT true
set -gx OPENCODE_EXPERIMENTAL_EXA true
set -gx OPENCODE_EXPERIMENTAL_MARKDOWN true
set -gx OPENCODE_EXPERIMENTAL_PLAN_MODE true

starship init fish | source
zoxide init fish | source
