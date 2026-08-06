/**
 * Composio MCP Bridge — single-file pi extension.
 *
 * Connects pi to https://connect.composio.dev/mcp (Streamable HTTP MCP).
 * Registers 2 core meta-tools (~330 tokens in the system prompt):
 *   composio_search (search + optional one-shot execute), composio_execute
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
import { Container, Text } from "@earendil-works/pi-tui";
import { Type, type TSchema } from "typebox";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

const ENDPOINT = "https://connect.composio.dev/mcp";
// MCP server-facing tool names — the server only knows these. The model-facing
// names (composio_search / composio_execute) are mapped to them below.
const MCP_SEARCH_TOOL = "COMPOSIO_SEARCH_TOOLS";
const MCP_EXECUTE_TOOL = "COMPOSIO_MULTI_EXECUTE_TOOL";
const CONFIG_FILE = join(homedir(), ".pi", "agent", "composio.json");
const MAX_TEXT_LENGTH = 30_000;
const PREVIEW_LINES = 5;
const TRUNCATION_MARKER = "\n…(output truncated,";
const NOISE_KEYS = new Set(["log_id", "$schema", "examples", "next_steps_guidance"]);
const MAX_DESC = 120;
// Bulky SEO/duplicate fields commonly returned by search/news tools — always dropped.
const BLOAT_KEYS = new Set([
	"favicon", "favicons", "thumbnail", "thumbnailUrl", "og_image", "ogImage", "ogImageUrl",
	"imageUrl", "url", "link", "sourceUrl", "urlLink", "titleImg", "img", "domain",
	"trackingKeys", "bannerImage", "usageHints", "ogUsageHints", "siteRedirect",
	"keywords", "seo", "openGraph", "canonicalUrl", "publisherUrl", "ampUrl",
]);
const MAX_ITEMS = 8; // per-array cap for listings (first N kept)
const MAX_STR = 400; // hard cap for every remaining string value

// --- Search-specific compaction (composio_search runs every session) ---
const MAX_SEARCH_TEXT = 8_000; // hard cap on the model-facing search result text
const SEARCH_MAX_PLAN_STEPS = 1; // keep at most N recommended_plan_steps per item
const SEARCH_STEP_LEN = 120; // per-step truncation
// Meta-guidance that repeats verbatim on every call — the model does not need it again.
// plan_id is a per-query random UUID (no action value): dropped to keep repeated search
// outputs stable so the tool_schemas cache hits more often.
const SEARCH_META_KEYS = new Set(["execution_guidance", "known_pitfalls", "reference_workbench_snippets", "plan_id"]);
// BLOAT_KEYS minus link fields: url/link/domain are the valuable part of search results
// and of multi_execute responses (the model builds a roundup with clickable URLs).
const CONTENT_BLOAT_KEYS = new Set(
	[...BLOAT_KEYS].filter((k) => !["url", "link", "domain", "sourceUrl", "canonicalUrl"].includes(k)),
);

// --- Execute-specific compaction (composio_execute) ---
const MAX_ANSWER = 3_000; // main narrative field — keep it longer than generic strings
// Per-result schema/instruction boilerplate + top-level wrappers — pure guidance noise.
const EXECUTE_META_KEYS = new Set(["structure_info", "instruction", "next_steps", "remote_file_info"]);

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
	execute: Type.Optional(Type.Boolean()),
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
	name: string; // model-facing name (registered lowercase)
	description: string;
	parameters: TSchema;
	mcpName?: string; // server-facing MCP tool name; defaults to name
}

const TOOLS: ToolDefinition[] = [
	{
		name: "COMPOSIO_SEARCH",
		description:
			"Call FIRST for real-time info (news, releases, prices, weather), web search, or anything involving an external app or service. Never claim you lack access before calling this. Pass execute: true to auto-run the plan and return content in one shot (saves a turn); omit it to get the plan and execute it yourself via composio_execute.",
		mcpName: MCP_SEARCH_TOOL,
		parameters: SEARCH_PARAMS,
	},
	{
		name: "COMPOSIO_EXECUTE",
		description: "Run discovered tools in parallel (max 50).",
		mcpName: MCP_EXECUTE_TOOL,
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

/**
 * Compact one-line structure summary for the TUI collapse (valid JSON).
 * Goes two levels deep and includes a first-item sample for arrays of
 * objects, so nested payloads like {data:{results:[…]}} stay readable.
 */
