set -U fish_greeting

fish_add_path /home/linuxbrew/.linuxbrew/bin
fish_add_path $HOME/.local/bin

umask 0022

mise activate fish | source

function outdated
    if not set -qU outdated_day; or test "$outdated_day" != (date +%F)
        set -U outdated_day (date +%F)
        chezmoi update
        mise bootstrap packages up --yes
        mise up --yes
        clear
    end
end

if status is-interactive
    outdated
    fastfetch
    starship init fish | source
end
