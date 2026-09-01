---
name: wsl
description: "This agent runs inside WSL2 (Linux under Windows) — use for any task that touches the Windows host from this session."
---

# WSL

Everything verified on WSL2 (kernel `6.6.87.2-microsoft-standard-WSL2`, Arch) with Windows interop enabled. Check interop first:

```bash
uname -a
which powershell.exe cmd.exe tasklist.exe   # must resolve; they live in /mnt/c/WINDOWS/system32
wsl.exe -l -v | iconv -f UTF-16LE -t UTF-8 # list distros (wsl.exe pipes UTF-16LE)
```

### Encoding traps
- `powershell.exe` piped → emits **OEM codepage** (CP437), NOT UTF-16. Force UTF-8: `[Console]::OutputEncoding=[Text.Encoding]::UTF8;`
- `wsl.exe` piped → emits **UTF-16LE**: pipe through `iconv -f UTF-16LE -t UTF-8`
- `cmd.exe` piped → raw console bytes; set `chcp 65001` first for UTF-8
- ASCII-only output (tasklist, ipconfig, sc.exe, reg.exe) passes clean, no conversion needed

### Path conversion & filesystem
- `wslpath -w /mnt/c/file.txt` → `C:\file.txt` (Linux→Windows)
- `wslpath -u 'C:\file.txt'` → `/mnt/c/file.txt` (Windows→Linux)
- Drives automount under `/mnt/<letter>` (lowercase)
- Files for Windows apps **must** live on `/mnt/c/...` (not ext4 home)
- User temp dir: `[Environment]::GetEnvironmentVariable('TEMP')` → e.g. `C:\Users\<user>\AppData\Local\Temp`; resident ad-hoc scripts/logs live there (see cheat sheet)
- Windows→WSL path: `\\wsl.localhost\<distro>` (faster than /mnt/c)
- DrvFS: `/mnt/c` files owned by WSL user regardless of Windows ACLs; `chmod` cosmetic unless `metadata` mount option enabled
- UNC from bash: `//server/share`; Windows tools get UNC transparently
- CWD from WSL launches as UNC → `cmd.exe` silently falls back to `C:\Windows`; fix: `cd /d C:\temp & ...`

### Running Windows executables
```bash
powershell.exe -NoProfile -Command "Get-Service"
cmd.exe /c "echo %PROCESSOR_ARCHITECTURE%"
tasklist.exe | head -5
```
- Exit codes propagate: check with `$?`
- Quoting: backslash paths → single quotes; inside double quotes escape `"C:\\temp\\x"`; escape `$`, backticks, `!` for bash
- `.ps1`: `powershell.exe -NoProfile -ExecutionPolicy Bypass -File "$TMPWIN\x.ps1" -Arg val`; ad-hoc scripts always go in Windows user TEMP, never a hardcoded `C:\temp`:
  `TMPWIN=$(powershell.exe -NoProfile -Command "[Environment]::GetEnvironmentVariable('TEMP')" | tr -d '\r\n'); TMPL=$(wslpath -u "$TMPWIN")`; write scripts/logs under `$TMPL/...`, `rm -f` when done
- Prefer native Linux tools when possible; `/mnt/c` I/O is slower

### Processes & services
```bash
tasklist.exe | rg -i chrome
taskkill.exe /IM chrome.exe /F
powershell.exe -NoProfile -Command "Get-Process chrome | Select-Object Id,MainWindowTitle | Format-List"
powershell.exe -NoProfile -Command "Get-CimInstance Win32_Process -Filter \"Name='chrome.exe'\" | Select ProcessId,CommandLine"
sc.exe query Spooler
sc.exe queryex type= service state= all | rg "SERVICE_NAME|STATE"
```
Kill by command-line match:
```bash
powershell.exe -NoProfile -Command "Get-CimInstance Win32_Process -Filter \"Name='chrome.exe'\" | Where {\$_.CommandLine -like '*profile*'} | ForEach { Stop-Process -Id \$_.ProcessId -Force }"
```

### Registry
```bash
reg.exe query "HKLM\SOFTWARE\Microsoft\Windows NT\CurrentVersion" /v CurrentVersion
reg.exe add "HKCU\Software\pi" /v enabled /t REG_DWORD /d 1 /f
reg.exe delete "HKCU\Software\pi" /v enabled /f
```
Roots: `HKLM`, `HKCU`, `HKCR`, `HKU`. HKLM writes need elevation.

### Elevation (UAC)
WSL itself is non-elevated; disk operations, HKLM writes and `wsl.exe --mount` need an elevated Windows process (error `WSL_E_ELEVATION_NEEDED_TO_MOUNT_DISK` otherwise). Elevation needs an interactive desktop: `tasklist.exe | rg -i explorer` must show `explorer.exe` on a Console session. Check elevation: `([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)` → `False` from WSL.

