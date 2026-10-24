function fish_greeting
    fastfetch
end

umask 0022

fish_add_path $HOME/.local/bin
set -gx BUN_INSTALL $HOME/.bun
fish_add_path $HOME/.bun/bin

source $__fish_config_dir/env.fish

set -gx COLORTERM truecolor

if status is-interactive
    mise activate fish | source
else
    mise activate fish --shims | source
end

starship init fish | source