function summarizeJson(value: unknown): string {
	const summarize = (v: unknown, depth: number): unknown => {
		if (v === null) return null;
		if (typeof v === "number" || typeof v === "boolean") return v;
		if (typeof v === "string") return v.length > 24 ? `${v.slice(0, 21)}…` : v;
		if (Array.isArray(v)) {
			if (v.length === 0) return "[]";
			if (depth <= 0) return `[${v.length} item(s)]`;
			const first = v[0];
			if (first !== null && typeof first === "object") {
				const rec = first as Record<string, unknown>;
				const keys = Object.keys(rec);
				const sample: Record<string, unknown> = {};
				for (const k of keys.slice(0, 3)) sample[k] = summarize(rec[k], depth - 1);
				if (keys.length > 3) sample["+more"] = "{…}";
				return { count: v.length, sample };
			}
			return `[${v.length} item(s)]`;
		}
		if (typeof v === "object") {
			const rec = v as Record<string, unknown>;
			const keys = Object.keys(rec);
			const out: Record<string, unknown> = {};
			for (const k of keys.slice(0, 6)) out[k] = summarize(rec[k], depth - 1);
			if (keys.length > 6) out[`+${keys.length - 6} more`] = "{…}";
			return out;
		}
		return String(v);
	};
	return JSON.stringify(summarize(value, 3));
}

/**
 * Execute-specific compaction: each result item ships a full response schema
 * (structure_info), per-result instruction boilerplate, plus top-level
 * next_steps/remote_file_info wrappers — all guidance noise. Keep the actual
 * content (answer, citations with title/url, previews) and counts.
 */
function compactExecuteJson(value: unknown): unknown {
	if (Array.isArray(value)) {
		const items = value.map(compactExecuteJson).filter((v) => v !== undefined && v !== null);
		if (value.length > MAX_ITEMS) {
			return [items.slice(0, MAX_ITEMS), `…${value.length - MAX_ITEMS} more item(s) omitted`];
		}
		return items;
	}
	if (value !== null && typeof value === "object") {
		const out: Record<string, unknown> = {};
		for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
			if (NOISE_KEYS.has(k) || CONTENT_BLOAT_KEYS.has(k) || EXECUTE_META_KEYS.has(k)) continue;
			if (k === "answer" && typeof v === "string") {
				out[k] = v.length > MAX_ANSWER ? `${v.slice(0, MAX_ANSWER - 1)}…` : v;
				continue;
			}
			if (k === "citations" && Array.isArray(v)) {
				// keep title/url/id only — that is what the model links to
				const cit = v
					.slice(0, MAX_ITEMS)
					.map((c) => {
						if (c === null || typeof c !== "object") return c;
						const d = c as Record<string, unknown>;
						const slim: Record<string, unknown> = {};
						for (const key of ["title", "url", "id"]) if (d[key] !== undefined) slim[key] = d[key];
						return slim;
					})
					.filter((x) => x !== undefined && x !== null);
				if (v.length > MAX_ITEMS) cit.push(`…${v.length - MAX_ITEMS} more citation(s) omitted`);
				out[k] = cit;
				continue;
			}
			if (k === "description" && typeof v === "string" && v.length > MAX_DESC) {
				out[k] = `${v.slice(0, MAX_DESC - 1)}…`;
				continue;
			}
			const cv = compactExecuteJson(v);
			if (cv !== undefined && cv !== null) out[k] = cv;
		}
		return out;
	}
	if (typeof value === "string") {
		return value.length > MAX_STR ? `${value.slice(0, MAX_STR - 1)}…` : value;
	}
	return value;
}