```bash
TMPWIN=$(powershell.exe -NoProfile -Command "[Environment]::GetEnvironmentVariable('TEMP')" | tr -d '\r\n')
TMPL=$(wslpath -u "$TMPWIN")
cat > "$TMPL/uac.ps1" <<'PS'
[Console]::OutputEncoding=[Text.Encoding]::UTF8
$log = "$env:TEMP\uac-log.txt"
Add-Content $log "=== $(Get-Date) ==="
Add-Content $log ("admin: " + ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator))
# ... elevated work ... write results to $log
PS
powershell.exe -NoProfile -Command "Start-Process powershell.exe -Verb RunAs -Wait -ArgumentList '-NoProfile','-ExecutionPolicy','Bypass','-File',\"$TMPWIN\\uac.ps1\""
cat "$TMPL/uac-log.txt" 2>/dev/null
rm -f "$TMPL/uac.ps1" "$TMPL/uac-log.txt"
```

Gotchas:
- UAC prompt appears on the interactive desktop; user clicks Yes. `-Wait` blocks until the elevated process exits. `Start-Process` returns 0 even if the script failed → always verify via the log file the elevated script wrote (read back over `/mnt/c`).
- The elevated process inherits the caller's environment, so `%TEMP%` is unchanged; if the elevated token maps to another account, pass the temp dir as an explicit argument.
- The script must live on drvfs (`/mnt/c` = `$TMPL`) so the elevated process can read it; clean up with `rm -f` after.
- Compare GPT partition types via `$_.GptType.ToString().Trim('{}')` — `ToString()` includes the `{...}` braces; `Get-Partition` Type shows "Basic"/"System"/"Unknown", so trust `GptType`, not `Type`.
- Common elevated ops: `Get-PartitionSupportedSize` + `Resize-Partition` (extend C: into contiguous unallocated space), diskpart `delete partition override`, `wsl.exe --mount`.

### GUI apps & SendKeys
```bash
calc.exe &    # must be logged-in interactive desktop; fails from SSH/headless
powershell.exe -NoProfile -Command "\$ws = New-Object -ComObject WScript.Shell; \$ws.AppActivate('calc'); Start-Sleep 400; \$ws.SendKeys('{NUM1}{ADD}{NUM2}{ENTER}')"
```
SendKeys escape: `{}`, `()`, `+`, `^`, `%`, `~`; named keys `{ENTER}` `{END}` `{TAB}` `{ESC}` `{F5}`

### Networking
- **NAT mode** (default): WSL eth0 172.x; Windows host is `ip route` gateway; Windows services reached via gateway IP; needs firewall allow rule (elevation)
- **Mirrored mode** (`networkingMode=mirrored` in `.wslconfig`): localhost works both ways; no proxy needed
- Diagnose: `ip -4 addr`, `ip route`, `rg nameserver /etc/resolv.conf`; Windows: `powershell.exe -NoProfile -Command "Get-NetIPAddress -AddressFamily IPv4"`


### Office COM (Word example)
```powershell
Stop-Process -Name WINWORD -Force   # kill prior instance first
$word = New-Object -ComObject Word.Application; $word.Visible = $true; $word.WindowState = 2
$doc = $word.Documents.Add(); $sel = $word.Selection
$sel.Style = $doc.Styles.Item('Heading 1'); $sel.TypeText('Hello')
$doc.SaveAs2("$tmp\out.docx", 16); $doc.ExportAsFixedFormat("$tmp\out.pdf", 17)
```
- Colors are BGR: `$r + $g*256 + $b*65536`
- `$null = $sel.EndKey(6)` to exit math zones or suppress Long returns
- `Stop-Process -Name WINWORD -Force` before `Documents.Add()` or it appends to running instance

## Cheat sheet (most common ops)

```bash
TMPWIN=$(powershell.exe -NoProfile -Command "[Environment]::GetEnvironmentVariable('TEMP')" | tr -d '\r\n')
TMPL=$(wslpath -u "$TMPWIN")                  # ad-hoc scripts/logs -> %TEMP% (never C:\temp)
wslpath -w "$TMPL/x.ps1"                      # Linux -> Windows path
calc.exe &    # open any GUI app (or: explorer.exe /mnt/c)
printf 'hi' > "$TMPL/x.txt"                   # files for Windows tools go in %TEMP%

# single-shot Windows command (UTF-8 output)
powershell.exe -NoProfile -Command "[Console]::OutputEncoding=[Text.Encoding]::UTF8; Get-Service" | iconv -f UTF-8 -t UTF-8

# run an ad-hoc .ps1 elevated (UAC prompt on desktop; verify via log file)
powershell.exe -NoProfile -Command "Start-Process powershell.exe -Verb RunAs -Wait -ArgumentList '-NoProfile','-ExecutionPolicy','Bypass','-File',\"$TMPWIN\\uac.ps1\""

# minimize an Office app already running
powershell.exe -NoProfile -Command "\$w = [Runtime.InteropServices.Marshal]::GetActiveObject('Word.Application'); \$w.WindowState = 2"
```
