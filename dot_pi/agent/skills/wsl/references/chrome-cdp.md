# Chrome headless and CDP network inspection

## Chrome headless (DOM dump)

```bash
"/mnt/c/Program Files/Google/Chrome/Application/chrome.exe" --headless --disable-gpu --dump-dom "https://example.com"
```

The first process to start Chrome owns all flags; later `chrome.exe` invocations only open tabs in the existing process. Use a unique `--user-data-dir` (e.g. `C:\tmp\netprobe`) for a clean instance.

## Live network inspection (CDP) — verified working

Launch headless Chrome with remote debugging, then attach via the Chrome DevTools Protocol from Python. Requires `pip install websocket-client`.

```bash
"/mnt/c/Program Files/Google/Chrome/Application/chrome.exe" \
  --headless --disable-gpu --remote-debugging-port=9222 \
  --remote-allow-origins=* --user-data-dir="C:\\tmp\\netprobe" about:blank &

python3 - <<'EOF'
import json, time, urllib.request, websocket

def jget(path, method="GET"):
    req = urllib.request.Request(f"http://127.0.0.1:9222{path}", method=method)
    if method == "PUT":
        req.add_header("Content-Length", "0")
    with urllib.request.urlopen(req, timeout=5) as r:
        return json.loads(r.read().decode())

tab = jget("/json/new?url=about:blank", "PUT")
ws = websocket.create_connection(tab["webSocketDebuggerUrl"], timeout=15)
def send(m, p=None):
    ws.send(json.dumps({"id": 1, "method": m, "params": p or {}}))

send("Network.enable")
send("Page.enable")
send("Page.navigate", {"url": "https://en.wikipedia.org/wiki/Windows_Subsystem_for_Linux"})

end = time.time() + 10
while time.time() < end:
    try:
        data = json.loads(ws.recv())
    except websocket.WebSocketTimeoutException:
        continue
    if data.get("method") == "Network.requestWillBeSent":
        req = data["params"]["request"]
        print(data["params"]["type"], req["method"], req["url"])
ws.close()
EOF
```

## Technical notes (all observed)

- Chrome 111+ rejects websocket handshakes unless launched with `--remote-allow-origins=*`; without it you get HTTP 403.
- The DevTools HTTP endpoint usually binds `127.0.0.1` even with `--remote-debugging-address=0.0.0.0`; on mirrored networking that is fine (see networking.md).
- Create a scratch tab with `PUT /json/new` so existing tabs are untouched; enable `Network` before navigating or events are missed.
- `Network.requestWillBeSent` gives type/method/URL; `Network.responseReceived` gives status codes; `Network.getResponseBody` (with `requestId`) fetches bodies.
- First Chrome process wins the debugging port; kill stale instances with the process-kill pattern in windows-interop.md before relaunching.