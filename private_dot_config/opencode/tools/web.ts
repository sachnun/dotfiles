import { tool } from "@opencode-ai/plugin"

const MCP_URL = "https://unroxy.koyeb.app/search.parallel.ai/mcp"

async function call(name: string, args: Record<string, any>) {
  const res = await globalThis.fetch(MCP_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
  })
  const text = await res.text()
  for (const line of text.split("\n")) {
    if (line.startsWith("data: ")) {
      const d = JSON.parse(line.slice(6))
      if (d.result) return d.result
      if (d.error) throw new Error(d.error.message)
    }
  }
  // Non-SSE response (plain JSON)
  try {
    const d = JSON.parse(text)
    if (d.result) return d.result
    if (d.error) throw new Error(d.error.message)
  } catch { }
  throw new Error("No result")
}

export const search = tool({
  description:
    "Search the web for any topic and get clean, ready-to-use content. " +
    "Best for finding information, news, facts, people, companies.",
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
      if (r.publish_date) out += `\nPublished: ${r.publish_date}`
      if (r.excerpts?.length) out += `\n\n${r.excerpts.join("\n\n")}`
      return out
    }).join("\n\n---\n\n")
  },
})

export const fetch = tool({
  description: "Read a webpage as clean markdown. Use when search highlights are insufficient.",
  args: {
    url: tool.schema.string().describe("URL to read. For multiple URLs, separate with commas."),
  },
  async execute({ url }, context) {
    const urls = url.split(",").map(s => s.trim()).filter(Boolean)
    context.metadata({ title: `fetch: ${urls.join(", ")}` })
    const result = await call("web_fetch", { urls, full_content: true })
    const inner = JSON.parse(result.content?.[0]?.text ?? "{}")
    const rows = inner.results ?? result.results
    if (!rows?.length) return "No content fetched."

    return rows.map((r: any) => {
      if (r.full_content) return r.full_content
      if (r.excerpts?.length) return r.excerpts.join("\n\n")
      return ""
    }).filter(Boolean).join("\n\n---\n\n")
  },
})
