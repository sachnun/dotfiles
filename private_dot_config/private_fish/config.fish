set -U fish_greeting

if status is-interactive
    # Commands to run in interactive sessions can go here
end

# PATH
fish_add_path $HOME/.bun/bin
fish_add_path /root/.opencode/bin
fish_add_path /root/.config/herd-lite/bin

# Environment variables
set -gx BUN_INSTALL $HOME/.bun

# OpenCode experimental features
set -gx OPENCODE_EXPERIMENTAL_DISABLE_COPY_ON_SELECT true
set -gx OPENCODE_EXPERIMENTAL_PARALLEL true
set -gx OPENCODE_EXPERIMENTAL_SCOUT true
set -gx OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS true

starship init fish | source

# >>> grok installer >>>
fish_add_path $HOME/.grok/bin
# <<< grok installer <<<


# Pi
fish_add_path "/usr/bin"
