/**
 * Zed Cloud provider for pi.
 *
 * Speaks the zed.dev LLM protocol directly (cloud.zed.dev), ported from the
 * zedproxy Go project (SPEC.md). No proxy process required.
 *
 * - Auth: native-app OAuth sign-in (RSA-2048 + loopback callback), same flow
 *   as the Zed desktop client. Run `/login zed` and pick "Sign in with Zed";
 *   logout with `/logout`.
 * - Models: auto-detected from GET /models on startup and refreshed
 *   periodically (30 min) or via `/zed refresh`.
 * - Balance: check remaining plan usage with `/zed status` or `/zed usage`
 *   (model_requests / edit_predictions from GET /client/users/me).
 *
 * Commands:
 *   /login zed          OAuth sign-in (browser)
 *   /logout             remove stored zed credential
 *   /zed refresh        force model-list refresh
 *   /zed status         show login/model/usage summary
 *   /zed usage          fetch fresh usage + balance
 *   /zed help           this help
 */

import {
	calculateCost,
	createAssistantMessageEventStream,
	type Api,
	type AssistantMessage,
	type AssistantMessageEventStream,
	type Context,
	type ImageContent,
	type Message,
	type Model,
	type OAuthCredentials,
	type OAuthLoginCallbacks,
	type SimpleStreamOptions,
	type StopReason,
	type TextContent,
	type ThinkingContent,
	type Tool,
	type ToolCall,
	type ToolResultMessage,
} from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext, ProviderModelConfig } from "@earendil-works/pi-coding-agent";
import { constants, generateKeyPairSync, privateDecrypt, randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { homedir } from "node:os";
import { join } from "node:path";
import { readFile } from "node:fs/promises";

// =============================================================================
// Constants
// =============================================================================

const CLOUD_URL = "https://cloud.zed.dev";
const SIGN_IN_PAGE = "https://zed.dev/native_app_signin";
const SUCCESS_PAGE = "https://zed.dev/native_app_signin_succeeded";
const ZED_VERSION = "0.180.0";
const USER_AGENT = `Zed/${ZED_VERSION}`;
const PROVIDER_ID = "zed";
const LOGIN_TIMEOUT_MS = 5 * 60 * 1000;
const MODEL_REFRESH_MS = 30 * 60 * 1000;

// =============================================================================
// Types
// =============================================================================

/** Raw zed cloud credential + per-install ids (extras carried in OAuthCredentials). */
interface ZedCred {
	uid: number;
	org: string;
	token: string;
	systemId: string;
}

/** Per-model facts from /models, used by the streaming layer. */
interface ZedModelMeta {
	family: "anthropic" | "open_ai" | "google";
	supportsThinking: boolean;
	supportsDisablingThinking: boolean;
}

interface ZedJwt {
	token: string;
	expiresAt: number;
}

interface PlanUsage {
	plan_v3?: string;
	plan_v2?: string;
	plan?: string;
	usage?: {
		model_requests?: { used?: number; limit?: number | string | { limited?: number } };
		edit_predictions?: { used?: number; limit?: number | string | { limited?: number } };
	};
	has_overdue_invoices?: boolean;
}

function agentDir(): string {
	const envDir = process.env.PI_CODING_AGENT_DIR;
	return envDir ? envDir.replace(/^~\//, `${homedir()}/`) : join(homedir(), ".pi", "agent");
}

/** Read the stored zed credential directly from pi's auth.json (factory-time). */
async function readStoredCredential(): Promise<ZedCred | undefined> {
	try {
		const raw = await readFile(join(agentDir(), "auth.json"), "utf8");
		const data = JSON.parse(raw) as Record<string, unknown>;
		return credFromStored(data[PROVIDER_ID]);
	} catch {
		return undefined;
	}
}

// =============================================================================
// Module state
// =============================================================================

const jwtCache: ZedJwt = { token: "", expiresAt: 0 };
const modelMeta = new Map<string, ZedModelMeta>();
let lastModels: ProviderModelConfig[] = [];

// =============================================================================
// Small helpers
// =============================================================================

const sanitize = (s: string) => s.replace(/[\uD800-\uDFFF]/g, "\uFFFD");

function b64url(buf: Buffer): string {
	return Buffer.from(buf).toString("base64url");
}

function hasKeys(o: unknown): o is Record<string, unknown> {
	return typeof o === "object" && o !== null && Object.keys(o).length > 0;
}

/** Normalize a zed usage-limit value to {used, limit, unlimited}. */
function normLimit(data?: { used?: number; limit?: number | string | { limited?: number } }):
	| { used: number; limit: number; unlimited: boolean }
	| undefined {
	if (!data) return undefined;
	let limit = 0;
	let unlimited = false;
	if (typeof data.limit === "number") limit = data.limit;
	else if (typeof data.limit === "string" && data.limit === "unlimited") unlimited = true;
	else if (typeof data.limit === "object" && data.limit !== null) limit = data.limit.limited ?? 0;
	return { used: data.used ?? 0, limit, unlimited };
}

function contentToText(content: string | (TextContent | ImageContent)[]): string {
	if (typeof content === "string") return content;
	return content.map((b) => (b.type === "text" ? b.text : "[image]")).join("\n");
}

function schemaOf(tool: Tool): Record<string, unknown> {
	const p = tool.parameters as unknown as { properties?: unknown; required?: unknown };
	return { type: "object", properties: p.properties ?? {}, required: p.required ?? [] };
}

function routeFor(model: string): ZedModelMeta["family"] | undefined {
	if (model.startsWith("claude-")) return "anthropic";
	if (model.startsWith("gpt-") || model.startsWith("o1") || model.startsWith("o3") || model.startsWith("o4")) return "open_ai";
	if (model.startsWith("gemini-")) return "google";
	return undefined;
}

function metaFor(modelId: string): ZedModelMeta {
	const family = routeFor(modelId);
	const known = modelMeta.get(modelId);
	return {
		family: family ?? "anthropic",
		supportsThinking: known?.supportsThinking ?? false,
		supportsDisablingThinking: known?.supportsDisablingThinking ?? true,
	};
}

// =============================================================================
// Credential plumbing
// =============================================================================

/** getApiKey packs uid/org/token into one opaque string; streamSimple parses it. */
function packCredential(cred: ZedCred): string {
	return JSON.stringify({ uid: cred.uid, org: cred.org, token: cred.token, systemId: cred.systemId });
}

function unpackCredential(s: string | undefined): ZedCred | undefined {
	if (!s) return undefined;
	try {
		const o = JSON.parse(s) as Partial<ZedCred>;
		if (typeof o.uid === "number" && typeof o.org === "string" && o.org && typeof o.token === "string" && o.token && typeof o.systemId === "string") {
			return { uid: o.uid, org: o.org, token: o.token, systemId: o.systemId };
		}
	} catch {
		// not our wrapper
	}
	return undefined;
}

/** Extract ZedCred from a stored pi credential (refreshModels context). */
function credFromStored(credential: unknown): ZedCred | undefined {
	const c = credential as { type?: string; access?: unknown; key?: unknown; zed_user_id?: unknown; zed_org_id?: unknown; zed_system_id?: unknown } | undefined;
	if (!c) return undefined;
	if (c.type === "oauth" && c.access) {
		if (typeof c.zed_user_id === "number" && typeof c.zed_org_id === "string" && typeof c.zed_system_id === "string") {
			return { uid: c.zed_user_id, org: c.zed_org_id, token: c.access as string, systemId: c.zed_system_id };
		}
	}
	if (typeof c.key === "string") return unpackCredential(c.key);
	return undefined;
}

// =============================================================================
// JWT minting (llm_tokens) with cache
// =============================================================================

function jwtExpiryMs(jwt: string): number {
	try {
		const payload = JSON.parse(Buffer.from((jwt.split(".")[1] ?? "").replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8")) as { exp?: number };
		if (typeof payload.exp === "number" && payload.exp > 0) return payload.exp * 1000 - 5 * 60 * 1000;
	} catch {
		// fall through
	}
	return Date.now() + 55 * 60 * 1000;
}

function invalidateJwt(): void {
	jwtCache.token = "";
	jwtCache.expiresAt = 0;
}

async function mintJwt(cred: ZedCred, signal?: AbortSignal): Promise<string> {
	if (jwtCache.token && jwtCache.expiresAt > Date.now() + 60_000) return jwtCache.token;
	const res = await fetch(`${CLOUD_URL}/client/llm_tokens`, {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			Authorization: `${cred.uid} ${cred.token}`,
			"x-zed-system-id": cred.systemId,
			"User-Agent": USER_AGENT,
		},
		body: JSON.stringify({ organization_id: cred.org }),
		signal,
	});
	if (!res.ok) throw new Error(`Zed: llm_tokens ${res.status}: ${(await res.text()).slice(0, 300)}`);
	const data = (await res.json()) as { token?: string };
	if (!data.token) throw new Error("Zed: llm_tokens returned no token");
	jwtCache.token = data.token;
	jwtCache.expiresAt = jwtExpiryMs(data.token);
	return data.token;
}

async function zedFetchJwt(path: string, cred: ZedCred, signal?: AbortSignal): Promise<Response> {
	const doFetch = () =>
		fetch(`${CLOUD_URL}${path}`, {
			headers: { Authorization: `Bearer ${jwtCache.token}`, "User-Agent": USER_AGENT },
			signal,
		});
	let res = await doFetch();
	if (res.status === 401) {
		invalidateJwt();
		await mintJwt(cred, signal);
		res = await doFetch();
	}
	return res;
}

// =============================================================================
// Model discovery (GET /models)
// =============================================================================

interface ZedModel {
	id?: unknown;
	provider?: unknown;
	display_name?: unknown;
	max_token_count?: unknown;
	max_output_tokens?: unknown;
	supports_tools?: unknown;
	supports_images?: unknown;
	supports_thinking?: unknown;
	supports_disabling_thinking?: unknown;
	is_disabled?: unknown;
}

async function fetchZedModels(cred: ZedCred, signal?: AbortSignal, force = false): Promise<ProviderModelConfig[]> {
	// Respect the server-side models TTL unless force-refreshed.
	if (!force && lastModels.length > 0 && modelMeta.size > 0) return lastModels;
	await mintJwt(cred, signal);
	const res = await zedFetchJwt("/models", cred, signal);
	if (!res.ok) throw new Error(`Zed: models ${res.status}: ${(await res.text()).slice(0, 300)}`);
	const data = (await res.json()) as { models?: ZedModel[] };
	const out: ProviderModelConfig[] = [];
	for (const m of data.models ?? []) {
		const id = typeof m.id === "string" && m.id ? m.id : undefined;
		if (!id || m.is_disabled === true) continue;
		const family = routeFor(id);
		if (!family) continue;
		const supportsThinking = m.supports_thinking === true;
		const supportsDisablingThinking = m.supports_disabling_thinking !== false;
		const supportsImages = m.supports_images === true;
		modelMeta.set(id, { family, supportsThinking, supportsDisablingThinking });
		out.push({
			id,
			name: typeof m.display_name === "string" && m.display_name ? m.display_name : id,
			reasoning: supportsThinking,
			input: supportsImages ? ["text", "image"] : ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: typeof m.max_token_count === "number" && m.max_token_count > 0 ? m.max_token_count : 200_000,
			maxTokens: typeof m.max_output_tokens === "number" && m.max_output_tokens > 0 ? m.max_output_tokens : 4096,
		});
	}
	lastModels = out;
	return out;
}

// =============================================================================
// Usage / balance (GET /client/users/me) — shown by /zed status and /zed usage
// =============================================================================

async function fetchPlan(cred: ZedCred, signal?: AbortSignal): Promise<{ name?: string; plan?: PlanUsage } | undefined> {
	const res = await fetch(`${CLOUD_URL}/client/users/me`, {
		headers: { Authorization: `${cred.uid} ${cred.token}`, "x-zed-system-id": cred.systemId, "User-Agent": USER_AGENT },
		signal,
	});
	if (!res.ok) return undefined;
	const data = (await res.json()) as { user?: { name?: string; username?: string }; plan?: PlanUsage };
	return { name: data.user?.name ?? data.user?.username, plan: data.plan };
}

function formatPlan(plan?: PlanUsage): string | undefined {
	const usage = plan?.usage;
	if (!usage) return undefined;
	const parts: string[] = [];
	const ep = normLimit(usage.edit_predictions);
	const mr = normLimit(usage.model_requests);
	if (ep) parts.push(`ep ${ep.used}/${ep.unlimited ? "unl" : ep.limit}`);
	if (mr && mr.limit > 0) parts.push(`mr ${mr.used}/${mr.limit}`);
	if (parts.length === 0) return undefined;
	const planName = plan.plan_v3 ?? plan.plan_v2 ?? plan.plan;
	const label = typeof planName === "string" && planName ? planName.replace(/^zed_/, "z-") : "";
	const overdue = plan.has_overdue_invoices ? " · overdue" : "";
	return `${label ? label + " · " : ""}${parts.join(" · ")}${overdue}`;
}

// =============================================================================
// OAuth login (native-app browser flow)
// =============================================================================

async function zedOAuthLogin(callbacks: OAuthLoginCallbacks): Promise<OAuthCredentials> {
	const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
	const pubB64 = b64url(publicKey.export({ type: "pkcs1", format: "der" }) as Buffer);
	const systemId = randomUUID();

	let resolveCb: ((creds: { uid: number; token: string }) => void) | undefined;
	let rejectCb: ((err: Error) => void) | undefined;

	const server = createServer((req, res) => {
		const url = new URL(req.url ?? "/", "http://127.0.0.1");
		const uid = url.searchParams.get("user_id");
		const enc = url.searchParams.get("access_token");
		if (!uid || !enc) {
			res.writeHead(400).end("missing user_id or access_token");
			return;
		}
		let ct: Buffer;
		try {
			ct = Buffer.from(enc.replace(/-/g, "+").replace(/_/g, "/"), "base64");
		} catch {
			res.writeHead(400).end("bad access_token encoding");
			return;
		}
		let plain: Buffer;
		try {
			plain = privateDecrypt({ key: privateKey, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: "sha256" }, ct);
		} catch {
			res.writeHead(400).end("cannot decrypt access_token");
			return;
		}
		res.writeHead(302, { Location: SUCCESS_PAGE }).end();
		resolveCb?.({ uid: Number(uid), token: plain.toString("utf8") });
	});

	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", resolve);
	});
	const address = server.address();
	const port = typeof address === "object" && address ? address.port : 0;

	const params = new URLSearchParams({
		native_app_port: String(port),
		native_app_public_key: pubB64,
		system_id: systemId,
	});
	callbacks.onAuth({ url: `${SIGN_IN_PAGE}?${params.toString()}` });

	const got = await new Promise<{ uid: number; token: string }>((resolve, reject) => {
		resolveCb = resolve;
		rejectCb = reject;
		const timer = setTimeout(() => reject(new Error("Zed sign-in timed out (5 min)")), LOGIN_TIMEOUT_MS);
		server.on("close", () => clearTimeout(timer));
	});
	server.close();
	if (!Number.isInteger(got.uid) || got.uid <= 0) throw new Error("Zed sign-in returned an invalid user_id");

	// Resolve the default organization and verify the credential.
	const me = await fetchPlan({ uid: got.uid, org: "", token: got.token, systemId }, undefined);
	if (!me || !me.plan) throw new Error("Zed: credential rejected by cloud.zed.dev");
	const meData = await (async () => {
		const res = await fetch(`${CLOUD_URL}/client/users/me`, {
			headers: { Authorization: `${got.uid} ${got.token}`, "x-zed-system-id": systemId, "User-Agent": USER_AGENT },
		});
		return res.ok ? ((await res.json()) as { default_organization_id?: string; organizations?: { id?: string }[] }) : undefined;
	})();
	const org = meData?.default_organization_id ?? meData?.organizations?.[0]?.id;
	if (!org) throw new Error("Zed: no organization found for account");

	// Zed's access token is long-lived (the JWT is what expires), so the
	// credential never needs pi's refresh path.
	const expires = Date.now() + 10 * 365 * 24 * 60 * 60 * 1000;
	return {
		refresh: got.token,
		access: got.token,
		expires,
		zed_user_id: got.uid,
		zed_org_id: org,
		zed_system_id: systemId,
	};
}

// =============================================================================
// Message / tool conversion (pi -> provider wire format)
// =============================================================================

function anthropicUserContent(content: string | (TextContent | ImageContent)[]): unknown[] {
	if (typeof content === "string") return content.trim() ? [{ type: "text", text: sanitize(content) }] : [];
	const blocks: unknown[] = [];
	for (const b of content) {
		if (b.type === "text" && b.text) blocks.push({ type: "text", text: sanitize(b.text) });
		else if (b.type === "image") blocks.push({ type: "image", source: { type: "base64", media_type: b.mimeType, data: b.data } });
	}
	return blocks;
}

function anthropicAssistantBlocks(content: AssistantMessage["content"]): unknown[] {
	const blocks: unknown[] = [];
	for (const b of content) {
		if (b.type === "text" && b.text) blocks.push({ type: "text", text: sanitize(b.text) });
		else if (b.type === "thinking" && b.thinking) {
			if ((b as ThinkingContent).thinkingSignature) blocks.push({ type: "thinking", thinking: sanitize(b.thinking), signature: (b as ThinkingContent).thinkingSignature });
			else blocks.push({ type: "text", text: sanitize(b.thinking) });
		} else if (b.type === "toolCall") blocks.push({ type: "tool_use", id: b.id, name: b.name, input: b.arguments ?? {} });
	}
	return blocks;
}

function buildAnthropicBody(model: Model<Api>, context: Context, options: SimpleStreamOptions | undefined, meta: ZedModelMeta): Record<string, unknown> {
	const messages: unknown[] = [];
	for (let i = 0; i < context.messages.length; i++) {
		const m = context.messages[i];
		if (m.role === "user") {
			const content = anthropicUserContent(m.content);
			if (content.length) messages.push({ role: "user", content });
		} else if (m.role === "assistant") {
			const blocks = anthropicAssistantBlocks(m.content);
			if (blocks.length) messages.push({ role: "assistant", content: blocks });
		} else if (m.role === "toolResult") {
			// Group consecutive tool results into one user message.
			const results: unknown[] = [];
			let j = i;
			while (j < context.messages.length && context.messages[j].role === "toolResult") {
				const tr = context.messages[j] as ToolResultMessage;
				results.push({ type: "tool_result", tool_use_id: tr.toolCallId, content: contentToText(tr.content), is_error: tr.isError });
				j++;
			}
			i = j - 1;
			messages.push({ role: "user", content: results });
		}
	}

	const body: Record<string, unknown> = {
		model: model.id,
		max_tokens: options?.maxTokens || 4096,
		stream: true,
		messages,
	};
	if (context.systemPrompt) body.system = sanitize(context.systemPrompt);
	if (context.tools?.length) body.tools = context.tools.map((t) => ({ name: t.name, description: t.description, input_schema: schemaOf(t) }));
	if (typeof options?.temperature === "number") body.temperature = Math.min(1, Math.max(0, options.temperature));

	const thinkingOn = meta.supportsThinking && (!!options?.reasoning || !meta.supportsDisablingThinking);
	if (thinkingOn) {
		const budgets: Record<string, number> = { minimal: 1024, low: 4096, medium: 10_240, high: 20_480, xhigh: 20_480, max: 20_480 };
		const level = options?.reasoning;
		const requested =
			(level && (options?.thinkingBudgets as Record<string, number> | undefined)?.[level]) || (level ? budgets[level] : budgets.medium) || 10_240;
		const maxTokens = (body.max_tokens as number) < 2048 ? 2048 : (body.max_tokens as number);
		const budget = Math.max(1024, Math.min(requested, maxTokens - 1024));
		body.max_tokens = maxTokens;
		body.thinking = { type: "enabled", budget_tokens: budget };
	}
	return body;
}

function responsesItems(context: Context): unknown[] {
	const items: unknown[] = [];
	if (context.systemPrompt) items.push({ type: "message", role: "system", content: [{ type: "input_text", text: sanitize(context.systemPrompt) }] });
	for (const m of context.messages) {
		if (m.role === "user") {
			const content = (typeof m.content === "string" ? [{ type: "text" as const, text: m.content }] : m.content).map((b) =>
				b.type === "text"
					? { type: "input_text", text: sanitize(b.text) }
					: { type: "input_image", image_url: `data:${b.mimeType};base64,${b.data}` },
			);
			if (content.length) items.push({ type: "message", role: "user", content });
		} else if (m.role === "assistant") {
			const textParts: unknown[] = [];
			const calls: unknown[] = [];
			for (const b of m.content) {
				// Reasoning (thinking) items are not replayed for the Responses
				// API: the server re-derives them and rejects replayed
				// encrypted_content unless the client did the key exchange.
				if (b.type === "text" && b.text) textParts.push({ type: "output_text", text: sanitize(b.text) });
				else if (b.type === "toolCall") calls.push({ type: "function_call", call_id: b.id, name: b.name, arguments: JSON.stringify(b.arguments ?? {}) });
			}
			if (textParts.length) items.push({ type: "message", role: "assistant", content: textParts });
			for (const c of calls) items.push(c);
		} else if (m.role === "toolResult") {
			items.push({ type: "function_call_output", call_id: m.toolCallId, output: contentToText(m.content) });
		}
	}
	return items;
}

function buildResponsesBody(model: Model<Api>, context: Context, options: SimpleStreamOptions | undefined, meta: ZedModelMeta): Record<string, unknown> {
	const body: Record<string, unknown> = {
		model: model.id,
		stream: true,
		max_output_tokens: options?.maxTokens || 4096,
		input: responsesItems(context),
	};
	if (context.tools?.length) body.tools = context.tools.map((t) => ({ type: "function", name: t.name, description: t.description, parameters: schemaOf(t) }));
	// Reasoning-effort models reject temperature; let defaults apply.
	if (meta.supportsThinking && /^(o1|o3|o4|gpt-5)/.test(model.id)) {
		// goai-compatible: request the encrypted reasoning stream plus the
		// plaintext summary, which arrives as reasoning_summary_text deltas.
		body.store = false;
		body.include = ["reasoning.encrypted_content"];
		const reasoning: Record<string, unknown> = { summary: "auto" };
		if (options?.reasoning) {
			reasoning.effort = options.reasoning === "minimal" || options.reasoning === "low" ? "low" : options.reasoning === "medium" ? "medium" : "high";
		}
		body.reasoning = reasoning;
	}
	return body;
}

function googleContents(context: Context): unknown[] {
	const contents: unknown[] = [];
	for (const m of context.messages) {
		if (m.role === "user") {
			const parts = (typeof m.content === "string" ? [{ type: "text" as const, text: m.content }] : m.content).map((b) =>
				b.type === "text" ? { text: sanitize(b.text) } : { inlineData: { mimeType: b.mimeType, data: b.data } },
			);
			if (parts.length) contents.push({ role: "user", parts });
		} else if (m.role === "assistant") {
			const parts: unknown[] = [];
			for (const b of m.content) {
				if (b.type === "text" && b.text) {
					const textPart: Record<string, unknown> = { text: sanitize(b.text) };
					if ((b as TextContent).textSignature) textPart.thoughtSignature = (b as TextContent).textSignature;
					parts.push(textPart);
				} else if (b.type === "toolCall") {
					const fc: Record<string, unknown> = { name: b.name, args: b.arguments ?? {} };
					const fcPart: Record<string, unknown> = { functionCall: fc };
					if (b.thoughtSignature) fcPart.thoughtSignature = b.thoughtSignature;
					parts.push(fcPart);
				}
			}
			if (parts.length) contents.push({ role: "model", parts });
		} else if (m.role === "toolResult") {
			contents.push({ role: "user", parts: [{ functionResponse: { name: m.toolName, response: { result: contentToText(m.content) } } }] });
		}
	}
	return contents;
}

function buildGoogleBody(model: Model<Api>, context: Context, options: SimpleStreamOptions | undefined, meta: ZedModelMeta): Record<string, unknown> {
	const body: Record<string, unknown> = {
		contents: googleContents(context),
		generationConfig: {},
	};
	if (context.systemPrompt) body.systemInstruction = { parts: [{ text: sanitize(context.systemPrompt) }] };
	if (context.tools?.length) {
		body.tools = [{ functionDeclarations: context.tools.map((t) => ({ name: t.name, description: t.description, parameters: schemaOf(t) })) }];
	}
	const gc = body.generationConfig as Record<string, unknown>;
	if (typeof options?.maxTokens === "number") gc.maxOutputTokens = options.maxTokens;
	else gc.maxOutputTokens = 4096;
	if (typeof options?.temperature === "number") gc.temperature = options.temperature;
	if (meta.supportsThinking && options?.reasoning) {
		const level = options.reasoning === "minimal" || options.reasoning === "low" ? "LOW" : options.reasoning === "medium" ? "MEDIUM" : "HIGH";
		gc.thinkingConfig = { thinkingLevel: level };
	}
	return body;
}

// =============================================================================
// NDJSON reading
// =============================================================================

async function readNdjson(res: Response, onLine: (ev: Record<string, unknown>) => void): Promise<void> {
	const reader = res.body?.getReader();
	if (!reader) return;
	const decoder = new TextDecoder();
	let buf = "";
	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		buf += decoder.decode(value, { stream: true });
		let nl: number;
		while ((nl = buf.indexOf("\n")) >= 0) {
			const line = buf.slice(0, nl).trim();
			buf = buf.slice(nl + 1);
			if (!line) continue;
			let obj: Record<string, unknown>;
			try {
				obj = JSON.parse(line) as Record<string, unknown>;
			} catch {
				// non-JSON status lines are dropped
				continue;
			}
			// Zed may wrap events as {"event":{...}} when client-support
			// headers are negotiated; unwrap defensively.
			onLine((obj.event as Record<string, unknown> | undefined) ?? obj);
		}
	}
}

