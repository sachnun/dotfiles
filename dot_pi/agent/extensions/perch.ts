/**
 * Perch provider for pi — fully self-contained, no external CLI required.
 *
 * Routes pi requests through the Perch model proxy:
 *   POST {APP_URL}/api/perch-terminal/model-call
 *
 * Auth is a Supabase PKCE browser flow integrated via pi's standard OAuth
 * mechanism (/login perch · /logout perch). Credentials live in pi's own
 * auth.json store; token refresh goes directly to Supabase.
 *
 * Model pool: the standard-tier models verified to pin successfully on a
 * Pilot plan (deepseek-v4-flash, ox-alpha, qwen-3.6, kimi-2.5, glm-5,
 * qwen3-coder, nemotron-super, minimax-m2, gemma-4-e2b/31b). Premium-tier
 * pins are rejected server-side and silently fall back to the free pool,
 * so they are not registered.
 *
 * Effort maps were sourced from pi's models-store.json OpenRouter entries
 * for identical/similar upstream models.
 *
 * Select with /model perch/<id>  ·  /usage shows allowance and spend.
 */

import type {
	Api,
	AssistantMessage,
	AssistantMessageEventStream,
	Context,
	ImageContent,
	Model,
	OAuthCredentials,
	OAuthLoginCallbacks,
	SimpleStreamOptions,
	StopReason,
	TextContent,
	ThinkingContent,
	ModelThinkingLevel,
	ThinkingLevelMap,
	ThinkingLevel,
	ToolCall,
} from "@earendil-works/pi-ai";
import { calculateCost, createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { Container, Spacer, Text } from "@earendil-works/pi-tui";
import type { ExtensionAPI, ExtensionCommandContext, Theme } from "@earendil-works/pi-coding-agent";
import { createServer } from "node:http";
import { createHash, randomBytes } from "node:crypto";

// =============================================================================

const APP_URL = "https://app.perchai.app";

interface AuthConfig {
	supabaseUrl: string;
	supabaseAnonKey: string;
	providers?: string[];
}

async function fetchAuthConfig(): Promise<AuthConfig> {
	const res = await fetch(`${APP_URL}/api/perch-terminal/cli-auth/config`, {
		headers: { Accept: "application/json" },
	});
	if (!res.ok) throw new Error(`Could not fetch Perch auth config (HTTP ${res.status}).`);
	const json = await res.json();
	if (!json?.supabaseUrl || !json?.supabaseAnonKey) throw new Error("Perch auth config incomplete.");
	return json;
}

/** Exchange a Supabase refresh token for a fresh token pair. */
async function refreshTokens(refreshToken: string): Promise<{ access: string; refresh: string; expires: number }> {
	const config = await fetchAuthConfig();
	const res = await fetch(
		`${config.supabaseUrl.replace(/\/+$/, "")}/auth/v1/token?grant_type=refresh_token`,
		{
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				apikey: config.supabaseAnonKey,
				Authorization: `Bearer ${config.supabaseAnonKey}`,
			},
			body: JSON.stringify({ refresh_token: refreshToken }),
		},
	);
	const json = await res.json().catch(() => null);
	if (!res.ok || !json?.access_token) {
		throw new Error(`Perch token refresh failed (${res.status}). Run: /login perch`);
	}
	return {
		access: String(json.access_token),
		refresh: json.refresh_token ? String(json.refresh_token) : refreshToken,
		expires: typeof json.expires_at === "number" ? json.expires_at * 1000 : Date.now() + 3600_000,
	};
}

/** Access token comes from pi's credential store (auth.json) via the JWT hint. */
async function resolveAccessToken(apiKeyHint?: string): Promise<string> {
	if (apiKeyHint?.trim().startsWith("ey")) return apiKeyHint.trim();
	throw new Error("Perch is not logged in. Run: /login perch");
}

// =============================================================================
// Context -> Perch proxy conversion (OpenAI-style wire format)
// =============================================================================

function textFromContent(content: string | Array<TextContent | ImageContent>): string {
	if (typeof content === "string") return content;
	return content
		.filter((b): b is TextContent => b.type === "text")
		.map((b) => b.text)
		.join("\n");
}

function convertTools(tools: Context["tools"]): unknown[] | undefined {
	if (!tools || tools.length === 0) return undefined;
	return tools.map((tool) => ({
		type: "function",
		function: {
			name: tool.name,
			description: tool.description,
			parameters: tool.parameters ?? { type: "object", properties: {} },
		},
	}));
}

