set -U fish_greeting

umask 0022

if status is-interactive
    fastfetch
end

# PATH
fish_add_path $HOME/.config/herd-lite/bin
fish_add_path $HOME/.local/bin
fish_add_path $HOME/go/bin
fish_add_path $HOME/.opencode/bin
fish_add_path $HOME/.local/share/mise/shims

# Environment variables

starship init fish | source



# Pi
fish_add_path "/usr/bin"


# >>> grok installer >>>
fish_add_path $HOME/.grok/bin
# <<< grok installer <<<
