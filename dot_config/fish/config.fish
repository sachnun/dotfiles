set -U fish_greeting

umask 0022

mise activate fish | source

if status is-interactive
    outdated
    fastfetch
    starship init fish | source
end
