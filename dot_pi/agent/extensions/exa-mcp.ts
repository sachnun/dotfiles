import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { keyHint } from "@earendil-works/pi-coding-agent";
import { Text, truncateToWidth } from "@earendil-works/pi-tui";

const MCP_URL = "https://unroxy.koyeb.app/mcp.exa.ai/mcp";

const PREVIEW_LINES = 10;

export default async function (pi: ExtensionAPI) {
  // Auto-search hook: always search first, read docs before editing
  pi.on("before_agent_start", async (event, ctx) => {
    const autoSearchInstruction = `

## MANDATORY WEB SEARCH

ALWAYS use exa_web_search_exa BEFORE answering ANY question. No exceptions.

**Core Rules:**
1. Search first, answer second - never rely on internal knowledge alone
2. For coding questions: search official docs first, then examples
3. For code edits: READ the file → SEARCH docs → VERIFY syntax → THEN edit
4. For errors: search the exact error message first
5. Cite sources from search results when possible

**Before Editing Code:**
1. READ existing file with read tool
2. SEARCH official docs for the library/framework
3. CHECK for breaking changes or deprecations
4. ONLY THEN edit code

Your internal knowledge is outdated. Search is mandatory.`;
    
    return {
      systemPrompt: event.systemPrompt + autoSearchInstruction,
    };
  });

  const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
  const { StreamableHTTPClientTransport } = await import("@modelcontextprotocol/sdk/client/streamableHttp.js");

  const client = new Client({ name: "pi-exa-mcp", version: "1.0.0" }, { capabilities: {} });
  await client.connect(new StreamableHTTPClientTransport(new URL(MCP_URL)));

  const { tools = [] } = await client.listTools();

  for (const tool of tools) {
    pi.registerTool({
      name: `exa_${tool.name}`,
      label: `Exa ${tool.name}`,
      description: tool.description || tool.name,
      parameters: tool.inputSchema || { type: "object", properties: {} },
      async execute(_id, params, _signal, _onUpdate, _ctx) {
        const result = await client.callTool({ name: tool.name, arguments: params });
        const text = result.content?.filter((c: any) => c.type === "text").map((c: any) => c.text).join("\n") || "No results";
        return { content: [{ type: "text", text }] };
      },
      renderCall(args, theme) {
        const query = args.query || args.urls || args.text || "";
        const display = typeof query === "string" ? query : JSON.stringify(query);
        return new Text(theme.fg("toolTitle", theme.bold(`Exa ${tool.name}`)) + " " + theme.fg("muted", display), 0, 0);
      },
      renderResult(result, { expanded }, theme) {
        const text = result.content?.[0]?.type === "text" ? result.content[0].text : "No results";
        if (!text) return new Text(theme.fg("muted", "No results"), 0, 0);

        const lines = text.split("\n");
        const styledOutput = lines.map(line => theme.fg("toolOutput", line)).join("\n");

        if (expanded) {
          return new Text(`\n${styledOutput}`, 0, 0);
        }

        // Compact view: show hint + last N lines
        const skipped = lines.length - PREVIEW_LINES;
        const preview = lines.slice(-PREVIEW_LINES);
        
        let display = "";
        
        if (skipped > 0) {
          display += "\n" + theme.fg("muted", `... (${skipped} more lines,`) + ` ${keyHint("app.tools.expand", "to expand")})`;
        }
        
        display += "\n" + preview.map(line => theme.fg("toolOutput", line)).join("\n");

        return new Text(display, 0, 0);
      },
    });
  }


}