/**
 * Search-specific compaction: the meta-search response is dominated by the
 * query echo (use_case), identical boilerplate (execution_guidance) and long
 * plan steps — all repeated on every call. Keep only what the model needs.
 */

interface SearchCompactionContext {
	connected: Set<string>; // toolkit names with an active connection (lowercased)
	usableSlugs: Set<string>; // tool slugs belonging to connected toolkits
	usedSlugs: Set<string>; // slugs the plan actually directs the model to use (primary)
}

/**
 * Resolve which toolkits/slugs are usable right now from connection statuses
 * and schemas. Empty when the response carries no connection info.
 */
// ---------------------------------------------------------------------------
// Merged search+execute mode (execute: true on composio_search)
// ---------------------------------------------------------------------------

const MAX_RUN_TOOLS = 4; // unique plan tools executed per merged call
const MERGED_ANSWER_LEN = 1_500; // narrative cap per tool result
const MERGED_CITATIONS = 6; // citation cap per tool result

/** Find the query-ish argument a tool accepts, from its raw input_schema. */
function deriveQueryArg(schema: unknown): string | undefined {
	const props = (schema as { input_schema?: { properties?: Record<string, unknown> } })?.input_schema?.properties;
	if (!props || typeof props !== "object") return undefined;
	for (const key of ["query", "q", "search", "search_query", "query_string", "text", "keywords"]) {
		if (Object.prototype.hasOwnProperty.call(props, key)) return key;
	}
	return undefined;
}

/**
 * Pull the model-facing content out of a compacted tool response:
 * the first substantial narrative (answer) + up to MERGED_CITATIONS link-like
 * items (any object with title/link/url, e.g. citations, news_results,
 * fetched-page results, reddit posts). Descends with a depth cap so nested
 * reddit blobs cannot blow up.
 */
function extractContent(
	value: unknown,
	out: { answer?: string; citations: Array<Record<string, unknown>> },
	depth = 0,
): void {
	if (depth > 4) return;
	if (Array.isArray(value)) {
		for (const v of value) {
			if (out.citations.length >= MERGED_CITATIONS && out.answer !== undefined) return;
			if (v !== null && typeof v === "object") {
				const d = v as Record<string, unknown>;
				const title = d.title;
				const link = d.link ?? d.url ?? d.permalink;
				if ((typeof title === "string" && title.length > 0) || typeof link === "string") {
					if (out.citations.length < MERGED_CITATIONS) {
						const slim: Record<string, unknown> = {};
						if (typeof title === "string" && title.length > 0) slim.title = title;
						if (typeof link === "string" && link.length > 0) slim.url = link;
						if (typeof d.date === "string") slim.date = d.date;
						if (typeof d.published_at === "string") slim.date = d.published_at;
						if (typeof d.score === "number") slim.score = d.score;
						if (typeof d.num_comments === "number") slim.comments = d.num_comments;
						out.citations.push(slim);
					}
					continue;
				}
			}
			extractContent(v, out, depth + 1);
		}
		return;
	}
	if (value === null || typeof value !== "object") return;
	const d = value as Record<string, unknown>;
	if (out.answer === undefined && typeof d.answer === "string" && d.answer.length > 40) out.answer = d.answer;
	for (const v of Object.values(d)) {
		if (out.citations.length >= MERGED_CITATIONS && out.answer !== undefined) return;
		extractContent(v, out, depth + 1);
	}
}

/**
 * One-shot search: run the plan's primary tools server-side and return only
 * the content (answers + citations). The plan/schemas never reach the model.
 */