function updateUsage(model: Model<Api>, output: AssistantMessage, input: number, outputT: number, cacheRead: number, cacheWrite: number): void {
	output.usage.input = input;
	output.usage.output = outputT;
	output.usage.cacheRead = cacheRead;
	output.usage.cacheWrite = cacheWrite;
	output.usage.totalTokens = input + outputT + cacheRead + cacheWrite;
	calculateCost(model, output.usage);
}

// =============================================================================
// Per-family stream parsers
// =============================================================================

interface StreamCtx {
	model: Model<Api>;
	output: AssistantMessage;
	stream: AssistantMessageEventStream;
	tools?: Tool[];
}

/** Content block with streaming bookkeeping attached during parsing. */
type WireBlock = {
	type?: "text" | "thinking" | "toolCall";
	index?: number;
	partialJson?: string;
	id?: string;
	name?: string;
	arguments?: Record<string, unknown>;
	text?: string;
	thinking?: string;
	thinkingSignature?: string;
	textSignature?: string;
	thoughtSignature?: string;
	[key: string]: unknown;
};

function pushWire(output: AssistantMessage, block: WireBlock): void {
	output.content.push(block as unknown as TextContent | ThinkingContent | ToolCall);
}

function mapStopReason(reason: string): StopReason {
	switch (reason) {
		case "end_turn":
		case "stop_sequence":
		case "stop":
			return "stop";
		case "max_tokens":
		case "MAX_TOKENS":
			return "length";
		case "tool_use":
			return "toolUse";
		default:
			return "stop";
	}
}

