---
name: chrome
description: Controls the user's real Chrome via the pi-chrome bridge extension. Inspects pages (snapshot, inspect), interacts with real input (click, type, fill, key, hover, scroll), navigates, runs JS, reads console/network logs, manages tabs, plus browser utilities (download, save-mhtml, cookies). Use whenever the user asks to open, read, operate, or automate something in Chrome.
---

# Chrome control

Drives the user's real signed-in Chrome via the pi-chrome bridge (extension `Pi` polls it; bridge runs automatically when Pi opens). Check first: `./chrome.ts status` — `●` connected, `○` not. If not connected: open Chrome, enable `Pi` at `chrome://extensions` (Load unpacked → `~/.pi/agent/extensions/chrome/connector`).

Run from the skill dir: `./chrome.ts <cmd> [flags]` (or full path from anywhere).

## Workflow (memorize)

1. `status` → 2. `navigate --url` → 3. `snapshot` (get uids) → 4. `snapshot --query` / `inspect --uid` → 5. interact → 6. verify with fresh snapshot or `--include-snapshot`. Always snapshot before clicking; prefer `--uid` over `--selector`.

## Commands

```bash
./chrome.ts status | tabs
./chrome.ts tab --action new|activate|close|group|ungroup [--url] [--target-id]
./chrome.ts snapshot [--mode auto|interactive|forms|pageMap|text|changes|full] [--query] [--max-elements 80]
./chrome.ts inspect --uid el-3 | --selector <css>
./chrome.ts navigate --url <url> [--init-script "js@document_start"]
./chrome.ts evaluate --expression "js"          # MAIN world, bypasses CSP
./chrome.ts waitfor --kind selector|expression --value ... [--timeout-ms N]
./chrome.ts click|hover --uid el-5 | --selector | --x N --y N
./chrome.ts type --text "..." [--uid] [--press-enter]
./chrome.ts fill --text "..." --uid | --selector [--submit]
./chrome.ts key --key Enter|Tab|Escape|Backspace|ArrowUp|... [--modifiers '{"ctrlKey":true}']
./chrome.ts scroll [--delta-y N] [--delta-x N]
./chrome.ts console [--clear] | network [--clear] [--include-preserved-requests] | network-get --request-id <id>
./chrome.ts upload --paths "/abs/a.png,/abs/b.png" --uid <file-input>
./chrome.ts download --url <url> [--filename] [--save-as]
./chrome.ts save-mhtml [--out path.mhtml] [--target-id]
./chrome.ts cookies [--url]
./chrome.ts batch --commands '[{"command":"tabs"},{"command":"cookies"}]'   # or JSONL on stdin; results numbered, order preserved, per-command "timeoutMs"
./chrome.ts help
```

## Flags

| Flag | Meaning |
|------|---------|
| `--target-id` / `--url-includes` / `--title-includes` | act on a specific existing tab; without these, actions run on pi-chrome's own automation tab, never the user's active tab |
| `--background` / `--foreground` | background (default, Chrome hidden) vs bring Chrome to front |
| `--include-snapshot` | click/type/fill/key: return fresh snapshot to verify |
| `--timeout-ms N` | per-command timeout |
| `--json '{...}'` | raw params passthrough |

## Notes

- `pageMutated: false` ≠ nothing happened — verify with a snapshot.
- Big snapshots cost tokens: use `--max-elements`, `--mode text`, `inspect`, or `snapshot --query`.
- Timeout "extension is not polling" → Chrome closed / `Pi` disabled; check `status`.
