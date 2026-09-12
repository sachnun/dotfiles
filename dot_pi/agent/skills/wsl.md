---
name: wsl
description: Interop across the Linux/Windows boundary in WSL2.
---

# WSL

Run ad-hoc Windows tasks from a WSL2 distro by shelling into the built-in PowerShell or cmd.

## Shells

- **Windows PowerShell 5.1**: `powershell.exe`, ships with every Windows, lives at `%windir%\System32\WindowsPowerShell\v1.0`, built on .NET Framework 4.x. First positional param is `-Command`.
- **cmd**: `cmd.exe`, the legacy shell for builtins (`dir`, `copy`, `net`, ...).

Check the version and distros:

```bash
powershell.exe -NoProfile -Command "\$PSVersionTable.PSVersion"
wsl.exe -l -v | iconv -f UTF-16LE -t UTF-8
```

## Invoke from WSL

```bash
powershell.exe -NoProfile -Command "Get-Date"
powershell.exe -NoProfile -File C:\path\x.ps1 -Arg val
powershell.exe -NoProfile -ExecutionPolicy Bypass -File C:\path\x.ps1
cmd.exe /c "ver"
```

- Exit codes propagate; the native code lands in `$LASTEXITCODE`.
- Dodge quoting entirely with a base64 UTF-16LE command: `powershell.exe -EncodedCommand <b64>`.
- Quoting: paths with backslashes go in single quotes; inside double quotes escape `"C:\\x"` and `$`, backticks, `!`.

### Output encoding

Piped Windows tools emit mixed encodings:

- `powershell.exe` -> OEM codepage (CP437/850), not UTF-16. Force UTF-8 inline: `[Console]::OutputEncoding=[Text.Encoding]::UTF8;`.
- `wsl.exe` -> UTF-16LE; pipe through `iconv -f UTF-16LE -t UTF-8`.
- `cmd.exe` -> raw console bytes; run `chcp 65001` first.
- ASCII-only output (`tasklist`, `ipconfig`, `sc`, `reg`) passes clean.

## PowerShell ad-hoc syntax

Cmdlets and language for Windows PowerShell 5.1:

```powershell
Get-Process | Where-Object CPU -gt 10 | Sort-Object CPU -Descending | Select-Object -First 5
Get-ChildItem C:\ -Filter *.log -Recurse -ErrorAction SilentlyContinue | Select FullName, Length
Get-CimInstance Win32_Process -Filter "Name='chrome.exe'" | Select ProcessId, CommandLine
Invoke-RestMethod https://api.example.com/x | ConvertTo-Json -Depth 6
Get-Content a.txt | ForEach-Object { $_.Trim() } | Set-Content b.txt
$out = & native.exe @args; $LASTEXITCODE
```

- Prefer CIM over WMI: `Get-CimInstance` / `Invoke-CimMethod` are the modern cmdlets; the v1 WMI cmdlets (`Get-WmiObject`) are legacy.
- Errors: `$ErrorActionPreference='Stop'` plus `try { } catch { }`.
- Discover: `Get-Command -Noun process`, `Get-Help Get-Process -Examples`, `Get-Member`.
- Format at the end of the pipe: `Format-Table`, `Format-List`, `Out-GridView`; serialise with `ConvertTo-Json` / `ConvertTo-Csv`.
- `$env:VAR` (PowerShell) and `%VAR%` (cmd) do not cross shells.

## UAC and elevation

An admin gets a filtered standard token by default; group membership is not enough, so test the live token (returns `False` in a filtered shell):

```powershell
([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
```

Elevate by relaunching:

```powershell
Start-Process powershell.exe -Verb RunAs -Wait -ArgumentList '-NoProfile','-ExecutionPolicy','Bypass','-Command','...'
```

- Prompt is on the secure desktop (consent for admins, credentials for standard users) and cannot be scripted or auto-accepted.
- `-Verb RunAs` cannot combine with `-NoNewWindow` or `-Credential`, and `Start-Process` does not return the elevated exit code. Write output to `%TEMP%` and read it back.
- Other account: `runas.exe /user:DOMAIN\user "cmd /c ..."` (`/netonly`, `/trustlevel:0x20000`).

`-Verb RunAs` prompts every time. To avoid repeats, use a run-on-demand scheduled task at highest privilege (Task Scheduler registers it without a prompt; only admins can; scope it to one operation):

```powershell
$action = New-ScheduledTaskAction -Execute powershell.exe -Argument '-NoProfile -File C:\x.ps1'
$principal = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" -LogonType Interactive -RunLevel Highest
Register-ScheduledTask -TaskName Elev -Action $action -Trigger (New-ScheduledTaskTrigger -AtLogOn) -Principal $principal -Force
Start-ScheduledTask -TaskName Elev
```

Disabling UAC (`EnableLUA=0`, needs admin and reboot) removes prompts but is strongly discouraged.

## cmd ad-hoc syntax

```
cmd [/c|/k] [/s] [/q] [/d] [/a|/u] [/t:{bf|f}] [/e:{on|off}] [/f:{on|off}] [/v:{on|off}] [string]
```

```bat
cmd /c "dir /b /a-d *.txt"
set NAME=world & echo Hello %NAME%
cmd /v:on /c "set x=hi & echo !x!"
cmd /c "app.exe > out.txt 2>&1"
cmd /c "netstat -ano | findstr LISTENING"
cmd /c "robocopy C:\src C:\dst /E /MIR"
```

`%VAR%` expands at parse time; enable `!VAR!` with `/v:on` when the value changes inside the same line or a block. Use `set NAME=value` for the current session or `setx NAME value` to persist.

- `/c` run then exit, `/k` run and keep open, `/q` no echo, `/d` skip AutoRun.
- Loops: `for %i in (*.log) do type "%i"`; double the `%` (`%%i`) inside a batch file.

## Common ad-hoc targets

```bash
tasklist.exe /v | rg -i chrome
taskkill.exe /IM chrome.exe /F
sc.exe query Spooler
reg.exe query "HKCU\Software\Microsoft\Windows\CurrentVersion\Run"
schtasks.exe /query /fo csv /nh
ipconfig.exe /all | rg -i "IPv4|Default Gateway"
netstat.exe -ano | rg -i listen
shutdown.exe /r /t 60 /c "reboot by WSL"
```

## WSL boundary gotchas

- Paths: `wslpath -w /mnt/c/x` -> `C:\x`, `wslpath -u 'C:\x'` -> `/mnt/c/x`. Windows drives at `/mnt/<letter>`; files for Windows apps must live on `/mnt/c/...`, not the ext4 home. Scratch files go in `[Environment]::GetEnvironmentVariable('TEMP')`, not an invented `C:\tmp`.
- CWD from a WSL launch is a UNC path; `cmd.exe` silently falls back to `C:\Windows`. Fix with `cmd /d /c "cd /d C:\folder & ..."`.

## Sources

- https://learn.microsoft.com/powershell/module/microsoft.powershell.core/about/about_powershell_exe
- https://learn.microsoft.com/windows-server/administration/windows-commands/windows-commands
- https://learn.microsoft.com/windows/security/application-security/application-control/user-account-control/how-it-works
- https://learn.microsoft.com/powershell/module/microsoft.powershell.management/start-process