async function parseAnthropic(res: Response, ctx: StreamCtx): Promise<void> {
	const { output, stream } = ctx;
	const blocks = output.content as unknown as WireBlock[];
	await readNdjson(res, (ev) => {
		switch (ev.type) {
			case "message_start": {
				const u = (ev.message as { usage?: Record<string, number> } | undefined)?.usage;
				updateUsage(ctx.model, output, u?.input_tokens ?? 0, u?.output_tokens ?? 0, u?.cache_read_input_tokens ?? 0, u?.cache_creation_input_tokens ?? 0);
				break;
			}
			case "content_block_start": {
				const cb = ev.content_block as { type?: string; id?: string; name?: string; input?: unknown; thinking?: string } | undefined;
				if (!cb) break;
				if (cb.type === "text") {
					pushWire(output, { type: "text", text: "", index: ev.index as number });
					stream.push({ type: "text_start", contentIndex: output.content.length - 1, partial: output });
				} else if (cb.type === "thinking") {
					pushWire(output, { type: "thinking", thinking: cb.thinking ?? "", thinkingSignature: "", index: ev.index as number });
					stream.push({ type: "thinking_start", contentIndex: output.content.length - 1, partial: output });
				} else if (cb.type === "tool_use") {
					const block: WireBlock = {
						type: "toolCall",
						id: cb.id ?? "",
						name: cb.name ?? "",
						arguments: hasKeys(cb.input) ? (cb.input as Record<string, unknown>) : {},
						partialJson: hasKeys(cb.input) ? JSON.stringify(cb.input) : "",
						index: ev.index as number,
					};
					pushWire(output, block);
					stream.push({ type: "toolcall_start", contentIndex: output.content.length - 1, partial: output });
				}
				break;
			}
			case "content_block_delta": {
				const block = blocks.find((b) => b.index === ev.index);
				if (!block) break;
				const d = ev.delta as { type?: string; text?: string; thinking?: string; partial_json?: string; signature?: string } | undefined;
				if (!d) break;
				const idx = blocks.indexOf(block);
				if (d.type === "text_delta" && block.type === "text") {
					block.text = (block.text ?? "") + d.text;
					stream.push({ type: "text_delta", contentIndex: idx, delta: d.text ?? "", partial: output });
				} else if (d.type === "thinking_delta" && block.type === "thinking") {
					block.thinking = (block.thinking ?? "") + d.thinking;
					stream.push({ type: "thinking_delta", contentIndex: idx, delta: d.thinking ?? "", partial: output });
				} else if (d.type === "input_json_delta" && block.type === "toolCall") {
					block.partialJson = (block.partialJson ?? "") + (d.partial_json ?? "");
					try {
						block.arguments = JSON.parse(block.partialJson) as Record<string, unknown>;
					} catch {
						// incomplete JSON
					}
					stream.push({ type: "toolcall_delta", contentIndex: idx, delta: d.partial_json ?? "", partial: output });
				} else if (d.type === "signature_delta" && block.type === "thinking") {
					block.thinkingSignature = (block.thinkingSignature ?? "") + (d.signature ?? "");
				}
				break;
			}
			case "content_block_stop": {
				const block = blocks.find((b) => b.index === ev.index);
				if (!block) break;
				const idx = blocks.indexOf(block);
				delete block.index;
				if (block.type === "text") {
					stream.push({ type: "text_end", contentIndex: idx, content: block.text ?? "", partial: output });
				} else if (block.type === "thinking") {
					stream.push({ type: "thinking_end", contentIndex: idx, content: block.thinking ?? "", partial: output });
				} else if (block.type === "toolCall") {
					try {
						block.arguments = JSON.parse(block.partialJson ?? "") as Record<string, unknown>;
					} catch {
						// keep accumulated partial
					}
					delete block.partialJson;
					stream.push({ type: "toolcall_end", contentIndex: idx, toolCall: block as unknown as ToolCall, partial: output });
				}
				break;
			}
			case "message_delta": {
				const delta = ev.delta as { stop_reason?: string } | undefined;
				if (delta?.stop_reason) output.stopReason = mapStopReason(delta.stop_reason);
				const u = (ev.usage as { output_tokens?: number } | undefined);
				if (u?.output_tokens) {
					output.usage.output = u.output_tokens;
					output.usage.totalTokens = output.usage.input + output.usage.output + output.usage.cacheRead + output.usage.cacheWrite;
					calculateCost(ctx.model, output.usage);
				}
				break;
			}
		}
	});
}

