set -U fish_greeting

umask 0022

if status is-interactive
    fastfetch
end

# PATH
fish_add_path $HOME/.opencode/bin
fish_add_path $HOME/.config/herd-lite/bin
fish_add_path $HOME/.local/bin
fish_add_path $HOME/go/bin

# Environment variables

# OpenCode experimental features
set -gx OPENCODE_EXPERIMENTAL_DISABLE_COPY_ON_SELECT true
set -gx OPENCODE_EXPERIMENTAL_PARALLEL true
set -gx OPENCODE_EXPERIMENTAL_SCOUT true
set -gx OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS true
set -gx OPENCODE_EXPERIMENTAL_WORKSPACES true

starship init fish | source



# Pi
fish_add_path "/usr/bin"

# >>> grok installer >>>
fish_add_path $HOME/.grok/bin
# <<< grok installer <<<