async function runSearchPlan(client: ComposioMCPClient, searchRaw: unknown, signal?: AbortSignal): Promise<string> {
	const data = (searchRaw as { data?: { results?: unknown; tool_schemas?: unknown; time_info?: unknown; toolkit_connection_statuses?: unknown } })?.data;
	const results = Array.isArray(data?.results) ? data.results : [];
	const schemas = ((data?.tool_schemas ?? {}) as Record<string, unknown>);

	// only run slugs whose toolkit is connected right now (unconnected tools cannot run)
	const connected = new Set<string>();
	const usableSlugs = new Set<string>();
	const statuses = data?.toolkit_connection_statuses;
	if (Array.isArray(statuses)) {
		for (const t of statuses) {
			if (t === null || typeof t !== "object") continue;
			const d = t as Record<string, unknown>;
			if (typeof d.toolkit === "string" && d.has_active_connection === true) connected.add(d.toolkit.toLowerCase());
		}
	}
	if (connected.size > 0) {
		for (const [slug, def] of Object.entries(schemas)) {
			if (def === null || typeof def !== "object") continue;
			const tk = (def as Record<string, unknown>).toolkit;
			if (typeof tk === "string" && connected.has(tk.toLowerCase())) usableSlugs.add(slug);
		}
	}

	// unique primary slugs, in plan order, with the query that introduced them
	const toRun: Array<{ slug: string; query: string }> = [];
	const seen = new Set<string>();
	for (const r of results) {
		if (r === null || typeof r !== "object") continue;
		const d = r as Record<string, unknown>;
		const useCase = typeof d.use_case === "string" ? d.use_case : "";
		const prim = d.primary_tool_slugs;
		if (!Array.isArray(prim)) continue;
		for (const s of prim) {
			if (typeof s === "string" && !seen.has(s) && (usableSlugs.size === 0 || usableSlugs.has(s))) {
				seen.add(s);
				toRun.push({ slug: s, query: useCase });
				if (toRun.length >= MAX_RUN_TOOLS) break;
			}
		}
		if (toRun.length >= MAX_RUN_TOOLS) break;
	}

	if (toRun.length === 0) {
		// nothing executable in the plan — fall back to the compacted plan
		return JSON.stringify(compactSearchJson(searchRaw));
	}

	// individual tools are not MCP tools — run them through the multi-execute meta tool
	const execArgs: Array<{ tool_slug: string; arguments: Record<string, unknown> }> = [];
	const skipped: Array<{ tool: string; reason: string }> = [];
	for (const { slug, query } of toRun) {
		const argKey = deriveQueryArg(schemas[slug]);
		if (!argKey) {
			skipped.push({ tool: slug, reason: "no query arg derivable from schema" });
			continue;
		}
		execArgs.push({ tool_slug: slug, arguments: { [argKey]: query } });
	}
	if (execArgs.length === 0) return JSON.stringify(compactSearchJson(searchRaw));

	const exec = await client.callTool(MCP_EXECUTE_TOOL, {
		tools: execArgs,
		sync_response_to_workbench: false,
	}, signal);
	if (exec.isError) throw new Error(extractResultText(exec) || "plan execution failed");
	const execJson = tryPrettyPrintJson(extractResultText(exec));
	const bySlug = new Map<string, unknown>();
	if (execJson?.parsed !== null && typeof execJson?.parsed === "object") {
		const results = (execJson.parsed as { data?: { results?: unknown } }).data?.results;
		if (Array.isArray(results)) {
			for (const r of results) {
				if (r === null || typeof r !== "object") continue;
				const rr = r as Record<string, unknown>;
				if (typeof rr.tool_slug === "string" && rr.response !== undefined) bySlug.set(rr.tool_slug, rr.response);
			}
		}
	}

	const items: Record<string, unknown>[] = [];
	const errors: Array<{ tool: string; error: string }> = [];
	const queryBySlug = new Map(toRun.map(({ slug, query }) => [slug, query]));
	for (const { tool_slug } of execArgs) {
		const query = queryBySlug.get(tool_slug) ?? "";
		const resp = bySlug.get(tool_slug);
		if (resp === undefined || (resp !== null && typeof resp === "object" && (resp as Record<string, unknown>).successful === false)) {
			const msg =
				resp !== undefined && typeof resp === "object"
					? JSON.stringify((resp as Record<string, unknown>).error ?? resp).slice(0, 200)
					: "no response";
			errors.push({ tool: tool_slug, error: msg });
			continue;
		}
		const compacted = compactExecuteJson(resp);
		const content: { answer?: string; citations: Array<Record<string, unknown>> } = { citations: [] };
		extractContent(compacted, content);
		const answer =
			content.answer && content.answer.length > 40
				? content.answer.length > MERGED_ANSWER_LEN
					? `${content.answer.slice(0, MERGED_ANSWER_LEN - 1)}…`
					: content.answer
				: undefined;
		const item: Record<string, unknown> = { tool: tool_slug, query: query.length > 80 ? `${query.slice(0, 77)}…` : query };
		if (answer !== undefined) item.answer = answer;
		if (content.citations.length > 0) item.citations = content.citations;
		if (answer === undefined && content.citations.length === 0) item.result = compacted;
		items.push(item);
	}

	const out: Record<string, unknown> = { data: { results: items } };
	if (errors.length > 0) (out.data as Record<string, unknown>).errors = errors;
	if (skipped.length > 0) (out.data as Record<string, unknown>).skipped = skipped;
	const timeInfo = data?.time_info;
	if (timeInfo !== null && typeof timeInfo === "object" && typeof (timeInfo as Record<string, unknown>).current_time_utc === "string") {
		(out.data as Record<string, unknown>).time_info = { current_time_utc: (timeInfo as Record<string, unknown>).current_time_utc };
	}
	let text = JSON.stringify(out);
	if (text.length > MAX_SEARCH_TEXT) {
		text = `${text.slice(0, MAX_SEARCH_TEXT)}\n…(output truncated, total ${text.length} chars)`;
	}
	return text;
}