async function parseResponses(res: Response, ctx: StreamCtx): Promise<void> {
	const { output, stream } = ctx;
	const contentByKey = new Map<string, number>();
	const toolByItem = new Map<string, number>();
	const reasoningByItem = new Map<string, number>();
	const reasoningSummaryIndex = new Map<string, number>();
	const blocks = output.content as unknown as WireBlock[];
	await readNdjson(res, (ev) => {
		const pushTool = (item: { id?: string; name?: string; arguments?: string } | undefined) => {
			if (!item?.id) return;
			pushWire(output, {
				type: "toolCall",
				id: item.id,
				name: item.name ?? "",
				arguments: {},
				partialJson: item.arguments ?? "",
			});
			const idx = output.content.length - 1;
			toolByItem.set(item.id, idx);
			stream.push({ type: "toolcall_start", contentIndex: idx, partial: output });
			return idx;
		};
		switch (ev.type) {
			case "response.output_item.added": {
				const item = ev.item as { type?: string; id?: string; name?: string; arguments?: string } | undefined;
				if (item?.type === "function_call") pushTool(item);
				else if (item?.type === "reasoning" && item.id) {
					pushWire(output, { type: "thinking", thinking: "" });
					reasoningByItem.set(item.id, output.content.length - 1);
					reasoningSummaryIndex.set(item.id, -1);
					stream.push({ type: "thinking_start", contentIndex: output.content.length - 1, partial: output });
				}
				break;
			}
			case "response.content_part.added": {
				const part = ev.part as { type?: string } | undefined;
				const key = `${ev.item_id}:${ev.output_index}`;
				if (!part || contentByKey.has(key)) break;
				if (part.type === "output_text") {
					pushWire(output, { type: "text", text: "" });
					contentByKey.set(key, output.content.length - 1);
					stream.push({ type: "text_start", contentIndex: output.content.length - 1, partial: output });
				} else if (part.type === "reasoning") {
					pushWire(output, { type: "thinking", thinking: "" });
					contentByKey.set(key, output.content.length - 1);
					stream.push({ type: "thinking_start", contentIndex: output.content.length - 1, partial: output });
				}
				break;
			}
			case "response.output_text.delta": {
				const idx = contentByKey.get(`${ev.item_id}:${ev.output_index}`);
				if (idx === undefined) break;
				const block = blocks[idx];
				if (block?.type === "text") {
					block.text = (block.text ?? "") + (ev.delta as string);
					stream.push({ type: "text_delta", contentIndex: idx, delta: ev.delta as string, partial: output });
				}
				break;
			}
			case "response.reasoning_text.delta":
			case "response.reasoning_summary_text.delta": {
				// Reasoning summaries arrive keyed by item_id + summary_index; the
				// encrypted reasoning payload (reasoning.encrypted_content) is not
				// decodable here, so only the plaintext summary is surfaced.
				const idx = reasoningByItem.get(ev.item_id as string);
				if (idx === undefined) break;
				const block = blocks[idx];
				if (block?.type !== "thinking") break;
				const delta = ev.delta as string;
				const summaryIndex = typeof ev.summary_index === "number" ? ev.summary_index : -1;
				const last = reasoningSummaryIndex.get(ev.item_id as string) ?? -1;
				if (last >= 0 && summaryIndex !== last) {
					block.thinking = (block.thinking ?? "") + "\n\n";
				}
				reasoningSummaryIndex.set(ev.item_id as string, summaryIndex);
				block.thinking = (block.thinking ?? "") + delta;
				stream.push({ type: "thinking_delta", contentIndex: idx, delta, partial: output });
				break;
			}
			case "response.function_call_arguments.delta": {
				const idx = toolByItem.get(ev.item_id as string);
				if (idx === undefined) break;
				const block = blocks[idx];
				if (block?.type === "toolCall") {
					block.partialJson = (block.partialJson ?? "") + (ev.delta as string);
					try {
						block.arguments = JSON.parse(block.partialJson) as Record<string, unknown>;
					} catch {
						// incomplete JSON
					}
					stream.push({ type: "toolcall_delta", contentIndex: idx, delta: ev.delta as string, partial: output });
				}
				break;
			}
			case "response.content_part.done": {
				const idx = contentByKey.get(`${ev.item_id}:${ev.output_index}`);
				if (idx === undefined) break;
				const block = blocks[idx];
				if (block.type === "text") stream.push({ type: "text_end", contentIndex: idx, content: block.text ?? "", partial: output });
				else if (block.type === "thinking") stream.push({ type: "thinking_end", contentIndex: idx, content: block.thinking ?? "", partial: output });
				break;
			}
			case "response.output_item.done": {
				const item = ev.item as { type?: string; id?: string; arguments?: string } | undefined;
				if (!item?.id) break;
				if (item.type === "function_call") {
					const idx = toolByItem.get(item.id);
					if (idx === undefined) break;
					const block = blocks[idx];
					if (block?.type !== "toolCall") break;
					try {
						block.arguments = JSON.parse(item.arguments ?? block.partialJson ?? "") as Record<string, unknown>;
					} catch {
						// keep accumulated partial
					}
					delete block.partialJson;
					stream.push({ type: "toolcall_end", contentIndex: idx, toolCall: block as unknown as ToolCall, partial: output });
				} else if (item.type === "reasoning") {
					const idx = reasoningByItem.get(item.id);
					if (idx !== undefined) {
						const block = blocks[idx];
						stream.push({ type: "thinking_end", contentIndex: idx, content: block?.thinking ?? "", partial: output });
						reasoningByItem.delete(item.id);
						reasoningSummaryIndex.delete(item.id);
					}
				}
				break;
			}
			case "response.completed": {
				const r = ev.response as { status?: string; usage?: Record<string, number> & { input_tokens_details?: { cached_tokens?: number; cache_write_tokens?: number } }; error?: { message?: string } } | undefined;
				if (r?.status === "failed") throw new Error(`Zed: ${r.error?.message ?? "response failed"}`);
				if (r?.usage) {
					const d = r.usage.input_tokens_details;
					updateUsage(ctx.model, output, r.usage.input_tokens ?? 0, r.usage.output_tokens ?? 0, d?.cached_tokens ?? 0, d?.cache_write_tokens ?? 0);
				}
				output.stopReason = "stop";
				break;
			}
			case "response.failed": {
				const r = ev.response as { error?: { code?: string; message?: string } } | undefined;
				throw new Error(`Zed: ${r?.error?.message ?? r?.error?.code ?? "response failed"}`);
			}
			case "response.incomplete": {
				const r = ev.response as { incomplete_details?: { reason?: string }; usage?: Record<string, number> & { input_tokens_details?: { cached_tokens?: number; cache_write_tokens?: number } } } | undefined;
				if (r?.usage) {
					const d = r.usage.input_tokens_details;
					updateUsage(ctx.model, output, r.usage.input_tokens ?? 0, r.usage.output_tokens ?? 0, d?.cached_tokens ?? 0, d?.cache_write_tokens ?? 0);
				}
				output.stopReason = r?.incomplete_details?.reason === "max_output_tokens" ? "length" : "stop";
				break;
			}
		}
	});
}

