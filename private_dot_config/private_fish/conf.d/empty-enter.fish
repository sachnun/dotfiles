function empty-enter
    set -l cmd (commandline)
    if test -z "$cmd"
        commandline -r clear
    end
    commandline -f execute
end

bind \r empty-enter
if functions -q fish_vi_key_bindings
    bind -M insert \r empty-enter
    bind -M default \r empty-enter
end
