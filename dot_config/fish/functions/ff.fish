# ff: fastfetch wrapper, hide logo on narrow screens
function ff
    if test "$COLUMNS" -ge 80
        fastfetch $argv
    else
        fastfetch --logo none $argv
    end
end