async function parseGoogle(res: Response, ctx: StreamCtx): Promise<void> {
	const { output, stream } = ctx;
	const blocks = output.content as unknown as (Partial<TextContent> & Partial<ThinkingContent> & Partial<ToolCall>)[];
	const partState: { text: string; thought: boolean; blockIdx?: number; done?: boolean }[] = [];
	await readNdjson(res, (ev) => {
		const candidate = (ev.candidates as { content?: { parts?: { text?: string; thought?: boolean; thoughtSignature?: string; functionCall?: { name?: string; args?: Record<string, unknown> } }[] }; finishReason?: string }[] | undefined)?.[0];
		if (candidate?.content?.parts) {
			candidate.content.parts.forEach((part, i) => {
				const state = (partState[i] ??= { text: "", thought: part.thought === true });
				if (part.functionCall) {
					if (!state.done) {
						state.done = true;
						const block: WireBlock = { type: "toolCall", id: `call_${i}`, name: part.functionCall.name ?? "", arguments: part.functionCall.args ?? {} };
						if (part.thoughtSignature) block.thoughtSignature = part.thoughtSignature;
						pushWire(output, block);
						const idx = output.content.length - 1;
						stream.push({ type: "toolcall_start", contentIndex: idx, partial: output });
						stream.push({ type: "toolcall_end", contentIndex: idx, toolCall: output.content[idx] as ToolCall, partial: output });
					}
					return;
				}
				if (typeof part.text !== "string") return;
				const delta = part.text.slice(state.text.length);
				state.text = part.text;
				if (!delta) return;
				if (state.thought) {
					if (state.blockIdx === undefined) {
						pushWire(output, { type: "thinking", thinking: "" });
						state.blockIdx = output.content.length - 1;
						stream.push({ type: "thinking_start", contentIndex: state.blockIdx, partial: output });
					}
					const block = blocks[state.blockIdx];
					if (block?.type === "thinking") {
						block.thinking = (block.thinking ?? "") + delta;
						stream.push({ type: "thinking_delta", contentIndex: state.blockIdx, delta, partial: output });
					}
				} else {
					if (state.blockIdx === undefined) {
						pushWire(output, { type: "text", text: "" });
						state.blockIdx = output.content.length - 1;
						stream.push({ type: "text_start", contentIndex: state.blockIdx, partial: output });
					}
					const block = blocks[state.blockIdx];
					if (block?.type === "text") {
						block.text = (block.text ?? "") + delta;
						if (part.thoughtSignature) block.textSignature = part.thoughtSignature;
						stream.push({ type: "text_delta", contentIndex: state.blockIdx, delta, partial: output });
					}
				}
			});
		}
		if (candidate?.finishReason) {
			const hasTool = partState.some((s) => s.done);
			if (candidate.finishReason === "STOP") output.stopReason = hasTool ? "toolUse" : "stop";
			else if (candidate.finishReason === "MAX_TOKENS") output.stopReason = "length";
			else throw new Error(`Zed: google candidate blocked (${candidate.finishReason})`);
		}
		const usage = ev.usageMetadata as { promptTokenCount?: number; candidatesTokenCount?: number; totalTokenCount?: number } | undefined;
		if (usage) {
			output.usage.input = usage.promptTokenCount ?? 0;
			output.usage.output = usage.candidatesTokenCount ?? 0;
			output.usage.totalTokens = usage.totalTokenCount ?? output.usage.input + output.usage.output;
			calculateCost(ctx.model, output.usage);
		}
	});
	// Finalize open blocks.
	for (const state of partState) {
		if (state.blockIdx !== undefined) {
			const block = blocks[state.blockIdx];
			if (block?.type === "text") stream.push({ type: "text_end", contentIndex: state.blockIdx, content: block.text ?? "", partial: output });
			else if (block?.type === "thinking") stream.push({ type: "thinking_end", contentIndex: state.blockIdx, content: block.thinking ?? "", partial: output });
		}
	}
}

