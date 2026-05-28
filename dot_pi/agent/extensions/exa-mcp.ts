import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { keyHint } from "@earendil-works/pi-coding-agent";
import { Text, truncateToWidth } from "@earendil-works/pi-tui";

const MCP_URL = "https://unroxy.koyeb.app/mcp.exa.ai/mcp";

const PREVIEW_LINES = 10;

export default async function (pi: ExtensionAPI) {
  // Auto-search hook: ALWAYS search first, never rely on internal knowledge
  pi.on("before_agent_start", async (event, ctx) => {
    const autoSearchInstruction = `

## MANDATORY WEB SEARCH - FOLLOW STRICTLY

CRITICAL INSTRUCTION: You MUST use exa_web_search_exa BEFORE answering ANY question. Do NOT skip this step.

### RULES:
1. ALWAYS search first - no exceptions
2. NEVER answer from internal knowledge alone
3. If unsure, search anyway
4. Search multiple times if needed for comprehensive answers
5. Cite sources from search results when possible

### WHAT TO SEARCH:
- ANY programming question (syntax, APIs, libraries, frameworks)
- ANY technical documentation or references
- ANY error messages or debugging issues
- ANY best practices or patterns
- ANY version compatibility or migration guides
- ANY deployment, DevOps, or infrastructure questions
- ANY security vulnerabilities or patches
- ANY performance optimization tips
- ANY tool comparisons or recommendations
- ANY question where current/recent info matters

### SEARCH STRATEGY:
- Use descriptive queries, not just keywords
- Search for official docs first (e.g., "official React hooks documentation")
- Then search for practical examples (e.g., "React hooks useEffect example 2024")
- For errors, search the exact error message
- For comparisons, search multiple alternatives

### BEFORE EDITING CODE - MANDATORY STEPS:
1. READ the existing file first using the read tool
2. SEARCH for official documentation of the library/framework/API you're modifying
3. SEARCH for current best practices and patterns
4. CHECK for any recent breaking changes or deprecations
5. VERIFY the syntax and API are still valid
6. ONLY THEN proceed with code edits

### WHEN WRITING NEW CODE:
1. SEARCH for the official documentation of the tool/library
2. SEARCH for current recommended patterns
3. CHECK the latest version and any migration guides
4. Look up real-world examples from trusted sources
5. Write code based on verified, up-to-date information

REMEMBER: Your internal knowledge is outdated. Search is mandatory. Documentation is the source of truth.`;
    
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
