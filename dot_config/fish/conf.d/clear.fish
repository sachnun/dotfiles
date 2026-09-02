function clear
    if test -z (commandline | string collect)
        command clear
        commandline -f repaint
    else
        commandline -f execute
    end
end

bind \r clear