// =============================================================================
// streamSimple (the pi provider stream contract)
// =============================================================================

function streamZed(model: Model<Api>, context: Context, options?: SimpleStreamOptions): AssistantMessageEventStream {
	const stream = createAssistantMessageEventStream();

	(async () => {
		const output: AssistantMessage = {
			role: "assistant",
			content: [],
			api: model.api,
			provider: model.provider,
			model: model.id,
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "pending",
			timestamp: Date.now(),
		};

		try {
			const cred = unpackCredential(options?.apiKey);
			if (!cred) throw new Error("Zed: not logged in — run /login zed");
			const meta = metaFor(model.id);
			if (!routeFor(model.id)) throw new Error(`Zed: unsupported model ${model.id}`);

			stream.push({ type: "start", partial: output });

			const body = (meta.family === "anthropic"
				? buildAnthropicBody(model, context, options, meta)
				: meta.family === "open_ai"
					? buildResponsesBody(model, context, options, meta)
					: buildGoogleBody(model, context, options, meta)) as Record<string, unknown>;

			const envelope: Record<string, unknown> = {
				thread_id: null,
				prompt_id: null,
				provider: meta.family,
				model: model.id,
				provider_request: body,
			};
			const finalEnvelope = (await options?.onPayload?.(envelope, model)) ?? envelope;

			const headers: Record<string, string> = {
				"Content-Type": "application/json",
				Authorization: `Bearer ${jwtCache.token}`,
				"x-zed-version": ZED_VERSION,
				"User-Agent": USER_AGENT,
			};
			const doFetch = () =>
				fetch(`${CLOUD_URL}/completions`, {
					method: "POST",
					headers,
					body: JSON.stringify(finalEnvelope),
					signal: options?.signal,
				});

			let res = await doFetch();
			if (res.status === 401) {
				// Stale JWT: mint a fresh one and retry once.
				invalidateJwt();
				await mintJwt(cred, options?.signal);
				headers.Authorization = `Bearer ${jwtCache.token}`;
				res = await doFetch();
			}
			await options?.onResponse?.({ status: res.status, headers: Object.fromEntries(res.headers.entries()) }, model);
			if (!res.ok) {
				const text = (await res.text()).slice(0, 500);
				if (process.env.ZED_DEBUG) {
					const fs = await import("node:fs");
					fs.writeFileSync("/tmp/zed-err-body.json", JSON.stringify(finalEnvelope, null, 2));
					fs.writeFileSync("/tmp/zed-err-resp.txt", `${res.status} ${text}`);
				}
				throw new Error(`Zed ${res.status}: ${text}`);
			}

			const sc: StreamCtx = { model, output, stream, tools: context.tools };
			if (meta.family === "anthropic") await parseAnthropic(res, sc);
			else if (meta.family === "open_ai") await parseResponses(res, sc);
			else await parseGoogle(res, sc);

			if (options?.signal?.aborted) throw new Error("request aborted");
			if (output.stopReason === "pending") throw new Error("Zed stream ended without a stop reason");
			if (output.stopReason === "error" || output.stopReason === "aborted") throw new Error(output.errorMessage || "Zed stream failed");
			stream.push({ type: "done", reason: output.stopReason, message: output });
		} catch (error) {
			output.stopReason = options?.signal?.aborted ? "aborted" : "error";
			output.errorMessage = error instanceof Error ? error.message : String(error);
			stream.push({ type: "error", reason: output.stopReason, error: output });
		}
		stream.end();
	})();

	return stream;
}

