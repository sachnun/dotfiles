function fish_greeting
    chezmoi update
end

fish_add_path /home/linuxbrew/.linuxbrew/bin
fish_add_path $HOME/.local/bin

umask 0022

mise activate fish | source

function on_exit --on-event fish_exit
    chezmoi re-add
end

fastfetch
starship init fish | source
