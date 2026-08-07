// duck.ts — DuckDuckGo search (10 links only). Bypasses ISP DNS-poisoning + SNI-filter via DoH + SNI spoof.
import https from "node:https";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";

const MAX = 10;
const UA = "Mozilla/5.0 (X11; Linux x86_64; rv:130.0) Gecko/20100101 Firefox/130.0";
const UA_API = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36";
const FALLBACK: Record<string, string> = { "duckduckgo.com": "20.43.161.105", "links.duckduckgo.com": "172.188.181.134" };

// Real IP via Cloudflare DoH (ISP DNS is poisoned), fallback to hardcoded.
const resolve = async (host: string): Promise<string> => {
  try {
    const j = (await (await fetch(`https://cloudflare-dns.com/dns-query?name=${host}&type=A`, { headers: { Accept: "application/dns-json" } })).json()) as { Answer?: Array<{ type: number; data: string }> };
    const a = (j.Answer ?? []).filter((x) => x.type === 1).map((x) => x.data);
    if (a.length) return a[0];
  } catch { /* use fallback */ }
  return FALLBACK[host] ?? host;
};

// TLS GET with spoofed SNI (lolos filter SNI ISP) + Host header, tanpa verifikasi cert.
const get = async (host: string, path: string, headers: Record<string, string>, signal?: AbortSignal) => {
  const ip = await resolve(host);
  return new Promise<{ status: number; data: string }>((resolve2, reject) => {
    const req = https.request({ host: ip, servername: "example.com", path, rejectUnauthorized: false, signal, headers: { Host: host, "User-Agent": UA, Accept: "text/html,*/*;q=0.8", "Accept-Language": "en-US,en;q=0.9", ...headers } },
      (res) => {
        let data = "";
        res.on("data", (c: Buffer) => (data += c));
        res.on("end", () => resolve2({ status: res.statusCode ?? 0, data }));
      });
    req.on("error", reject);
    req.setTimeout(15000, () => req.destroy(new Error("timeout")));
    req.end();
  });
};

// Flow: halaman /?q= → vqd/d.js URL → API d.js (sama seperti UI web DDG) → 10 link organik.
const search = async (query: string, signal?: AbortSignal): Promise<string[]> => {
  const page = await get("duckduckgo.com", `/?q=${encodeURIComponent(query)}`, {}, signal);
  if (page.status !== 200) throw new Error(`page HTTP ${page.status}`);
  const djs = page.data.match(/src="(https:\/\/links\.duckduckgo\.com\/d\.js[^"]+)"/);
  if (!djs) throw new Error("d.js not found");
  const api = await get("links.duckduckgo.com", djs[1].replace(/&amp;/g, "&").replace("https://links.duckduckgo.com", ""), {
    "User-Agent": UA_API, Accept: "*/*", Referer: "https://duckduckgo.com/",
    "Sec-Fetch-Dest": "empty", "Sec-Fetch-Mode": "cors", "Sec-Fetch-Site": "same-site", "X-Requested-With": "XMLHttpRequest",
  }, signal);
  if (api.status !== 200) throw new Error(`api HTTP ${api.status}`);
  const links: string[] = [];
  for (const m of api.data.matchAll(/"u":"((?:[^"\\]|\\.)*)"/g)) {
    const url = m[1].replace(/\\"/g, '"');
    if (url.startsWith("https://duckduckgo.com/y.js?")) continue; // iklan
    if (/^https:\/\//.test(url) && !links.includes(url)) links.push(url);
    if (links.length === MAX) break;
  }
  return links;
};

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "duck",
    label: "Duck Search",
    description: "Web search.",
    parameters: Type.Object({ query: Type.String({ description: "Search query" }) }),
    async execute(_id, params, signal, _onUpdate, ctx) {
      try {
        const links = await search(params.query, signal ?? ctx.signal);
        return { content: [{ type: "text", text: links.join("\n") || "No results." }], details: { count: links.length } };
      } catch (err) {
        return { content: [{ type: "text", text: `Search failed: ${err instanceof Error ? err.message : String(err)}` }], isError: true, details: {} };
      }
    },
    renderCall(args, theme, _context) {
      return new Text(`${theme.fg("toolTitle", theme.bold("duck"))} ${theme.fg("accent", args.query)}`, 0, 0);
    },
    renderResult(result, options, theme, context) {
      if (!options.expanded && !context.isError) return new Text("", 0, 0); // kolaps, seperti read
      const output = (result.content ?? []).filter((c) => c.type === "text").map((c) => c.text).join("\n");
      return new Text(theme.fg("toolOutput", output), 0, 0);
    },
  });
}
