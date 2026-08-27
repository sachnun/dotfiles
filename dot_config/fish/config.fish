set -U fish_greeting

umask 0022

# PATH
fish_add_path $HOME/.local/share/mise/shims
fish_add_path $HOME/.local/bin

if status is-interactive
    fastfetch
    starship init fish | source
end

# Environment variables


