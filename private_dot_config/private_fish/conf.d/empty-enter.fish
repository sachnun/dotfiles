function empty-enter
    set -l cmd (commandline)
    if test -z "$cmd"
        if test "$__empty_enter_last_dir" != "$PWD" -o "$__empty_enter_state" = clear
            set -g __empty_enter_last_dir $PWD
            set -g __empty_enter_state info
            if git rev-parse --is-inside-work-tree &>/dev/null
                commandline -r "git status -sb"
            else
                commandline -r ll
            end
        else
            set -g __empty_enter_state clear
            commandline -r clear
        end
    end
    commandline -f execute
end

bind \r empty-enter
if functions -q fish_vi_key_bindings
    bind -M insert \r empty-enter
    bind -M default \r empty-enter
end
