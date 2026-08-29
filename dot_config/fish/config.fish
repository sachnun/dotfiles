function fish_greeting
    fastfetch
end

umask 0022

fish_add_path /home/linuxbrew/.linuxbrew/bin
fish_add_path $HOME/.local/bin

mise activate fish | source
starship init fish | source

function on_exit --on-event fish_exit
    chezmoi re-add
end

function fish_command_not_found
    __fish_default_command_not_found_handler $argv
end
