---
name: wsl
description: "Helps operate Windows Subsystem for Linux (WSL) setups end-to-end: running Windows programs from Linux, working across the Linux and Windows filesystems, controlling Windows GUI apps, driving Windows Chrome (headless or visible) including live network inspection, managing Windows processes and windows, and troubleshooting WSL2 networking. Use for any task that touches WSL, Windows interop from Linux, or Windows-based browser automation."
---

# WSL

Everything verified on WSL2 (kernel `6.6.87.2-microsoft-standard-WSL2`, Arch) with Windows interop enabled. Check interop first:

```bash
uname -a
which notepad.exe powershell.exe cmd.exe   # must resolve; they live in /mnt/c/WINDOWS/system32
wsl.exe -l -v | iconv -f UTF-16LE -t UTF-8 # list distros (wsl.exe pipes UTF-16LE)
```

## Reference docs (load on demand)

| File | Contents |
|------|----------|
| [references/paths-encoding.md](references/paths-encoding.md) | Output encoding trap (PS pipes OEM CP437, wsl.exe UTF-16LE), wslpath, /mnt drives, UNC, DrvFS, user temp dir |
| [references/windows-interop.md](references/windows-interop.md) | Running executables, quoting, processes/services, registry, GUI + SendKeys, clipboard, system info, schtasks/shutdown, elevation limits |
| [references/office-com.md](references/office-com.md) | Word/Office COM automation: styles, symbols, pictures, tables, WordArt, header/footer, save/PDF, quirks |
| [references/chrome-cdp.md](references/chrome-cdp.md) | Chrome headless DOM dump and live CDP network inspection |
| [references/networking.md](references/networking.md) | WSL2 NAT vs mirrored networking, localhost behavior, diagnosis |

## Cheat sheet (most common ops)

```bash
wslpath -w /mnt/c/temp/file.txt              # Linux -> Windows path
TMPWIN=$(powershell.exe -NoProfile -Command "[Environment]::GetEnvironmentVariable('TEMP')" | tr -d '\r\n')
notepad.exe "$(wslpath -w /mnt/c/temp/note.txt)" &    # open GUI app
mkdir -p /mnt/c/temp && printf 'hi' > /mnt/c/temp/x.txt   # files for Windows tools live under /mnt/c

# single-shot Windows command (UTF-8 output)
powershell.exe -NoProfile -Command "[Console]::OutputEncoding=[Text.Encoding]::UTF8; Get-Service" | iconv -f UTF-8 -t UTF-8

# inspect window + unsaved-changes marker
powershell.exe -NoProfile -Command "Get-Process notepad | Select-Object Id,MainWindowTitle | Format-List"

# minimize an Office app already running
powershell.exe -NoProfile -Command "\$w = [Runtime.InteropServices.Marshal]::GetActiveObject('Word.Application'); \$w.WindowState = 2"

# headless Chrome DOM dump
"/mnt/c/Program Files/Google/Chrome/Application/chrome.exe" --headless --disable-gpu --dump-dom "https://example.com"
```

For anything deeper — encoding, Office COM building blocks, CDP capture script, mirrored vs NAT quirks — read the matching reference file above.