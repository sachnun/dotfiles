import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getMarkdownTheme } from "@earendil-works/pi-coding-agent";
import { Markdown, Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";

const E = "https://mcp.exa.ai/mcp";
const H = { "Content-Type": "application/json", Accept: "application/json, text/event-stream" };

async function mcp(tool: string, args: unknown): Promise<string> {
  const res = await fetch(E, {
    method: "POST",
    headers: H,
    signal: AbortSignal.timeout(5000),
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: tool, arguments: args } }),
  });
  const data = (await res.text()).split("\n").find((l) => l.startsWith("data: "));
  const msg = data ? JSON.parse(data.slice(6)) : undefined;
  if (msg?.error) throw new Error(msg.error.message);
  return msg?.result?.content?.[0]?.text ?? "";
}

export default function exa(pi: ExtensionAPI) {
  pi.on("before_agent_start", (event) => {
    const d = new Date();
    const today = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    return { systemPrompt: `${event.systemPrompt}\n\nToday is ${today}.` };
  });

  pi.registerTool({
    name: "exa",
    description: "Search the web or fetch a page.",
    parameters: Type.Object({
      query: Type.Optional(Type.String()),
      url: Type.Optional(Type.String()),
    }),

    renderCall(args, theme) {
      return new Text(theme.fg("toolTitle", theme.bold("exa ")) + theme.fg("accent", args.query ?? args.url), 0, 0);
    },

    renderResult(result, { expanded }, theme) {
      if (!expanded) return new Text("", 0, 0);
      const content = result.content[0];
      if (content?.type !== "text") return new Text(theme.fg("error", "exa: no content"), 0, 0);
      const text = content.text;
      if (!text.startsWith("Title: ")) {
        return new Markdown(`\n${text}`, 0, 0, getMarkdownTheme());
      }
      let out = "";
      for (const l of text.split("\n")) {
        if (l.startsWith("Title: ")) out += `${out ? "\n\n" : ""}${theme.fg("toolTitle", l.slice(7))}`;
        else if (l.startsWith("URL: ")) out += `\n${theme.fg("dim", l.slice(5))}`;
        else if (l.startsWith("Published: ") && !l.endsWith("N/A")) out += `\n${theme.fg("muted", l.slice(11))}`;
      }
      return new Text(out ? `\n${out}` : theme.fg("error", text), 0, 0);
    },

    async execute(_id, p) {
      try {
        if (p.query) {
          const text = await mcp("web_search_exa", { query: p.query, numResults: 3 });
          return { content: [{ type: "text", text }] };
        }
        if (p.url) {
          const text = await mcp("web_fetch_exa", { urls: [p.url], maxCharacters: 3000 });
          const cleaned = text
            .split("\n")
            .filter((l) => !l.startsWith("URL: "))
            .join("\n");
          return { content: [{ type: "text", text: cleaned }] };
        }
        return { content: [{ type: "text", text: "exa: provide query or url" }] };
      } catch (e) {
        return { content: [{ type: "text", text: `exa: ${(e as Error).message}` }] };
      }
    },
  });
}
