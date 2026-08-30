# Paths, temp dirs, output encoding

Verified on WSL2 with Windows interop enabled.

## Output encoding — read this first

Windows tools pipe output to WSL in unpredictable encodings:

- `powershell.exe` redirected to a pipe emits the **OEM codepage** (CP437/CP850 on en-US), not UTF-16. `iconv -f UTF-16LE` produces mojibake. Force UTF-8 inside the command: `[Console]::OutputEncoding=[Text.Encoding]::UTF8;`.
- `wsl.exe` emits **UTF-16LE**; convert with `wsl.exe ... | iconv -f UTF-16LE -t UTF-8`.
- `cmd.exe` pipes raw console bytes (set `chcp 65001` first for UTF-8).

Verified patterns:

```bash
powershell.exe -NoProfile -Command "[Console]::OutputEncoding=[Text.Encoding]::UTF8; Get-Service" | iconv -f UTF-8 -t UTF-8
powershell.exe -NoProfile -Command "Get-ChildItem C:\Users | Out-File -Encoding utf8 C:\tmp\out.txt" && cat /mnt/c/tmp/out.txt
wsl.exe -l -v | iconv -f UTF-16LE -t UTF-8
```

ASCII-only output (tasklist, ipconfig, sc.exe, reg.exe) passes through cleanly with no conversion.

## Paths and filesystem

```bash
wslpath -w /mnt/c/temp/file.txt     # Linux -> Windows: C:\temp\file.txt
wslpath -u 'C:\temp\file.txt'       # Windows -> Linux: /mnt/c/temp/file.txt
wslpath -w $(pwd)                   # current dir as Windows path
```

- Windows drives automount under `/mnt/<letter>` (lowercase).
- Scratch/output files for Windows tools belong in the user temp dir, not an invented `C:\tmp`: resolve it with `[Environment]::GetEnvironmentVariable('TEMP')` (PowerShell, e.g. `C:\Users\<user>\AppData\Local\Temp`), or mount it from Linux as `/mnt/c/Users/<user>/AppData/Local/Temp`.
- Files for Windows apps must live on the Windows filesystem (`/mnt/c/...`), not the ext4 home, or be passed via `wslpath -w`.
- UNC shares: from bash use `//server/share` (WSL2 maps it to `\\server\share`); Windows tools inside WSL get the UNC transparently.
- DrvFS: files under `/mnt/c` are owned by the WSL user regardless of Windows ACLs; `chmod` is mostly cosmetic unless `metadata` mount option is enabled. Admin-protected files require elevation inside Windows.
- Windows can reach the Linux side via `\\wsl.localhost\<distro>` (or `\\wsl$\<distro>`), much faster than going through `/mnt/c`.
- A Windows process launched from WSL inherits the bash cwd as a UNC path — tools like `cmd.exe` can't handle it and silently default to `C:\Windows`. Fix inside the command: `cd /d C:\temp & ...`.