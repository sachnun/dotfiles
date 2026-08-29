set -U fish_greeting

fish_add_path /home/linuxbrew/.linuxbrew/bin
fish_add_path $HOME/.local/bin

umask 0022

mise activate fish | source

if status --is-login
    chezmoi update
    clear
end

function on_exit --on-event fish_exit
    chezmoi re-add
end

fastfetch
starship init fish | source