// =============================================================================
// Extension entry
// =============================================================================

export default async function (pi: ExtensionAPI) {
	// Load models in the factory so they are ready for --list-models and
	// --model before session start (network refresh only runs in TUI startup).
	let initialModels: ProviderModelConfig[] = [];
	try {
		const cred = await readStoredCredential();
		if (cred) initialModels = await fetchZedModels(cred);
	} catch (error) {
		console.warn(`[zed] model discovery unavailable: ${String(error)}`);
	}

	pi.registerProvider(PROVIDER_ID, {
		name: "Zed Cloud",
		baseUrl: CLOUD_URL,
		api: "zed-cloud",
		models: initialModels,
		refreshModels: async ({ signal, stored, credential, allowNetwork, force, publish }) => {
			const storedModels = stored?.models as unknown as ProviderModelConfig[] | undefined;
			// Offline/cache phase: keep whatever we already have instead of wiping it.
			if (signal.aborted || !allowNetwork) return lastModels.length ? lastModels : (storedModels ?? []);
			const cred = credFromStored(credential) ?? (await readStoredCredential());
			if (!cred) return lastModels.length ? lastModels : (storedModels ?? []);
			try {
				const fresh = await fetchZedModels(cred, signal, force === true);
				if (fresh.length > 0) {
					await publish({ persist: { models: fresh as unknown as Model<Api>[], checkedAt: Date.now() } });
				}
				return fresh.length > 0 ? fresh : lastModels;
			} catch (error) {
				if (lastModels.length) return lastModels;
				if (storedModels?.length) return storedModels;
				throw error;
			}
		},
		oauth: {
			name: "Zed (Sign in with zed.dev)",
			isSubscription: true,
			login: zedOAuthLogin,
			refreshToken: async (credentials) => credentials,
			getApiKey: (credentials) => {
				const uid = credentials.zed_user_id;
				const org = credentials.zed_org_id;
				const systemId = credentials.zed_system_id;
				if (typeof uid !== "number" || typeof org !== "string" || typeof systemId !== "string") {
					throw new Error("Zed: stored credential is missing zed_user_id/zed_org_id — re-run /login zed");
				}
				return packCredential({ uid, org, token: credentials.access, systemId });
			},
		},
		streamSimple: streamZed,
	});

	// -----------------------------------------------------------------------
	// Auto model refresh
	// -----------------------------------------------------------------------

	let modelsTimer: ReturnType<typeof setInterval> | undefined;

	const refreshModelsNow = (ctx: ExtensionContext) => {
		void ctx.modelRegistry.refresh({ providers: [PROVIDER_ID], force: true }).catch(() => undefined);
	};

	pi.on("session_start", (_event, ctx) => {
		refreshModelsNow(ctx);
		modelsTimer ??= setInterval(() => refreshModelsNow(ctx), MODEL_REFRESH_MS);
	});

	pi.on("session_shutdown", () => {
		clearInterval(modelsTimer);
		modelsTimer = undefined;
	});

	// -----------------------------------------------------------------------
	// /zed command
	// -----------------------------------------------------------------------

	pi.registerCommand("zed", {
		description: "Zed Cloud: refresh models, show status/usage",
		handler: async (args, ctx) => {
			const sub = (args ?? "").trim().split(/\s+/)[0] ?? "";
			switch (sub) {
				case "refresh":
					await ctx.modelRegistry.refresh({ providers: [PROVIDER_ID], force: true });
					ctx.ui.notify("Zed: models refreshed", "info");
					break;
				case "usage": {
					const auth = await ctx.modelRegistry.getProviderAuth(PROVIDER_ID);
					const cred = unpackCredential(auth?.auth.apiKey);
					if (!cred) {
						ctx.ui.notify("Zed: not logged in — run /login zed", "error");
						break;
					}
					const me = await fetchPlan(cred);
					ctx.ui.notify(`Zed: ${me?.name ?? "?"} — ${formatPlan(me?.plan) ?? "no usage data"}`, "info");
					break;
				}
				case "status": {
					const auth = await ctx.modelRegistry.getProviderAuth(PROVIDER_ID);
					const cred = unpackCredential(auth?.auth.apiKey);
					const available = ctx.modelRegistry.getAvailable().filter((m) => m.provider === PROVIDER_ID);
					const active = ctx.model?.provider === PROVIDER_ID ? ctx.model.name : undefined;
					if (!cred) {
						ctx.ui.notify(`Zed: not logged in (${available.length} cached models). Run /login zed`, "info");
						break;
					}
					const me = await fetchPlan(cred);
					ctx.ui.notify(
						`Zed: ${me?.name ?? "?"} · org ${cred.org} · ${available.length} models · active ${active ?? "none"} · ${formatPlan(me?.plan) ?? "no usage data"}`,
						"info",
					);
					break;
				}
				case "login":
					ctx.ui.notify("Run /login zed and choose \"Sign in with zed.dev\"", "info");
					break;
				case "logout":
					ctx.ui.notify("Run /logout and pick Zed", "info");
					break;
				default:
					ctx.ui.notify(
						"zed: login (/login zed) · logout (/logout) · refresh (/zed refresh) · status (/zed status) · usage (/zed usage)",
						"info",
					);
			}
		},
	});
}
