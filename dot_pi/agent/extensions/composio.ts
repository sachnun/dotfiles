/**
 * Composio MCP Bridge — single-file pi extension.
 *
 * Connects pi to https://connect.composio.dev/mcp (Streamable HTTP MCP).
 * Registers 3 core meta-tools (~470 tokens in the system prompt):
 *   composio_search_tools, composio_manage_connections, composio_multi_execute_tool
 *
 * Results are compacted before reaching the model: noise keys (log_id,
 * $schema, examples, next_steps_guidance, nulls) dropped, descriptions
 * truncated to 120 chars. JSON structure is never broken. TUI renders
 * pretty-printed highlighted JSON with built-in style collapse (Ctrl+O).
 *
 * API key: env COMPOSIO_API_KEY or ~/.pi/agent/composio.json (/composio to login/logout).
 */

import {
	highlightCode,
	keyHint,
	truncateToVisualLines,
	type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Container, Text } from "@earendil-works/pi-tui";
import { Type, type TSchema } from "typebox";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

const ENDPOINT = "https://connect.composio.dev/mcp";
const CONFIG_FILE = join(homedir(), ".pi", "agent", "composio.json");
const MAX_TEXT_LENGTH = 60_000;
const PREVIEW_LINES = 5;
const TRUNCATION_MARKER = "\n…(output truncated,";
const NOISE_KEYS = new Set(["log_id", "$schema", "examples", "next_steps_guidance"]);
const MAX_DESC = 120;

// ---------------------------------------------------------------------------
// MCP Streamable HTTP client
// ---------------------------------------------------------------------------

interface JSONRPCResponse<T> {
	jsonrpc: string;
	id: number;
	result?: T;
	error?: { code: number; message: string };
}

function parseSSE(raw: string): unknown {
	const lines = raw
		.split(/\r?\n/)
		.filter((l) => l.startsWith("data:"))
		.map((l) => l.slice(5).trimStart());
	if (lines.length === 0) throw new Error(`Composio MCP: no SSE data: ${raw.slice(0, 200)}`);
	return JSON.parse(lines.join("\n"));
}

class ComposioMCPClient {
	private id = 0;

	constructor(
		private readonly apiKey: string,
		private readonly endpoint: string = ENDPOINT,
	) {}

	private async request<T>(method: string, params: unknown, signal?: AbortSignal): Promise<T> {
		if (!this.apiKey) {
			throw new Error("COMPOSIO_API_KEY is not set. Set the env var or run /composio.");
		}
		const res = await fetch(this.endpoint, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Accept: "application/json, text/event-stream",
				Authorization: `Bearer ${this.apiKey}`,
			},
			body: JSON.stringify({ jsonrpc: "2.0", id: ++this.id, method, params }),
			signal,
		});
		if (!res.ok) {
			const body = await res.text().catch(() => "");
			throw new Error(`Composio MCP HTTP ${res.status}: ${body.slice(0, 300) || res.statusText}`);
		}
		const contentType = res.headers.get("content-type") ?? "";
		const payload = contentType.includes("text/event-stream") ? parseSSE(await res.text()) : await res.json();
		const msg = payload as JSONRPCResponse<T>;
		if (msg?.error) throw new Error(`Composio MCP error ${msg.error.code}: ${msg.error.message}`);
		return msg.result as T;
	}

	async initialize(signal?: AbortSignal): Promise<void> {
		await this.request<unknown>("initialize", {
			protocolVersion: "2025-03-26",
			capabilities: {},
			clientInfo: { name: "pi-composio", version: "1.0.0" },
		}, signal);
	}

	async callTool(name: string, arguments_: unknown, signal?: AbortSignal) {
		return this.request<{ content?: Array<{ type: string; text?: string }>; isError?: boolean }>(
			"tools/call", { name, arguments: arguments_ ?? {} }, signal);
	}
}

function extractResultText(result: { content?: Array<{ type: string; text?: string }> }): string {
	return (result.content ?? []).map((c) => c.text ?? JSON.stringify(c)).join("\n");
}

// ---------------------------------------------------------------------------
// Tool parameters (TypeBox, hand-written — compact)
// ---------------------------------------------------------------------------

const SEARCH_PARAMS = Type.Object({
	queries: Type.Array(Type.Object({
		use_case: Type.String(),
		known_fields: Type.Optional(Type.String()),
	})),
	session: Type.Optional(Type.Object({
		generate_id: Type.Optional(Type.Boolean()),
		id: Type.Optional(Type.String()),
	})),
});

const CONNECT_PARAMS = Type.Object({
	toolkits: Type.Array(Type.Object({
		name: Type.String(),
		action: Type.Optional(StringEnum(["add", "rename", "list", "remove"] as const)),
		alias: Type.Optional(Type.String()),
		account_id: Type.Optional(Type.String()),
	})),
});