function convertMessages(context: Context): Array<Record<string, unknown>> {
	const out: Array<Record<string, unknown>> = [];
	if (context.systemPrompt?.trim()) out.push({ role: "system", content: context.systemPrompt });

	for (const msg of context.messages) {
		if (msg.role === "user") {
			out.push({ role: "user", content: textFromContent(msg.content) });
			continue;
		}
		if (msg.role === "assistant") {
			const text = msg.content
				.filter((b): b is TextContent => b.type === "text")
				.map((b) => b.text)
				.join("\n");
			const toolCalls = msg.content.filter((b): b is ToolCall => b.type === "toolCall");
			const entry: Record<string, unknown> = { role: "assistant", content: text || "" };
			if (toolCalls.length > 0) {
				entry.tool_calls = toolCalls.map((tc) => ({
					id: tc.id,
					type: "function",
					function: { name: tc.name, arguments: JSON.stringify(tc.arguments ?? {}) },
				}));
			}
			out.push(entry);
			continue;
		}
		// toolResult
		out.push({
			role: "tool",
			tool_call_id: msg.toolCallId,
			content: msg.content
				.filter((b): b is TextContent => b.type === "text")
				.map((b) => b.text)
				.join("\n"),
		});
	}
	return out;
}

// alias -> manualModelOptionId mapping (reversed from the Perch CLI bundle).
// Verified against the live proxy on a Pilot plan with strictManual:false:
// these 11 pin successfully. Premium-tier pins (deepseek-v4-pro, flash-0731,
// glm-5.2, kimi-2.6/2.7, minimax-m3, nemotron-ultra/lightning, grok-4.3,
// qwen-3.8/3.7-plus) are rejected by the server and fall back to the free
// pool, so they are intentionally not registered.
const MODEL_OPTION_IDS: Record<string, string> = {
	"deepseek-v4-flash": "wandb-deepseek-ai-deepseek-v4-flash",
	"ox-alpha": "openrouter-stealth-ox-alpha",
	"minimax-m3-free": "gmi-minimaxai-minimax-m3",
	"qwen-3.6": "wandb-qwen3-6-35b-a3b",
	"kimi-2.5": "bedrock-mantle-moonshotai-kimi-k2-5",
	"glm-5": "bedrock-mantle-zai-glm-5",
	"qwen3-coder": "bedrock-mantle-qwen-qwen3-coder-480b-a35b-instruct",
	"nemotron-super": "bedrock-mantle-nvidia-nemotron-super-3-120b",
	"minimax-m2": "bedrock-mantle-minimax-minimax-m2",
	"gemma-4-e2b": "bedrock-mantle-google-gemma-4-e2b",
	"gemma-4-31b": "bedrock-mantle-google-gemma-4-31b",
};

// =============================================================================
// Effort / thinking-level mapping
// =============================================================================

/** Perch effort levels (CLI /effort off|low|medium|high). */
type PerchEffortLevel = "off" | "low" | "medium" | "high";

interface PerchEffort {
	level: PerchEffortLevel;
	orchestration: boolean;
}

/**
 * Effort maps per model, taken from pi's models-store.json OpenRouter entries
 * for the same/similar upstream models (authoritative capability data).
 *
 * Values are what gets sent upstream as reasoning.effort; null = unsupported
 * level (hidden from /thinking).
 */
const DEEPSEEK_V4_FLASH_LEVELS: ThinkingLevelMap = {
	off: "none",
	minimal: null,
	low: null,
	medium: null,
	high: "high",
	xhigh: "xhigh",
	max: null,
};

/** Perch CLI effortCapability for these hosted models: none|low|medium|high. */
const GRADED_OFF_LOW_MEDIUM_HIGH: ThinkingLevelMap = {
	off: "off",
	minimal: null,
	low: "low",
	medium: "medium",
	high: "high",
	xhigh: null,
	max: null,
};

/** MiniMax M2 is an always-thinking model: no user-facing effort control. */
const MINIMAX_M2_LEVELS: ThinkingLevelMap = { off: null };

/** nvidia/nemotron-3-super-120b-a12b on OpenRouter: high+ unsupported upstream. */
const NEMOTRON_SUPER_LEVELS: ThinkingLevelMap = {
	off: "none",
	minimal: null,
	low: "low",
	medium: "medium",
	high: null,
	xhigh: null,
	max: null,
};

// =============================================================================
// Login — Supabase PKCE browser OAuth flow
// =============================================================================

interface AuthConfig {
	supabaseUrl: string;
	supabaseAnonKey: string;
	providers?: string[];
}


function pkcePair(): { verifier: string; challenge: string } {
	const verifier = randomBytes(32).toString("base64url");
	const challenge = createHash("sha256").update(verifier).digest("base64url");
	return { verifier, challenge };
}

