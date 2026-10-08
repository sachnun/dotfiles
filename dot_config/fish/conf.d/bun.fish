if string match -q '*PRoot*' -- (uname -r); or set -q PROOT_L2S_DIR; or set -q TERMUX_EXEC__PROC_SELF_EXE
    set -gx BUN_OPTIONS --backend=copyfile
end