const EXECUTE_PARAMS = Type.Object({
	tools: Type.Array(Type.Object({
		tool_slug: Type.String(),
		arguments: Type.Object({}, { additionalProperties: true }),
		account: Type.Optional(Type.String()),
	})),
	sync_response_to_workbench: Type.Boolean(),
	session_id: Type.Optional(Type.String()),
});

interface ToolDefinition {
	name: string;
	description: string;
	parameters: TSchema;
}

const TOOLS: ToolDefinition[] = [
	{
		name: "COMPOSIO_SEARCH_TOOLS",
		description:
			"Call FIRST for real-time info (news, releases, prices, weather), web search, or anything involving an external app or service. Never claim you lack access before calling this.",
		parameters: SEARCH_PARAMS,
	},
	{
		name: "COMPOSIO_MANAGE_CONNECTIONS",
		description: "Connect/disconnect app accounts.",
		parameters: CONNECT_PARAMS,
	},
	{
		name: "COMPOSIO_MULTI_EXECUTE_TOOL",
		description: "Run discovered tools in parallel (max 50).",
		parameters: EXECUTE_PARAMS,
	},
];

// ---------------------------------------------------------------------------
// Result helpers
// ---------------------------------------------------------------------------

function tryPrettyPrintJson(text: string): { pretty: string; parsed: unknown } | null {
	const trimmed = text.trim();
	if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return null;
	try {
		const parsed = JSON.parse(trimmed);
		return { pretty: JSON.stringify(parsed, null, 2), parsed };
	} catch {
		return null;
	}
}

/** One-line JSON structure summary (valid JSON, highlightable). */
function summarizeJson(value: unknown): string {
	const summarize = (v: unknown): unknown => {
		if (v === null) return null;
		if (typeof v === "number" || typeof v === "boolean") return v;
		if (typeof v === "string") return v.length > 24 ? `${v.slice(0, 21)}…` : v;
		if (Array.isArray(v)) return `[${v.length} item(s)]`;
		if (typeof v === "object") return "{…}";
		return String(v);
	};
	if (Array.isArray(value)) return JSON.stringify(`[${value.length} item(s)]`);
	if (typeof value !== "object" || value === null) return JSON.stringify(value);
	const record = value as Record<string, unknown>;
	const keys = Object.keys(record);
	const out: Record<string, unknown> = {};
	for (const k of keys.slice(0, 6)) out[k] = summarize(record[k]);
	if (keys.length > 6) out[`+${keys.length - 6} more`] = "{…}";
	return JSON.stringify(out);
}

/** Drop noise keys/nulls, truncate long descriptions. Never breaks structure. */
function compactJsonValue(value: unknown): unknown {
	if (Array.isArray(value)) {
		return value.map(compactJsonValue).filter((v) => v !== undefined && v !== null);
	}
	if (value !== null && typeof value === "object") {
		const out: Record<string, unknown> = {};
		for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
			if (NOISE_KEYS.has(k)) continue;
			if (k === "description" && typeof v === "string" && v.length > MAX_DESC) {
				out[k] = `${v.slice(0, MAX_DESC - 1)}…`;
				continue;
			}
			const cv = compactJsonValue(v);
			if (cv !== undefined && cv !== null) out[k] = cv;
		}
		return out;
	}
	return value;
}

async function loadApiKey(): Promise<string | undefined> {
	if (process.env.COMPOSIO_API_KEY?.trim()) return process.env.COMPOSIO_API_KEY.trim();
	try {
		const cfg = JSON.parse(await readFile(CONFIG_FILE, "utf8")) as { apiKey?: unknown };
		if (typeof cfg.apiKey === "string" && cfg.apiKey.trim()) return cfg.apiKey.trim();
	} catch {
		// no file
	}
	return undefined;
}

// ---------------------------------------------------------------------------
// Extension entry
// ---------------------------------------------------------------------------