/** Local HTTP server that captures the OAuth ?code= redirect. */
function waitForCallback(timeoutMs = 120_000): {
	server: import("node:http").Server;
	code: Promise<string>;
} {
	let resolveCode!: (code: string) => void;
	let rejectCode!: (err: Error) => void;
	const code = new Promise<string>((res, rej) => {
		resolveCode = res;
		rejectCode = rej;
	});

	const server = createServer((req, res) => {
		const u = new URL(req.url ?? "/", "http://127.0.0.1");
		if (u.pathname !== "/callback") {
			res.writeHead(404).end("Not found");
			return;
		}
		const err = u.searchParams.get("error_description") ?? u.searchParams.get("error");
		const c = u.searchParams.get("code");
		if (err || !c) {
			res.writeHead(400, { "Content-Type": "text/html; charset=utf-8" });
			res.end("<h1>Perch sign-in failed</h1><p>Return to your terminal.</p>");
			rejectCode(new Error(err ?? "OAuth callback missing code"));
			return;
		}
		res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
		res.end("<h1>Perch signed in</h1><p>You can close this tab and return to your terminal.</p>");
		resolveCode(c);
	});

	server.on("error", (e) => rejectCode(e instanceof Error ? e : new Error(String(e))));
	const timer = setTimeout(() => rejectCode(new Error("Timed out waiting for browser sign-in")), timeoutMs);
	code.finally(() => {
		clearTimeout(timer);
		server.close();
	});
	return { server, code };
}

/** Run the full Supabase PKCE browser OAuth flow; persists the shared session file. */
async function runBrowserLogin(
	onAuth: (p: { url: string }) => void,
	onProgress?: ((message: string) => void) | undefined,
): Promise<OAuthCredentials> {
	const config = await fetchAuthConfig();
	const providers = (config.providers ?? []).filter((p) => p === "google" || p === "github");
	if (providers.length === 0) throw new Error("No supported Perch OAuth provider enabled.");

	const { verifier, challenge } = pkcePair();
	const { server, code } = waitForCallback();
	try {
		await new Promise<void>((resolve, reject) => {
			server.once("error", reject);
			server.listen(0, "127.0.0.1", () => resolve());
		});
		const address = server.address();
		if (address === null || typeof address === "string") throw new Error("Callback server failed to bind.");
		const redirectTo = `http://127.0.0.1:${address.port}/callback`;

		// Supabase PKCE: open the GoTrue authorize URL directly in the browser.
		// It 302s through the identity provider and lands back on our local
		// /callback with ?code=..., which we exchange for tokens below.
		const provider = providers.length > 1 ? providers[0] : providers[0];
		const authUrl = new URL(`${config.supabaseUrl.replace(/\/+$/, "")}/auth/v1/authorize`);
		authUrl.searchParams.set("provider", provider);
		authUrl.searchParams.set("code_challenge", challenge);
		authUrl.searchParams.set("code_challenge_method", "s256");
		authUrl.searchParams.set("redirect_to", redirectTo);

		onProgress?.("Opening browser for Perch sign-in…");
		onAuth({ url: authUrl.toString() });

		onProgress?.("Waiting for browser sign-in…");
		const authCode = await code;

		const tokenRes = await fetch(
			`${config.supabaseUrl.replace(/\/+$/, "")}/auth/v1/token?grant_type=pkce`,
			{
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					apikey: config.supabaseAnonKey,
					Authorization: `Bearer ${config.supabaseAnonKey}`,
				},
				body: JSON.stringify({ auth_code: authCode, code_verifier: verifier }),
			},
		);
		const tokens = (await tokenRes.json().catch(() => null)) as Record<string, unknown> | null;
		if (!tokenRes.ok || !tokens?.access_token) {
			throw new Error(`Perch token exchange failed (${tokenRes.status}).`);
		}

		return {
			access: String(tokens.access_token),
			refresh: tokens.refresh_token ? String(tokens.refresh_token) : "",
			expires: typeof tokens.expires_at === "number"
				? tokens.expires_at * 1000
				: Date.now() + (typeof tokens.expires_in === "number" ? tokens.expires_in * 1000 : 3600_000),
		};
	} finally {
		server.close();
	}
}

interface PerchSseEvent {
	type: string;
	text?: string;
	ok?: boolean;
	error?: string;
	provider?: string;
	model?: string;
	durationMs?: number;
	contextFillTokens?: number;
	usage?: { inputTokens?: number; outputTokens?: number; cacheReadInputTokens?: number };
	toolCalls?: Array<{
		id: string;
		name: string;
		arguments: Record<string, unknown>;
		rawArgumentsText?: string;
		sealed?: boolean;
	}>;
}

