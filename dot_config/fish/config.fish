set -U fish_greeting

umask 0022

if status is-interactive
    fastfetch
end

# PATH
fish_add_path $HOME/.local/bin
fish_add_path $HOME/.local/share/mise/shims

# Environment variables

starship init fish | source
