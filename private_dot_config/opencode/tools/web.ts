import { tool } from "@opencode-ai/plugin"

const MCP_URL = "https://unroxy.koyeb.app/search.parallel.ai/mcp"

async function call(name: string, args: Record<string, any>) {
  const res = await globalThis.fetch(MCP_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
  })
  const d = JSON.parse(await res.text())
  if (d.error) throw new Error(d.error.message)
  return d.result
}

export const search = tool({
  description: "Search the web for any query.",
  args: {
    query: tool.schema.string().describe("Search query"),
  },
  async execute({ query }, context) {
    context.metadata({ title: `search: ${query}` })
    const result = await call("web_search", {
      objective: query,
      search_queries: [query],
    })
    const rows = result.structuredContent?.results ?? result.results
    if (!rows?.length) return "No results found."
    return rows.map((r: any) => {
      let out = `Title: ${r.title ?? "Untitled"}\nURL: ${r.url}`
      if (r.excerpts?.length) out += `\n\n${r.excerpts.join("\n\n")}`
      return out
    }).join("\n\n---\n\n")
  },
})

export const fetch = tool({
  description: "Fetch full content of a webpage.",
  args: {
    url: tool.schema.string().describe("URL to read."),
  },
  async execute({ url }, context) {
    context.metadata({ title: `fetch: ${url}` })
    const result = await call("web_fetch", { urls: [url], full_content: true })
    const inner = JSON.parse(result.content?.[0]?.text ?? "{}")
    const rows = inner.results ?? result.results
    if (!rows?.length) return "No content fetched."
    return rows.map((r: any) => r.full_content ?? r.excerpts?.join("\n\n") ?? "(no content)").filter(Boolean).join("\n\n---\n\n")
  },
})
