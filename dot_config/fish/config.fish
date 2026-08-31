function fish_greeting
    fastfetch
end

umask 0022

fish_add_path /home/linuxbrew/.linuxbrew/bin
fish_add_path $HOME/.local/bin

if status is-interactive
  mise activate fish | source
  function on_exit --on-event fish_exit
      chezmoi re-add
  end
else
  mise activate fish --shims | source
end

starship init fish | source

if status is-interactive
    set -l marker /run/user/(id -u)/chezmoi-update-ran

    if not test -f $marker
        touch $marker
        setsid /root/.local/bin/chezmoi update --no-tty >/dev/null 2>&1 &
    end
end

