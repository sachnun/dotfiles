# autopair.fish - Auto-closing pairs for Fish shell
# Pairs: () [] {} "" ''

function __autopair_insert_left -a left right
    commandline -i -- $left$right
    commandline -C (math (commandline -C) - (string length -- $right))
end

function __autopair_insert_right -a right
    set -l pos (commandline -C)
    if test (string sub -s (math $pos + 1) -l 1 -- (commandline -b) 2>/dev/null) = "$right"
        commandline -C (math $pos + 1)
    else
        commandline -i -- $right
    end
end

function __autopair_insert_quote -a q
    set -l pos (commandline -C)
    if test (string sub -s (math $pos + 1) -l 1 -- (commandline -b) 2>/dev/null) = "$q"
        commandline -C (math $pos + 1)
    else
        commandline -i -- "$q$q"
        commandline -C (math (commandline -C) - 1)
    end
end

function __autopair_backspace
    set -l pos (commandline -C)
    if test $pos -ge 1
        set -l buf (commandline -b)
        set -l l (string sub -s $pos -l 1 -- "$buf")
        set -l r (string sub -s (math $pos + 1) -l 1 -- "$buf" 2>/dev/null)
        switch "$l$r"
            case '()' '[]' '{}' '""' "''"
                commandline -f delete-char
                commandline -f backward-delete-char
                return
        end
    end
    commandline -f backward-delete-char
end

function __autopair_complete
    if commandline --paging-mode
        commandline -f downline
    else
        if string match -rq '\$.*"$' -- (commandline -t)
            commandline -f delete-char
        end
        commandline -f complete
    end
end

# --- Key bindings ---

set -l _m default
switch $fish_key_bindings
    case fish_vi_key_bindings fish_hybrid_key_bindings
        set _m insert
end

for pair in '(,)' '[,]' '{,}'
    set -l c (string split ',' -- $pair)
    set -l l (string escape -n -- $c[1])
    set -l r (string escape -n -- $c[2])
    bind -M $_m $c[1] "__autopair_insert_left $l $r"
    bind -M $_m $c[2] "__autopair_insert_right $r"
end

for q in '"' "'"
    set -l e (string escape -n -- $q)
    bind -M $_m $q "__autopair_insert_quote $e"
end

bind -M $_m \b __autopair_backspace
bind -M $_m \177 __autopair_backspace
bind -M $_m \t __autopair_complete
