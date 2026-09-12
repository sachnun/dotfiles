---
name: exa
description: Web search and page fetch for current info.
---

# Exa Web Search

Search:

```bash
curl -sS --max-time 60 -X POST https://mcp.exa.ai/mcp \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"web_search_exa","arguments":{"query":"blog post comparing React and Vue performance","numResults":5}}}'
```

```
event: message
data: {"result":{"content":[{"type":"text","text":"Title: React vs Vue\nURL: https://example.com\n..."}],"_meta":{}},"jsonrpc":"2.0","id":1}
```

Fetch (arguments: `urls`, `maxCharacters`; tool `web_fetch_exa`):

```bash
curl -sS --max-time 60 -X POST https://mcp.exa.ai/mcp \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"web_fetch_exa","arguments":{"urls":["https://example.com"],"maxCharacters":5000}}}'
```

```
event: message
data: {"result":{"content":[{"type":"text","text":"# Example Domain\n..."}],"_meta":{}},"jsonrpc":"2.0","id":1}
```
