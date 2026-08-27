function clear
    if test -z (commandline)
        command clear
        commandline -f repaint
    else
        commandline -f execute
    end
end

bind \r clear