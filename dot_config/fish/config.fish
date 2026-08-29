set -U fish_greeting

umask 0022

mise activate fish | source

function outdated
    if not set -qU outdated_day; or test "$outdated_day" != (date +%F)
        set -U outdated_day (date +%F)
        chezmoi update
        if not mise upgrade -n --dry-run-code >/dev/null 2>&1
            mise upgrade -n
        end
        clear
    end
end

if status is-interactive
    outdated
    fastfetch
    starship init fish | source
end