function searchContext(value: unknown): SearchCompactionContext {
	const connected = new Set<string>();
	const usableSlugs = new Set<string>();
	const usedSlugs = new Set<string>();
	const data = (value as { data?: { toolkit_connection_statuses?: unknown; tool_schemas?: unknown; results?: unknown } })?.data;
	const statuses = data?.toolkit_connection_statuses;
	if (Array.isArray(statuses)) {
		for (const t of statuses) {
			if (t === null || typeof t !== "object") continue;
			const d = t as Record<string, unknown>;
			if (typeof d.toolkit === "string" && d.has_active_connection === true) connected.add(d.toolkit.toLowerCase());
		}
	}
	const schemas = data?.tool_schemas;
	if (schemas !== null && typeof schemas === "object") {
		for (const [slug, def] of Object.entries(schemas as Record<string, unknown>)) {
			if (def === null || typeof def !== "object") continue;
			const tk = (def as Record<string, unknown>).toolkit;
			if (typeof tk === "string" && connected.has(tk.toLowerCase())) usableSlugs.add(slug);
		}
	}
	const results = data?.results;
	if (Array.isArray(results)) {
		for (const r of results) {
			if (r === null || typeof r !== "object") continue;
			const prim = (r as Record<string, unknown>).primary_tool_slugs;
			if (Array.isArray(prim)) for (const s of prim) if (typeof s === "string") usedSlugs.add(s);
		}
	}
	return { connected, usableSlugs, usedSlugs };
}

function compactSearchJson(value: unknown): unknown {
	return compactSearchJsonInner(value, searchContext(value));
}

