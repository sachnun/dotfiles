set -U fish_greeting

umask 0022

mise activate fish | source

if status is-interactive
    fastfetch
    starship init fish | source
    outdated
end
