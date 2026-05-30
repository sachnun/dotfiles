import { tool } from "@opencode-ai/plugin"

const MCP_URL = "https://unroxy.koyeb.app/mcp.exa.ai/mcp"

async function call(name: string, args: Record<string, any>) {
  const res = await globalThis.fetch(MCP_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
  })
  for (const line of (await res.text()).split("\n")) {
    if (line.startsWith("data: ")) {
      const d = JSON.parse(line.slice(6))
      if (d.result) return d.result
      if (d.error) throw new Error(d.error.message)
    }
  }
  throw new Error("No result")
}

export const search = tool({
  description:
    "Search the web for any topic and get clean, ready-to-use content. " +
    "Best for finding information, news, facts, people, companies. " +
    "Use category:people / category:company to focus results.",
  args: {
    query: tool.schema.string().describe("Search query"),
    numResults: tool.schema.number().optional().default(10),
  },
  async execute({ query, numResults }, context) {
    context.metadata({ title: `search: ${query}` })
    const result = await call("web_search_exa", { query, numResults: numResults ?? 10 })
    return result.content?.[0]?.text ?? JSON.stringify(result)
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
    const result = await call("web_fetch_exa", { urls })
    return result.content?.[0]?.text ?? JSON.stringify(result)
  },
})