function compactSearchJsonInner(value: unknown, ctx: SearchCompactionContext): unknown {
	if (Array.isArray(value)) {
		const items = value.map((v) => compactSearchJsonInner(v, ctx)).filter((v) => v !== undefined && v !== null);
		if (value.length > MAX_ITEMS) {
			return [items.slice(0, MAX_ITEMS), `…${value.length - MAX_ITEMS} more item(s) omitted`];
		}
		return items;
	}
	if (value !== null && typeof value === "object") {
		const out: Record<string, unknown> = {};
		const filterByConnection = ctx.connected.size > 0; // only filter when we know connections
		for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
			if (NOISE_KEYS.has(k) || CONTENT_BLOAT_KEYS.has(k) || SEARCH_META_KEYS.has(k)) continue;
			if (k === "use_case" && typeof v === "string") {
				// echo of the query the model itself sent — shrink to a label
				out.query = v.length > 80 ? `${v.slice(0, 77)}…` : v;
				continue;
			}
			if (k === "recommended_plan_steps" && Array.isArray(v)) {
				const steps = v
					.slice(0, SEARCH_MAX_PLAN_STEPS)
					.map((s) => (typeof s === "string" && s.length > SEARCH_STEP_LEN ? `${s.slice(0, SEARCH_STEP_LEN - 1)}…` : s));
				if (v.length > SEARCH_MAX_PLAN_STEPS) steps.push(`…${v.length - SEARCH_MAX_PLAN_STEPS} more step(s) omitted`);
				out[k] = steps;
				continue;
			}
			if (k === "tool_schemas" && v !== null && typeof v === "object") {
				// keep slug -> short description for the tools the plan actually uses
				// (primary slugs, connected). Drop everything else: descriptions are
				// deduped across calls by execute() anyway.
				const schemas: Record<string, unknown> = {};
				for (const [slug, def] of Object.entries(v as Record<string, unknown>)) {
					if (def === null || typeof def !== "object") continue;
					if (filterByConnection && !ctx.usableSlugs.has(slug)) continue;
					if (ctx.usedSlugs.size > 0 && !ctx.usedSlugs.has(slug)) continue;
					const desc = (def as Record<string, unknown>).description;
					schemas[slug] = typeof desc === "string" ? (desc.length > 90 ? `${desc.slice(0, 89)}…` : desc) : true;
				}
				if (Object.keys(schemas).length > 0) out[k] = schemas;
				continue;
			}
			if (k === "toolkit_connection_statuses" && Array.isArray(v)) {
				// keep toolkit + connection state; status_message is boilerplate
				// (and its "call MANAGE_CONNECTIONS" CTA is dead — the tool is gone).
				// Unconnected toolkits are dropped: their tools cannot run either.
				const kept = v
					.map((t) => {
						if (t === null || typeof t !== "object") return undefined;
						const d = t as Record<string, unknown>;
						if (filterByConnection && !(typeof d.toolkit === "string" && ctx.connected.has(d.toolkit.toLowerCase()))) {
							return undefined;
						}
						const slim: Record<string, unknown> = {};
						for (const key of ["toolkit", "has_active_connection"]) if (d[key] !== undefined) slim[key] = d[key];
						return slim;
					})
					.filter((x) => x !== undefined && x !== null);
				if (kept.length > 0) out[k] = kept;
				continue;
			}
			if ((k === "primary_tool_slugs") && Array.isArray(v)) {
				// keep only slugs that can actually run right now
				const kept = v.filter((s): s is string => typeof s === "string" && (!filterByConnection || ctx.usableSlugs.has(s)));
				if (kept.length > 0) out[k] = kept;
				continue;
			}
			if (k === "related_tool_slugs" || k === "toolkits") {
				// secondary suggestions + toolkit list are redundant: schemas cover the
				// used tools and connection statuses already list available toolkits
				continue;
			}
			if (k === "time_info" && v !== null && typeof v === "object") {
				// keep the clock, drop the static "use UTC / do not hallucinate" essay
				const d = v as Record<string, unknown>;
				const slim: Record<string, unknown> = {};
				if (typeof d.current_time_utc === "string") slim.current_time_utc = d.current_time_utc;
				slim.note = "use UTC for relative-time params";
				out[k] = slim;
				continue;
			}
			if (k === "description" && typeof v === "string" && v.length > MAX_DESC) {
				out[k] = `${v.slice(0, MAX_DESC - 1)}…`;
				continue;
			}
			const cv = compactSearchJsonInner(v, ctx);
			if (cv !== undefined && cv !== null) out[k] = cv;
		}
		return out;
	}
	if (typeof value === "string") {
		return value.length > MAX_STR ? `${value.slice(0, MAX_STR - 1)}…` : value;
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
	// Compacted tool_schemas repeat across search calls in one session (same tool set
	// ⇒ same blob). Keep the most recent blobs per session so recurring sets hit.
	const toolSchemasCache = new Map<string, string[]>();
	const TOOL_SCHEMAS_CACHE_DEPTH = 3;

	for (const def of TOOLS) {
		const name = def.name.toLowerCase();

		pi.registerTool({
			name,
			description: def.description,
			promptSnippet: "Composio: 500+ external app integrations",
			promptGuidelines: [
				"Prefer execute: true on composio_search for straightforward lookups; use plan mode for multi-source research. Never invent tool slugs.",
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
									// wrap the one-line summary to the terminal width instead of overflowing
									state.lines = truncateToVisualLines(capped, 1_000_000, width).visualLines;
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
							return ["", ...(state.lines ?? []), hint];
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

			async execute(_toolCallId, params, signal, onUpdate, ctx) {
				if (!client) client = new ComposioMCPClient((await loadApiKey()) ?? "");
				onUpdate?.({ content: [{ type: "text", text: `Running ${def.name}…` }] });
				const mcpName = def.mcpName ?? def.name;

				if (def.mcpName === MCP_SEARCH_TOOL && params.execute === true) {
					// merged one-shot mode: search + auto-run the plan, return content only
					onUpdate?.({ content: [{ type: "text", text: "Searching + executing plan…" }] });
					const { execute: _execute, ...searchParams } = params;
					const searchResult = await client.callTool(mcpName, searchParams, signal);
					if (searchResult.isError) throw new Error(extractResultText(searchResult) || `${def.name} failed`);
					const searchText = extractResultText(searchResult);
					const searchJson = tryPrettyPrintJson(searchText);
					if (!searchJson) return { content: [{ type: "text", text: searchText }], details: { tool: def.name } };
					return {
						content: [{ type: "text", text: await runSearchPlan(client, searchJson.parsed, signal) }],
						details: { tool: def.name },
					};
				}

				const result = await client.callTool(mcpName, params, signal);
				if (result.isError) throw new Error(extractResultText(result) || `${def.name} failed`);
				let text = extractResultText(result);
				const json = tryPrettyPrintJson(text);
				const isSearch = def.mcpName === MCP_SEARCH_TOOL;
				const compactor = isSearch ? compactSearchJson : compactExecuteJson;
				if (json) {
					const parsed = json.parsed as { data?: { tool_schemas?: Record<string, unknown> } };
					const rawSchemas = parsed.data?.tool_schemas;
					const compacted = compactor(parsed) as { data?: { tool_schemas?: unknown } };
					text = JSON.stringify(compacted);
					// Tool schemas are identical across search calls in a session — send them
					// once, then reference the previous blob instead of repeating it.
					if (isSearch && rawSchemas && typeof rawSchemas === "object") {
						// Signature from the compacted blob: deterministic given the tool set,
						// so volatile fields composio may add to raw schemas never break hits.
						const blob = JSON.stringify(compacted.data?.tool_schemas);
						const session = ctx.sessionManager?.getSessionId() ?? "";
						const recent = toolSchemasCache.get(session) ?? [];
						if (recent.includes(blob)) {
							if (compacted.data) compacted.data.tool_schemas = "unchanged from previous search call";
							text = JSON.stringify(compacted);
						} else {
							recent.push(blob);
							if (recent.length > TOOL_SCHEMAS_CACHE_DEPTH) recent.shift();
							toolSchemasCache.set(session, recent);
						}
					}
				}
				const cap = isSearch ? MAX_SEARCH_TEXT : MAX_TEXT_LENGTH;
				if (text.length > cap) {
					text = `${text.slice(0, cap)}\n…(output truncated, total ${text.length} chars)`;
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
