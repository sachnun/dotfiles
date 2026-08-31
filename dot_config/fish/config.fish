function fish_greeting
    fastfetch
end

umask 0022

fish_add_path /home/linuxbrew/.linuxbrew/bin
fish_add_path $HOME/.local/bin

if status is-interactive
  mise activate fish | source
else
  mise activate fish --shims | source
end

starship init fish | source