export default function (pi: ExtensionAPI) {
	let client: ComposioMCPClient | undefined;

	for (const def of TOOLS) {
		const name = def.name.toLowerCase();

		pi.registerTool({
			name,
			description: def.description,
			promptSnippet: "Composio: 500+ external app integrations",
			promptGuidelines: [
				"After search: composio_manage_connections for auth, then composio_multi_execute_tool. Never invent tool slugs.",
			],
			parameters: def.parameters,

			renderCall(_args, theme, context) {
				const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
				text.setText(`${theme.fg("toolTitle", theme.bold(name))}${context.isPartial ? theme.fg("dim", " ...") : ""}`);
				return text;
			},

			renderResult(result, { expanded, isPartial }, theme, context) {
				const component = (context.lastComponent as Container | undefined) ?? new Container();
				component.clear();
				if (isPartial) return component;

				let raw = result.content[0]?.type === "text" ? (result.content[0].text ?? "") : "";
				const truncIdx = raw.indexOf(TRUNCATION_MARKER);
				if (truncIdx !== -1) raw = raw.slice(0, truncIdx);

				const json = tryPrettyPrintJson(raw);
				const styled = json
					? highlightCode(json.pretty, "json").join("\n")
					: raw.split("\n").map((l) => theme.fg("toolOutput", l)).join("\n");

				if (expanded) {
					component.addChild(new Text(`\n${styled}`, 0, 0));
					return component;
				}

				const state = context.state as { lines?: string[]; skipped?: number; width?: number };
				component.addChild({
					render: (width: number) => {
						if (state.lines === undefined || state.width !== width) {
							if (json) {
								const total = truncateToVisualLines(styled, 1_000_000, width).visualLines;
								if (total.length <= PREVIEW_LINES) {
									state.lines = total;
									state.skipped = 0;
								} else {
									const summary = summarizeJson(json.parsed);
									const capped = summary.length > 240 ? `${summary.slice(0, 237)}…` : summary;
									state.lines = highlightCode(capped, "json");
									state.skipped = total.length;
								}
							} else {
								const preview = truncateToVisualLines(styled, PREVIEW_LINES, width);
								state.lines = preview.visualLines;
								state.skipped = preview.skippedCount;
							}
							state.width = width;
						}
						if (state.skipped && state.skipped > 0) {
							const hint = `${theme.fg("muted", `... (${state.skipped} ${json ? "lines" : "earlier lines"},`)} ${keyHint("app.tools.expand", "to expand")}${theme.fg("muted", ")")}`;
							return ["", hint, ...(state.lines ?? [])];
						}
						return ["", ...(state.lines ?? [])];
					},
					invalidate: () => {
						state.width = undefined;
						state.lines = undefined;
						state.skipped = undefined;
					},
				});
				return component;
			},

			async execute(_toolCallId, params, signal, onUpdate) {
				if (!client) client = new ComposioMCPClient((await loadApiKey()) ?? "");
				onUpdate?.({ content: [{ type: "text", text: `Running ${def.name}…` }] });
				const result = await client.callTool(def.name, params, signal);
				if (result.isError) throw new Error(extractResultText(result) || `${def.name} failed`);
				let text = extractResultText(result);
				const json = tryPrettyPrintJson(text);
				if (json) text = JSON.stringify(compactJsonValue(json.parsed), null, 2);
				if (text.length > MAX_TEXT_LENGTH) {
					text = `${text.slice(0, MAX_TEXT_LENGTH)}\n…(output truncated, total ${text.length} chars)`;
				}
				return { content: [{ type: "text", text }], details: { tool: def.name } };
			},
		});
	}

	pi.registerCommand("composio", {
		description: "Composio MCP login/logout: prompt for API key or confirm logout",
		handler: async (_args, ctx) => {
			const key = await loadApiKey();

			if (!key) {
				const input = await ctx.ui.input("Composio API key", "ck_… (https://app.composio.dev)");
				if (!input?.trim()) {
					ctx.ui.notify("Cancelled — API key unchanged.", "warning");
					return;
				}
				await mkdir(dirname(CONFIG_FILE), { recursive: true });
				await writeFile(CONFIG_FILE, JSON.stringify({ apiKey: input.trim() }, null, 2) + "\n", { mode: 0o600 });
				client = new ComposioMCPClient(input.trim());
				ctx.ui.notify("Logged in. Composio tools ready.", "info");
				return;
			}

			const envKey = process.env.COMPOSIO_API_KEY?.trim();
			let conn = "not tested";
			try {
				await new ComposioMCPClient(key).initialize();
				conn = "OK";
			} catch (err) {
				conn = `FAILED: ${err instanceof Error ? err.message : String(err)}`;
			}

			const ok = await ctx.ui.confirm("Composio", [
				`Logged in (key: ${envKey ? "env COMPOSIO_API_KEY" : CONFIG_FILE})`,
				`Connection: ${conn}`,
				`Tools: ${TOOLS.length} registered`,
				"",
				envKey
					? "API key is set via env. Logout removes the saved file key; unset COMPOSIO_API_KEY to fully log out."
					: "Logout from Composio?",
			].join("\n"));
			if (!ok) return;

			client = undefined;
			try {
				await writeFile(CONFIG_FILE, JSON.stringify({ apiKey: "" }, null, 2) + "\n", { mode: 0o600 });
			} catch {
				// ignore
			}
			ctx.ui.notify(
				envKey
					? "Saved file key removed. Unset COMPOSIO_API_KEY to fully log out."
					: "Logged out. Run /composio to log in again.",
				"info",
			);
		},
	});
}
