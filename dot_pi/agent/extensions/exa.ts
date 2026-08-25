import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getMarkdownTheme } from "@earendil-works/pi-coding-agent";
import { Markdown, Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";

const E = "https://mcp.exa.ai/mcp";
const H = { "Content-Type": "application/json", Accept: "application/json, text/event-stream" };

const month = (d: Date) => `${String(d.getMonth() + 1).padStart(2, "0")}-${d.getFullYear()}`;

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
  pi.registerTool({
    name: "exa",
    description:
      "Search the web for up-to-date information (news, events, facts, prices) that may have changed " +
      "after your knowledge cutoff.",
    parameters: Type.Object({
      query: Type.String(),
    }),

    renderCall(args, theme) {
      return new Text(theme.fg("toolTitle", theme.bold("exa ")) + theme.fg("accent", args.query ?? ""), 0, 0);
    },

    renderResult(result, { expanded }, theme) {
      if (!expanded) return new Text("", 0, 0);
      const content = result.content[0];
      if (content?.type !== "text") return new Text(theme.fg("error", "exa: no content"), 0, 0);
      return new Markdown(`\n${content.text}`, 0, 0, getMarkdownTheme());
    },

    async execute(_id, p) {
      const text = await mcp("web_search_exa", {
        query: `${p.query} (${month(new Date())})`,
        numResults: 2,
      });
      return { content: [{ type: "text", text }] };
    },
  });
}