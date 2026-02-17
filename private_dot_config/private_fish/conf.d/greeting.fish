function fish_greeting
    set -l seen_file ~/.cache/opencode_seen_version

    set -l output (gh api repos/anomalyco/opencode/releases/latest --jq '
      (now - (.published_at | fromdateiso8601)) as $diff |
      (if $diff < 60 then "\($diff | floor) seconds ago"
       elif $diff < 3600 then "\($diff / 60 | floor) minutes ago"
       elif $diff < 86400 then "\($diff / 3600 | floor) hours ago"
       else "\($diff / 86400 | floor) days ago" end) as $ago |
      "OpenCode " + .tag_name + " (" + $ago + ")\n---\n" + .body' 2>/dev/null)
    test -z "$output"; and return

    set -l tag $output[1]

    set_color cyan
    cowsay $tag

    if test -f $seen_file
        set -l seen (cat $seen_file)
        test "$seen" = "$tag"; and set_color normal; and return
    end

    mkdir -p (dirname $seen_file)
    echo $tag > $seen_file

    echo
    printf '%s\n' $output[3..] | string match -rv '^\s*$' | sed '/^## Desktop/,$d' | string replace -ra '^##.*' ''
    set_color normal
end
