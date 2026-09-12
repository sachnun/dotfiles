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

## WSL boundary gotchas

- Paths: `wslpath -w /mnt/c/x` -> `C:\x`, `wslpath -u 'C:\x'` -> `/mnt/c/x`. Windows drives at `/mnt/<letter>`; files for Windows apps must live on `/mnt/c/...`, not the ext4 home. Scratch files go in `[Environment]::GetEnvironmentVariable('TEMP')`, not an invented `C:\tmp`.
- CWD from a WSL launch is a UNC path; `cmd.exe` silently falls back to `C:\Windows`. Fix with `cmd /d /c "cd /d C:\folder & ..."`.

## Sources

- https://learn.microsoft.com/powershell/module/microsoft.powershell.core/about/about_powershell_exe
- https://learn.microsoft.com/windows/security/application-security/application-control/user-account-control/how-it-works
- https://learn.microsoft.com/powershell/module/microsoft.powershell.management/start-process
- https://learn.microsoft.com/windows/wsl/basic-commands
