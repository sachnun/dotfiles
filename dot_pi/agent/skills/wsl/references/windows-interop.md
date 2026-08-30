# Windows processes, services, registry, GUI, admin

## Running Windows executables

```bash
powershell.exe -NoProfile -Command "Get-Service"                      # run PS one-liner
cmd.exe /c "echo %PROCESSOR_ARCHITECTURE%"                            # run cmd builtin
tasklist.exe | head -5                                                # any Windows exe
C:/Windows/System32/SystemPropertiesAdvanced.exe                      # GUI exe
```

- Exit codes propagate: `powershell.exe -NoProfile -Command "exit 7"; echo $?` prints 7.
- Quoting: path with backslashes → single quotes. Inside double quotes, escape: `"C:\\temp\\x"`. Escape `$`, backticks, `!` that bash would expand.
- Bash on Windows PATH: `/mnt/c/WINDOWS/system32`, `System32\WindowsPowerShell\v1.0` are appended to PATH automatically; `%PATH%`-style references resolve.
- `.bat`/`.cmd`: `cmd.exe /c C:\path\script.bat`. Send args as one quoted string.
- `.ps1`: `powershell.exe -NoProfile -ExecutionPolicy Bypass -File C:\path\x.ps1 -Arg val`.
- Prefer `powershell.exe` for logic, `cmd.exe` for quick tools (dir, copy, net use), and consider whether a native Linux tool exists first (I/O through `/mnt/c` is slower than native).

## Processes and services

```bash
tasklist.exe | rg -i chrome                                # list processes
taskkill.exe /IM notepad.exe /F                             # kill by image name
powershell.exe -NoProfile -Command "Get-Process chrome | Select-Object Id,MainWindowTitle | Format-List"
powershell.exe -NoProfile -Command "Get-CimInstance Win32_Process -Filter \"Name='chrome.exe'\" | Select-Object ProcessId,CommandLine"
sc.exe query Spooler                                        # service state
sc.exe queryex type= service state= all | rg "SERVICE_NAME|STATE"
```

Kill by command-line match (safe when several instances run):

```bash
powershell.exe -NoProfile -Command "Get-CimInstance Win32_Process -Filter \"Name='chrome.exe'\" | Where-Object {\$_.CommandLine -like '*profile-name*'} | ForEach-Object { Stop-Process -Id \$_.ProcessId -Force }"
```

## Registry

```bash
reg.exe query "HKLM\SOFTWARE\Microsoft\Windows NT\CurrentVersion" /v CurrentVersion
reg.exe query "HKCU\Control Panel\Desktop" /v Wallpaper
reg.exe add "HKCU\Software\pi" /v enabled /t REG_DWORD /d 1 /f
reg.exe delete "HKCU\Software\pi" /v enabled /f
```

Roots: `HKLM`, `HKCU`, `HKCR`, `HKU`. Registry writes under `HKLM` need elevation.

## GUI apps

```bash
notepad.exe "$(wslpath -w /mnt/c/temp/note.txt)" &
"/mnt/c/Program Files/Google/Chrome/Application/chrome.exe" "https://example.com" &
"/mnt/c/Program Files/Microsoft/Edge/Application/msedge.exe" "https://example.com" &
```

- GUI apps appear on the interactive Windows desktop. From an SSH/headless session they fail — need a logged-in interactive session.
- A leading `*` in a Notepad window title means unsaved changes (`Get-Process notepad | Select MainWindowTitle`).
- Type into the focused window with inline SendKeys:

```bash
powershell.exe -NoProfile -Command "\$ws = New-Object -ComObject WScript.Shell; \$ws.AppActivate('notepad'); Start-Sleep -Milliseconds 400; \$ws.SendKeys('{END}{ENTER}typed from WSL!')"
```

SendKeys escaping: brace special chars `{}`, `()`, `+`, `^`, `%`, `~`; named keys pass literally (`{ENTER}`, `{END}`, `{TAB}`, `{ESC}`, `{F5}`).

## Clipboard and misc PowerShell helpers

```bash
powershell.exe -NoProfile -Command "Set-Clipboard 'text dari WSL'; Get-Clipboard"
powershell.exe -NoProfile -Command "[Console]::OutputEncoding=[Text.Encoding]::UTF8; Get-WinEvent -LogName System -MaxEvents 5 | Format-Table TimeCreated,Id,ProviderName"
powershell.exe -NoProfile -Command "Get-NetIPAddress -AddressFamily IPv4 | Select IPAddress,InterfaceAlias"
```

## System info, network, tasks, power

```bash
systeminfo.exe | rg -i "OS Name|System Type|Total Physical"
ipconfig.exe /all | rg -i "IPv4|Default Gateway"
netstat.exe -ano | rg -i "listen" | head
route.exe print
getmac.exe /v
schtasks.exe /query /fo csv                        # scheduled tasks
schtasks.exe /create /tn "WSLJob" /tr "C:\x.bat" /sc daily /st 09:00 /f
schtasks.exe /run /tn "WSLJob"
shutdown.exe /r /t 60 /c "reboot by WSL"           # restart Windows (privileged)
shutdown.exe /a                                  # abort pending shutdown
```

## Elevation, limits, gotchas

- Processes launched from WSL run unelevated; UAC prompts appear on the Windows desktop for `-Verb RunAs` and cannot be auto-accepted.
- `netsh advfirewall firewall add rule` and other admin operations fail with "requires elevation" from a non-admin shell.
- Distro differences: Arch vs Ubuntu have identical interop behavior; only paths like the default distro name differ (`wsl.exe -l -v` lists them).
- Keep long-running Windows processes under `&`/`nohup` and verify with `Get-Process` + `CommandLine`, not just existence — several instances may share one image name.
- Prefer native Linux tools when they exist; `/mnt/c` I/O and per-call interop overhead make Windows tooling slower.