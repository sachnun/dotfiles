function __git_auto_fetch --on-variable PWD
    set -l toplevel (command git rev-parse --show-toplevel 2>/dev/null)
    or return

    set -l fetch_head "$toplevel/.git/FETCH_HEAD"
    if test -f "$fetch_head"
        set -l last_fetch (command stat -c %Y "$fetch_head" 2>/dev/null)
        set -l now (command date +%s)
        if test -n "$last_fetch" -a (math "$now - $last_fetch") -lt 60
            return
        end
    end

    command git -C "$toplevel" fetch --quiet &>/dev/null &
    disown &>/dev/null
end