// =============================================================================
// Custom streaming API for the Perch model-call proxy
// =============================================================================

function streamPerchDeepSeek(
	model: Model<Api>,
	context: Context,
	options?: SimpleStreamOptions,
): AssistantMessageEventStream {
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
			const accessToken = await resolveAccessToken(options?.apiKey);

			// Resolve reasoning directive exactly like pi's openai-completions
			// openrouter format: mapped value from thinkingLevelMap, or an off
			// directive when no explicit level was requested.
			let reasoningDirective: Record<string, unknown> | null = null;
			if (model.reasoning && options?.reasoning) {
				const mapped = model.thinkingLevelMap?.[options.reasoning];
				if (mapped !== null) {
					reasoningDirective = { reasoningEffort: mapped ?? options.reasoning };
				}
			} else if (model.reasoning && model.thinkingLevelMap?.off !== null) {
				reasoningDirective = { reasoningEffort: model.thinkingLevelMap?.off ?? "none" };
			}

			// Coarse outer-effort metadata (what the official CLI sends).
			let effort: PerchEffort | null = null;
			let roostReasoning: boolean | null = null;
			if (reasoningDirective) {
				const eff = String(reasoningDirective.reasoningEffort);
				const level: PerchEffortLevel =
					eff === "none" || eff === "off"
						? "off"
						: eff === "xhigh" || eff === "max"
							? "high"
							: (["off", "low", "medium", "high"] as const).includes(eff as PerchEffortLevel)
								? (eff as PerchEffortLevel)
								: "high";
				effort = { level, orchestration: false };
				roostReasoning = level !== "off";
			}

			const body = JSON.stringify({
				request: {
					lane: "chat",
					messages: convertMessages(context),
					tools: convertTools(context.tools),
					temperature: options?.temperature ?? 0.6,
					maxOutputTokens: options?.maxTokens ?? Math.floor(model.maxTokens / 3),
					...(context.tools && context.tools.length > 0 ? { toolChoice: options?.toolChoice ?? "auto" } : {}),
					// Per-request reasoning directive (upstream: reasoning_effort /
					// chat_template_kwargs.enable_thinking on W&B-hosted models).
					...(reasoningDirective ? { reasoning: reasoningDirective } : {}),
				},
				runId: `pi-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
				lane: "chat",
				strictManual: false, // true triggers starter_model_blocked on non-Pro plans
				preferredModelId: null,
				avoidModelIds: [],
				attribution: null,
				clientSurface: "cli",
				manualModelOptionId:
					MODEL_OPTION_IDS[model.id] ?? MODEL_OPTION_IDS["deepseek-v4-flash"],
				// Outer effort metadata — what the official CLI sends.
				...(effort && roostReasoning !== null ? { effort, roostReasoning } : {}),
			});

			const res = await fetch(`${APP_URL}/api/perch-terminal/model-call`, {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					Accept: "text/event-stream",
					Authorization: `Bearer ${accessToken}`,
				},
				body,
				signal: options?.signal,
			});
			if (!res.ok || !res.body) {
				const text = await res.text().catch(() => "");
				throw new Error(`Perch model-call failed: HTTP ${res.status} ${text.slice(0, 300)}`);
			}

			stream.push({ type: "start", partial: output });

			let thinkingIndex = -1;
			let textIndex = -1;
			const toolIndices = new Map<string, number>();
			const rawArgs = new Map<string, string>();

			const ensureThinking = () => {
				if (thinkingIndex >= 0) return thinkingIndex;
				output.content.push({ type: "thinking", thinking: "", thinkingSignature: "" } as ThinkingContent);
				thinkingIndex = output.content.length - 1;
				stream.push({ type: "thinking_start", contentIndex: thinkingIndex, partial: output });
				return thinkingIndex;
			};
			const ensureText = () => {
				if (textIndex >= 0) return textIndex;
				output.content.push({ type: "text", text: "" } as TextContent);
				textIndex = output.content.length - 1;
				stream.push({ type: "text_start", contentIndex: textIndex, partial: output });
				return textIndex;
			};

			let sawDone = false;
			let failed = false;

			await parseSse(res.body, async (event: PerchSseEvent) => {
				switch (event.type) {
					case "reasoning_delta": {
						const i = ensureThinking();
						const block = output.content[i] as ThinkingContent;
						block.thinking += event.text ?? "";
						stream.push({ type: "thinking_delta", contentIndex: i, delta: event.text ?? "", partial: output });
						break;
					}
					case "answer_delta": {
						const i = ensureText();
						(output.content[i] as TextContent).text += event.text ?? "";
						stream.push({ type: "text_delta", contentIndex: i, delta: event.text ?? "", partial: output });
						break;
					}
					case "tool_call_delta":
					case "tool_use_end": {
						const sealed = event.type === "tool_use_end";
						for (const call of event.toolCalls ?? []) {
							let i = toolIndices.get(call.id);
							if (i === undefined) {
								output.content.push({
									type: "toolCall",
									id: call.id,
									name: call.name,
									arguments: {},
								} as ToolCall);
								i = output.content.length - 1;
								toolIndices.set(call.id, i);
								rawArgs.set(call.id, "");
								stream.push({ type: "toolcall_start", contentIndex: i, partial: output });
							}
							const delta = call.rawArgumentsText ?? "";
							if (delta) {
								rawArgs.set(call.id, (rawArgs.get(call.id) ?? "") + delta);
								try {
									(output.content[i] as ToolCall).arguments = JSON.parse(rawArgs.get(call.id) ?? "{}");
								} catch {
									/* partial JSON */
								}
								stream.push({ type: "toolcall_delta", contentIndex: i, delta, partial: output });
							}
							if (sealed) {
								(output.content[i] as ToolCall).arguments = call.arguments ?? {};
								stream.push({
									type: "toolcall_end",
									contentIndex: i,
									toolCall: {
										type: "toolCall",
										id: call.id,
										name: call.name,
										arguments: call.arguments ?? {},
									},
									partial: output,
								});
							}
						}
						break;
					}
					case "done": {
						sawDone = true;
						output.usage.input = event.usage?.inputTokens ?? 0;
						output.usage.output = event.usage?.outputTokens ?? 0;
						output.usage.cacheRead = event.usage?.cacheReadInputTokens ?? 0;
						output.usage.totalTokens =
							output.usage.input + output.usage.output + output.usage.cacheRead;
						calculateCost(model, output.usage);

						if (event.ok) {
							failed = false;
						} else {
							failed = true;
							output.errorMessage = event.error ?? "Perch stream failed";
						}
						break;
					}
					default:
						break; // model_call_failed etc.: terminal done carries the error
				}
			});

			// Close open blocks
			if (thinkingIndex >= 0) {
				stream.push({
					type: "thinking_end",
					contentIndex: thinkingIndex,
					content: (output.content[thinkingIndex] as ThinkingContent).thinking,
					partial: output,
				});
			}
			if (textIndex >= 0) {
				stream.push({
					type: "text_end",
					contentIndex: textIndex,
					content: (output.content[textIndex] as TextContent).text,
					partial: output,
				});
			}

			const terminal: StopReason = options?.signal?.aborted
				? "aborted"
				: !sawDone
					? "pending"
					: failed
						? "error"
						: toolIndices.size > 0
							? "toolUse"
							: "stop";
			output.stopReason = terminal;
			if (terminal === "pending") {
				throw new Error("Perch stream ended without a terminal done event");
			}
			if (terminal === "error" || terminal === "aborted") {
				stream.push({ type: "error", reason: terminal, error: output });
				stream.end();
				return;
			}

			stream.push({ type: "done", reason: terminal, message: output });
			stream.end();
		} catch (error) {
			output.stopReason = options?.signal?.aborted ? "aborted" : "error";
			output.errorMessage = error instanceof Error ? error.message : String(error);
			stream.push({ type: "error", reason: output.stopReason, error: output });
			stream.end();
		}
	})();

	return stream;
}

/** Minimal SSE reader: invokes onEvent for every `data:` line containing JSON. */
async function parseSse(body: ReadableStream<Uint8Array>, onEvent: (event: any) => void): Promise<void> {
	const reader = body.getReader();
	const decoder = new TextDecoder();
	let buffer = "";
	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		buffer += decoder.decode(value, { stream: true });
		const lines = buffer.split("\n");
		buffer = lines.pop() ?? "";
		for (const line of lines) {
			if (!line.startsWith("data: ")) continue;
			try {
				onEvent(JSON.parse(line.slice(6)));
			} catch {
				/* ignore malformed lines */
			}
		}
	}
}

// =============================================================================
// /usage — Perch Token allowance panel (same info as the CLI.s /usage)
// =============================================================================

interface AccountResponse {
	ok?: boolean;
	profile?: { email?: string | null; name?: string | null };
	session?: { planCode?: string; planName?: string; membershipRole?: string; entitlements?: Array<{ key: string; value_json?: { enabled?: boolean; models?: string[]; limit?: number } }> };
	usageMeter?: {
		dailyPt?: number | null;
		weeklyPt?: number | null;
		monthlyPt?: number | null;
		dailyUsd?: number | null;
		weeklyUsd?: number | null;
		monthlyUsd?: number | null;
		dailyTokens?: number | null;
		weeklyTokens?: number | null;
		monthlyTokens?: number | null;
		dailyCalls?: number | null;
		weeklyCalls?: number | null;
		monthlyCalls?: number | null;
		roostRolling?: {
			enabled?: boolean;
			window5hUsd?: number;
			window5hCapUsd?: number;
			window5hNextFreedAt?: string | null;
			window7dUsd?: number;
			window7dCapUsd?: number;
			window7dNextFreedAt?: string | null;
		} | null;
	};
	creditBalancePt?: number;
}

const pt = (usd: number | null | undefined): number => Math.round((usd ?? 0) * 1000);
const fmt = (n: number): string => Math.max(0, Math.round(n)).toLocaleString("en-US");
const ptLabel = (n: number): string => `${fmt(n)} PT`;

function pct(used: number, limit: number | null): number | null {
	if (!limit || limit <= 0) return null;
	return Math.max(0, Math.min((used / limit) * 100, 100));
}

function nextFreed(iso: string | null | undefined): string {
	if (!iso) return "";
	const ms = Date.parse(iso) - Date.now();
	if (!Number.isFinite(ms)) return "";
	if (ms <= 0) return "next usage frees up now";
	const mins = Math.max(1, Math.ceil(ms / 60000));
	const d = Math.floor(mins / 1440);
	const h = Math.floor((mins % 1440) / 60);
	const m = mins % 60;
	const span = d > 0 ? `${d}d${h > 0 ? ` ${h}h` : ""}` : h > 0 ? `${h}h${m > 0 ? ` ${m}m` : ""}` : `${m}m`;
	return `next usage frees up in ${span}`;
}

/** Monthly PT limit: entitlement usage.monthly_pt, else 20k PT fallback for Starter/Pilot plans. */
function monthlyLimitPt(account: AccountResponse): number | null {
	const ent = account.session?.entitlements?.find((e) => e.key === "usage.monthly_pt");
	const raw = ent?.value_json?.limit;
	if (typeof raw === "number" && Number.isFinite(raw) && raw > 0) return raw;
	return 20_000;
}

async function fetchAccount(accessToken: string): Promise<AccountResponse> {
	const res = await fetch(`${APP_URL}/api/perchai/account`, {
		headers: { Accept: "application/json", Authorization: `Bearer ${accessToken}` },
	});
	if (!res.ok) throw new Error(`Perch account fetch failed: HTTP ${res.status}`);
	const json = (await res.json()) as AccountResponse;
	if (!json.ok) throw new Error("Perch account request rejected.");
	return json;
}

/** Column where values start in /usage rows (longest label is "This month" = 11 chars). */
const LABEL_WIDTH = 13;

function renderUsageLines(account: AccountResponse, theme?: Theme): string[] {
	const c = (key: "dim" | "muted" | "text" | "borderMuted", s: string): string =>
		theme ? theme.fg(key as never, s) : s;
	const row = (label: string, ...parts: Array<[key: "dim" | "muted", text: string]>): string =>
		c("dim", label.padEnd(LABEL_WIDTH)) + parts.map(([k, t]) => c(k, t)).join("");

	const meter = account.usageMeter ?? {};
	const rolling = meter.roostRolling;
	const email = account.profile?.email ?? "?";
	const planName = account.session?.planName ?? account.session?.planCode ?? "?";
	const limit = monthlyLimitPt(account);
	const monthlyUsed = meter.monthlyPt ?? pt(meter.monthlyUsd);
	const lines: string[] = [];

	lines.push(c("dim", email));
	lines.push("");
	lines.push(
		c("dim", "Plan:") +
			(limit != null
				? ` ${c("muted", `${planName} · ${ptLabel(limit)} / month`)}${c("dim", ` (up to $${fmt(limit / 1000)} API usage)`)}`
				: ` ${c("muted", `${planName} · no monthly cap`)}`),
	);
	lines.push("");

	// Rolling fair-use windows (same shape as the CLI's Cvt/gPr output)
	if (rolling?.enabled) {
		const windows: Array<{ short: string; usd?: number; cap?: number; freedAt?: string | null }> = [
			{ short: "5h", usd: rolling.window5hUsd, cap: rolling.window5hCapUsd, freedAt: rolling.window5hNextFreedAt },
			{ short: "Weekly", usd: rolling.window7dUsd, cap: rolling.window7dCapUsd, freedAt: rolling.window7dNextFreedAt },
		];
		for (const w of windows) {
			const extra = w.cap ? ` ($${(w.usd ?? 0).toFixed(2)} of $${w.cap.toFixed(2)})` : "";
			const freed = nextFreed(w.freedAt);
			lines.push(row(w.short, ["muted", "Fair use"], ["muted", extra], ["dim", freed ? ` · ${freed}` : ""]));
		}
	}

	// This month row
	const mp = pct(monthlyUsed, limit);
	lines.push(
		row(
			"This month",
			["muted", ptLabel(monthlyUsed)],
			limit != null
				? ["dim", ` of ${ptLabel(limit)}${mp != null ? ` (${Math.round(mp)}%)` : ""}`]
				: ["dim", " · no cap"],
		),
	);

	// Today row
	const dailyUsed = meter.dailyPt ?? pt(meter.dailyUsd);
	lines.push(
		row(
			"Today",
			["muted", ptLabel(dailyUsed)],
			["dim", ` · ${fmt(meter.dailyCalls ?? 0)} calls · ${fmt(meter.dailyTokens ?? 0)} tokens`],
		),
	);

	if ((account.creditBalancePt ?? 0) > 0) {
		lines.push(
			row(
				"Credits",
				["muted", `${ptLabel(account.creditBalancePt ?? 0)} available`],
				["dim", " · used after your allowance runs out"],
			),
		);
	}

	lines.push(
		row(
			"Activity",
			["muted", `${fmt(meter.monthlyCalls ?? 0)} chats this month`],
			["dim", ` · ${ptLabel(meter.weeklyPt ?? pt(meter.weeklyUsd))} in 7 days`],
			["dim", ` · ${fmt(meter.weeklyTokens ?? 0)} model tokens`],
		),
	);
	return lines;
}


/** Locate the built-in chat container inside the TUI tree (best effort). */
function findChatContainer(tui: unknown): Container | null {
	const root = tui as { children?: unknown[] };
	for (const node of root?.children ?? []) {
		if (!(node instanceof Container)) continue;
		const containers = (node as { children?: unknown[] }).children?.filter((c) => c instanceof Container) ?? [];
		if (containers.length >= 2) {
			return containers[containers.length - 1] as Container;
		}
	}
	return null;
}

// =============================================================================
// Extension entry point
// =============================================================================

export default function (pi: ExtensionAPI) {
	pi.registerProvider("perch", {
		baseUrl: "https://app.perchai.app/api/perch-terminal/model-call",
		authHeader: false,
		api: "perch-model-call",

		models: [
			// ctx/maxOut/pricing from the Perch CLI model catalog ($/Mtok)
			{
				id: "deepseek-v4-flash",
				name: "DeepSeek V4 Flash",
				reasoning: true,
				// Exact map from openrouter models-store entry for the same upstream model
				thinkingLevelMap: { ...DEEPSEEK_V4_FLASH_LEVELS },
				input: ["text"],
				cost: { input: 0.14, output: 0.28, cacheRead: 0.07, cacheWrite: 0 },
				contextWindow: 1_048_576,
				maxTokens: 131_072,
			},
			{
				id: "ox-alpha",
				name: "Ox Alpha free",
				reasoning: true,
				thinkingLevelMap: { ...GRADED_OFF_LOW_MEDIUM_HIGH },
				input: ["text"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 1_048_576,
				maxTokens: 16_384,
			},
			{
				id: "qwen-3.6",
				name: "Qwen 3.6 35B A3B",
				reasoning: true,
				thinkingLevelMap: { ...GRADED_OFF_LOW_MEDIUM_HIGH },
				input: ["text"],
				cost: { input: 0.25, output: 1.25, cacheRead: 0.25, cacheWrite: 0 },
				contextWindow: 262_144,
				maxTokens: 16_384,
			},
			{
				id: "kimi-2.5",
				name: "Kimi K2.5",
				reasoning: false,
				input: ["text"],
				cost: { input: 0.6, output: 3, cacheRead: 0.6, cacheWrite: 0 },
				contextWindow: 256_000,
				maxTokens: 16_000,
			},
			{
				id: "glm-5",
				name: "GLM 5",
				reasoning: true,
				thinkingLevelMap: { ...GRADED_OFF_LOW_MEDIUM_HIGH },
				input: ["text"],
				cost: { input: 1, output: 3.2, cacheRead: 1, cacheWrite: 0 },
				contextWindow: 200_000,
				maxTokens: 32_000,
			},
			{
				id: "qwen3-coder",
				name: "Qwen3 Coder 480B",
				reasoning: true,
				thinkingLevelMap: { ...GRADED_OFF_LOW_MEDIUM_HIGH },
				input: ["text"],
				cost: { input: 0.45, output: 1.8, cacheRead: 0.45, cacheWrite: 0 },
				contextWindow: 128_000,
				maxTokens: 32_000,
			},
			{
				id: "nemotron-super",
				name: "Nemotron Super 120B",
				reasoning: true,
				// Exact map from openrouter models-store (nvidia/nemotron-3-super-120b-a12b)
				thinkingLevelMap: { ...NEMOTRON_SUPER_LEVELS },
				input: ["text"],
				cost: { input: 0.15, output: 0.65, cacheRead: 0.15, cacheWrite: 0 },
				contextWindow: 256_000,
				maxTokens: 32_000,
			},
			{
				id: "minimax-m2",
				name: "MiniMax M2",
				reasoning: true,
				thinkingLevelMap: { ...MINIMAX_M2_LEVELS },
				input: ["text"],
				cost: { input: 0.3, output: 1.2, cacheRead: 0.3, cacheWrite: 0 },
				contextWindow: 1_000_000,
				maxTokens: 8_000,
			},
			{
				id: "gemma-4-e2b",
				name: "Gemma 4 E2B",
				reasoning: true,
				thinkingLevelMap: { ...GRADED_OFF_LOW_MEDIUM_HIGH },
				input: ["text"],
				cost: { input: 0.04, output: 0.08, cacheRead: 0.04, cacheWrite: 0 },
				contextWindow: 128_000,
				maxTokens: 16_000,
			},
			{
				id: "gemma-4-31b",
				name: "Gemma 4 31B",
				reasoning: true,
				thinkingLevelMap: { ...GRADED_OFF_LOW_MEDIUM_HIGH },
				input: ["text"],
				cost: { input: 0.14, output: 0.4, cacheRead: 0.14, cacheWrite: 0 },
				contextWindow: 256_000,
				maxTokens: 32_000,
			},
			// minimax-m3-free (GMI hosting) omitted: duplicate of wandb pool entry,
			// add { id: "minimax-m3-free", ... optionId "gmi-minimaxai-minimax-m3" }
			// manually if needed.
		],

		oauth: {
			name: "Perch",
			async login(callbacks: OAuthLoginCallbacks): Promise<OAuthCredentials> {
				// Full browser PKCE flow — no external CLI involved.
				return runBrowserLogin(
					({ url }) => callbacks.onAuth({ url }),
					(message) => callbacks.onProgress?.(message),
				);
			},
			async refreshToken(credentials: OAuthCredentials, signal: AbortSignal): Promise<OAuthCredentials> {
				signal.throwIfAborted();
				if (!credentials.refresh) throw new Error("No Perch refresh token. Run: /login perch");
				const t = await refreshTokens(credentials.refresh);
				return { refresh: t.refresh, access: t.access, expires: t.expires };
			},
			getApiKey(credentials: OAuthCredentials): string {
				return credentials.access;
			},
		},

		streamSimple: streamPerchDeepSeek,
	});

	// /usage renders into the visible transcript area exactly like the
	// built-in /session command: appended to the chat container on screen,
	// scrolling with history, but never written into the session file.
	pi.registerCommand("usage", {
		description: "Show Perch Token allowance and session usage",
		handler: async (_args: string, ctx: ExtensionCommandContext) => {
			void _args;
			let account: AccountResponse;
			try {
				// Resolve the stored OAuth JWT from pi's credential store (auth.json).
				const accessToken = await ctx.modelRegistry.getApiKeyForProvider("perch");
				if (!accessToken) throw new Error("Perch is not logged in. Run: /login perch");
				account = await fetchAccount(accessToken);
			} catch (error) {
				ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
				return;
			}
			if (!ctx.hasUI) return;

			await ctx.ui.custom<void>(
				(tui, theme, _keybindings, done) => {
					done(); // we don't need focus; just borrow the TUI reference
					const chat = findChatContainer(tui);
					if (chat) {
						// Same rendering pattern as the built-in /session command
						chat.addChild(new Spacer(1));
						chat.addChild(
							new Text(
								[theme.fg("borderMuted", "Perch \u2014 usage"), ...renderUsageLines(account, theme)].join("\n"),
								1,
								0,
							),
						);
						tui.requestRender();
					} else {
						ctx.ui.notify(["Perch usage:", ...renderUsageLines(account)].join("\n"), "info");
					}
					return {
						invalidate() {},
						render(width: number) {
							void width;
							return [];
						},
					};
				},
				{ overlay: true },
			);
		},
	});
}
