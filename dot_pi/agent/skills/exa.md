---
name: exa
description: Web search and full page extraction through the public Exa MCP endpoint (no API key). Use for current facts, news, prices, or reading any URL when built-in knowledge may be stale.
---

# Exa Web Search

Search the live web and fetch page content via Exa's public MCP endpoint over HTTP. No API key or signup required.

## Search

Run the whole block, then call `exa_search` with a query:

```bash
exa_search() {
  local q="$1" n="${2:-5}"
  curl -sS --max-time 60 -X POST https://mcp.exa.ai/mcp \
    -H 'Content-Type: application/json' \
    -H 'Accept: application/json, text/event-stream' \
    -d "$(jq -nc --arg q "$q" --argjson n "$n" \
      '{jsonrpc:"2.0",id:1,method:"tools/call",params:{name:"web_search_exa",arguments:{query:$q,numResults:$n}}}')" \
    | sed -n 's/^data: //p' \
    | jq -r 'if .error then "exa error: \(.error.message)" else .result.content[0].text end'
}

exa_search "blog post comparing React and Vue performance" 5
```

Optional objective to steer ranking (define the same function, then pass a third argument):

```bash
exa_search "Exa search API pricing" 5 "Find current pricing tiers and rate limits, prefer the official pricing page"
```

## Fetch page content

Read one or more known URLs as clean markdown. First argument is max characters per page:

```bash
exa_fetch() {
  local maxc="${1:-5000}"; shift
  local urls; urls=$(printf '%s\n' "$@" | jq -R . | jq -sc .)
  curl -sS --max-time 60 -X POST https://mcp.exa.ai/mcp \
    -H 'Content-Type: application/json' \
    -H 'Accept: application/json, text/event-stream' \
    -d "$(jq -nc --argjson u "$urls" --argjson c "$maxc" \
      '{jsonrpc:"2.0",id:1,method:"tools/call",params:{name:"web_fetch_exa",arguments:{urls:$u,maxCharacters:$c}}}')" \
    | sed -n 's/^data: //p' \
    | jq -r 'if .error then "exa error: \(.error.message)" else .result.content[0].text end'
}

exa_fetch 5000 https://example.com https://example.org
```

## Query tips

- Describe the ideal page, not keywords: "blog post comparing React and Vue performance" beats "React vs Vue".
- For time sensitive answers, append the current month: `... (09-2026)`.
- Use `category:people` or `category:company` to search LinkedIn profiles or companies.
- If highlights are thin, `exa_fetch` the best URLs from the results.

## Notes

- Tools: `web_search_exa` (query, numResults, optional objective) and `web_fetch_exa` (urls, maxCharacters).
- Responses are Server-Sent Events with one `data:` line; the `sed`/`jq` pipeline extracts the text.
- `numResults` defaults to 5 here; raise it only when needed.
- Errors print as `exa error: ...` on stdout, so check output when a result looks empty.
