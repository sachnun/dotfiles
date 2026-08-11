import type {
	ExtensionAPI,
	ProviderModelConfig,
} from "@earendil-works/pi-coding-agent";
import {
	openAICompletionsApi,
	type Api,
	type FetchFunction,
	type Model,
	type ThinkingLevelMap,
} from "@earendil-works/pi-ai/compat";

// Reversed from the opencode CLI (github.com/anomalyco/opencode):
//   - Model catalog comes from https://models.opencode.ai/api.json (same source
//     the opencode CLI caches and uses).
//   - The "opencode" provider routes to the OpenAI-compatible zen gateway
//     https://opencode.ai/zen/v1 with apiKey "public" when no credentials are
//     present, and only keeps models whose cost.input === 0 (packages/core/src/
//     plugin/provider/opencode.ts). Free tiers still gate by model: the gateway
//     answers 401 "Model X is not supported" for most catalog entries, so this
//     extension probes each free model with a tiny request and registers only
//     the ones actually served anonymously.
//
// pi already ships a builtin "opencode" provider (OpenCode Zen) whose free
// models need OPENCODE_API_KEY; this extension overrides it with the anonymous
// "public" key and the verified free-only model list.
//
// Model ids are aliased: the picker shows clean ids ("-free" stripped) while
// requests are rewritten to the exact API id via a before_provider_request
// handler (the gateway rejects ids without the "-free" suffix, and e.g.
// "deepseek-v4-flash" is the paid model). When the primary host rate-limits
// (429), requests switch to the koyeb reverse proxy and keep using it until
// the extension is reloaded, instead of re-checking the primary on every
// request.

const BASE_URL = "https://opencode.ai/zen/v1";
// Reverse proxy for the same gateway; used when the primary host rate-limits
// anonymous requests (the proxy has its own rate-limit pool).
const FALLBACK_BASE_URL = "https://unroxy.koyeb.app/opencode.ai/zen/v1";
const CATALOG_URL = "https://models.opencode.ai/api.json";
const API_KEY = "public";
const PROBE_TIMEOUT_MS = 8_000;
const PROBE_ATTEMPTS = 3;
const PROBE_BACKOFF_MS = 800;
const PROBE_CONCURRENCY = 3;
const CACHE_TTL_MS = 12 * 60 * 60 * 1000;

const ZERO_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
const COMPAT = { maxTokensField: "max_tokens" as const, supportsDeveloperRole: false };

// Built-in openai-completions implementation, re-exported by the pi-ai root;
// used as the streamSimple delegate so requests keep the full pi request path
// (payload hooks, retries, usage tracking) while gaining URL failover.
const openaiStreams = openAICompletionsApi();

// Rate-limit failover at the fetch layer. On a 429 the primary host is known
// to be rate-limited for a long window, so instead of hitting it on every
// request (which can extend the limit) requests go straight to the koyeb
// proxy until the extension is reloaded (module state resets then, so the
// next request re-checks the primary once).
let rateLimited = false;

const failoverFetch: FetchFunction = async (url, init) => {
	const requestUrl = String(url);
	if (!requestUrl.startsWith(BASE_URL)) return fetch(requestUrl, init);
	const fallbackUrl = requestUrl.replace(BASE_URL, FALLBACK_BASE_URL);
	if (rateLimited) {
		// Sticky until extension reload: skip the primary entirely.
		return fetch(fallbackUrl, init);
	}
	const response = await fetch(requestUrl, init);
	if (response.status !== 429) return response;
	// Rate-limited: serve this request via the proxy and keep using it until
	// the extension is reloaded.
	rateLimited = true;
	return fetch(fallbackUrl, init);
};

// Explicit thinkingLevelMap entries make "xhigh" and "max" selectable in pi
// (without an entry those levels are filtered out). The zen gateway accepts
// OpenAI-style reasoning_effort values including "xhigh" and "max"; the other
// levels pass through by name by default, so only these two are mapped.
const THINKING_LEVELS: ThinkingLevelMap = { xhigh: "xhigh", max: "max" };

// Clean display id -> exact API id. Populated whenever a model list is served;
// the before_provider_request handler rewrites outgoing requests back to the
// API id.
const aliases = new Map<string, string>();

function toCleanId(apiId: string): string {
	return apiId.endsWith("-free") ? apiId.slice(0, -"-free".length) : apiId;
}

// Present a model list with aliased (clean) ids and record the alias mapping.
function present(models: ProviderModelConfig[]): ProviderModelConfig[] {
	aliases.clear();
	for (const model of models) aliases.set(toCleanId(model.id), model.id);
	return models.map((model) => ({ ...model, id: toCleanId(model.id) }));
}

// Marker for entries this extension persists. The models-store key "opencode"
// is shared with pi's builtin OpenCode provider (pi.dev remote catalog), so a
// stored entry without this tag must never be treated as ours.
const STORE_TAG = "opencode-extension";

// Models verified to answer anonymously (probe keeps this list honest at
// refresh time; this is only the first-run fallback). The id is the exact API
// model name (the gateway rejects ids without the "-free" suffix), so only the
// display name is cleaned.
const FALLBACK: ProviderModelConfig[] = [
	{ id: "longcat-2.0-free", name: "LongCat-2.0", reasoning: true, thinkingLevelMap: THINKING_LEVELS, input: ["text"], cost: ZERO_COST, contextWindow: 1_000_000, maxTokens: 131_072, compat: COMPAT },
	{ id: "ling-3.0-flash-free", name: "Ling-3.0-flash", reasoning: true, thinkingLevelMap: THINKING_LEVELS, input: ["text"], cost: ZERO_COST, contextWindow: 262_144, maxTokens: 32_768, compat: COMPAT },
	{ id: "laguna-s-2.1-free", name: "Laguna S 2.1", reasoning: true, thinkingLevelMap: THINKING_LEVELS, input: ["text"], cost: ZERO_COST, contextWindow: 256_000, maxTokens: 32_000, compat: COMPAT },
	{ id: "deepseek-v4-flash-free", name: "DeepSeek V4 Flash", reasoning: true, thinkingLevelMap: THINKING_LEVELS, input: ["text"], cost: ZERO_COST, contextWindow: 200_000, maxTokens: 128_000, compat: COMPAT },
	{ id: "mimo-v2.5-free", name: "MiMo V2.5", reasoning: true, thinkingLevelMap: THINKING_LEVELS, input: ["text", "image"], cost: ZERO_COST, contextWindow: 200_000, maxTokens: 32_000, compat: COMPAT },
	{ id: "big-pickle", name: "Big Pickle", reasoning: true, thinkingLevelMap: THINKING_LEVELS, input: ["text"], cost: ZERO_COST, contextWindow: 200_000, maxTokens: 32_000, compat: COMPAT },
	{ id: "nemotron-3-ultra-free", name: "Nemotron 3 Ultra", reasoning: true, thinkingLevelMap: THINKING_LEVELS, input: ["text"], cost: ZERO_COST, contextWindow: 1_000_000, maxTokens: 128_000, compat: COMPAT },
];

// ---- catalog types (opencode ModelsDev schema) ----

interface CatalogModel {
	id?: unknown;
	name?: unknown;
	reasoning?: unknown;
	cost?: { input?: unknown };
	limit?: { context?: unknown; output?: unknown };
	modalities?: { input?: unknown[] };
}

interface CatalogProvider {
	models?: Record<string, CatalogModel>;
}

type Catalog = Record<string, CatalogProvider>;

// ---- helpers ----

function asString(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function asPositiveNumber(value: unknown, fallback: number): number {
	return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : fallback;
}

async function fetchJson(url: string, signal?: AbortSignal): Promise<unknown> {
	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
	const abort = () => controller.abort();
	signal?.addEventListener("abort", abort, { once: true });

	try {
		const response = await fetch(url, { headers: { Accept: "application/json" }, signal: controller.signal });
		if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
		return await response.json();
	} finally {
		clearTimeout(timeout);
		signal?.removeEventListener("abort", abort);
	}
}

// Catalog display names end in " Free"; strip it for a tidier picker.
// The id stays exact: the gateway rejects ids without the "-free" suffix.
function cleanName(value: string): string {
	return value.replace(/\s+Free$/i, "");
}

function toProviderModel(model: CatalogModel): ProviderModelConfig | undefined {
	const id = asString(model.id);
	if (!id) return undefined;

	const input: ("text" | "image")[] =
		Array.isArray(model.modalities?.input) && model.modalities.input.includes("image") ? ["text", "image"] : ["text"];

	return {
		id,
		name: cleanName(asString(model.name) ?? id),
		reasoning: model.reasoning === true,
		// xhigh/max only show up when thinkingLevelMap has non-null entries;
		// non-reasoning models get no map (same pattern as freebux.ts).
		thinkingLevelMap: model.reasoning === true ? THINKING_LEVELS : undefined,
		input,
		cost: ZERO_COST,
		contextWindow: asPositiveNumber(model.limit?.context, 200_000),
		maxTokens: asPositiveNumber(model.limit?.output, 32_000),
		compat: COMPAT,
	};
}

// Free tier gating matches opencode: only models with cost.input === 0 are
// usable without credentials. The filter runs on the raw catalog cost before
// mapping (mapped models carry a zero cost for pi's usage tracking).
function catalogFreeModels(catalog: Catalog): ProviderModelConfig[] {
	const provider = catalog.opencode;
	if (!provider?.models) return [];
	return Object.values(provider.models)
		.filter((model) => (model?.cost?.input ?? 0) === 0)
		.map((model) => toProviderModel(model))
		.filter((model): model is ProviderModelConfig => model !== undefined);
}

// ---- anonymous availability probe ----
//
// The gateway rate-limits concurrent anonymous requests, so probes run with a
// small concurrency, and transient failures (5xx/timeouts/429) are retried with
// backoff. "Model X is not supported" is a definitive rejection; everything
// else is treated as transient. Models already known to work survive transient
// outages so a momentary upstream hiccup never drops them from the picker.

type ProbeResult = "ok" | "reject" | "transient";

function delay(ms: number, signal?: AbortSignal): Promise<void> {
	return new Promise((resolve) => {
		const timer = setTimeout(resolve, ms);
		signal?.addEventListener(
			"abort",
			() => {
				clearTimeout(timer);
				resolve();
			},
			{ once: true },
		);
	});
}

async function probeOnce(model: ProviderModelConfig, signal?: AbortSignal): Promise<ProbeResult> {
	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
	const abort = () => controller.abort();
	signal?.addEventListener("abort", abort, { once: true });

	try {
		const response = await failoverFetch(`${BASE_URL}/chat/completions`, {
			method: "POST",
			headers: { "Content-Type": "application/json", Authorization: `Bearer ${API_KEY}` },
			body: JSON.stringify({
				model: model.id,
				messages: [{ role: "user", content: "ping" }],
				max_tokens: 1,
				stream: false,
			}),
			signal: controller.signal,
		});
		if (response.ok) return "ok";
		const text = await response.text();
		if (text.includes("not supported")) return "reject";
		return "transient";
	} catch {
		return "transient";
	} finally {
		clearTimeout(timeout);
		signal?.removeEventListener("abort", abort);
	}
}

async function probeModel(model: ProviderModelConfig, signal?: AbortSignal): Promise<ProbeResult> {
	for (let attempt = 1; attempt <= PROBE_ATTEMPTS; attempt++) {
		if (signal?.aborted) return "transient";
		const result = await probeOnce(model, signal);
		if (result !== "transient") return result;
		if (attempt < PROBE_ATTEMPTS) await delay(PROBE_BACKOFF_MS * attempt, signal);
	}
	return "transient";
}

function probeAll(
	models: ProviderModelConfig[],
	trusted: ProviderModelConfig[],
	signal?: AbortSignal,
): Promise<{ verified: ProviderModelConfig[]; rejected: ProviderModelConfig[] }> {
	const verified: ProviderModelConfig[] = [];
	const rejected: ProviderModelConfig[] = [];
	const trustedIds = new Set(trusted.map((model) => model.id));
	const queue = [...models];
	let active = 0;

	return new Promise((resolve) => {
		const next = () => {
			while (active < PROBE_CONCURRENCY && queue.length > 0 && !signal?.aborted) {
				const model = queue.shift()!;
				active++;
				void probeModel(model, signal)
					.then((result) => {
						if (result === "ok") {
							verified.push(model);
						} else if (result === "reject") {
							// Definitive "not supported": remember so it is not re-probed
							// on every refresh.
							rejected.push(model);
						} else if (trustedIds.has(model.id)) {
							// Trusted models survive transient outages.
							verified.push(model);
						}
					})
					.finally(() => {
						active--;
						next();
					});
			}
			if (queue.length === 0 && active === 0) resolve({ verified, rejected });
		};
		next();
	});
}

// ---- extension ----

export default function (pi: ExtensionAPI) {
	try {
		// Rewrite outgoing requests: clean id -> exact API id (e.g.
		// "deepseek-v4-flash" -> "deepseek-v4-flash-free"). Scoped to ids this
		// extension serves, so other providers' requests pass through untouched.
		pi.on("before_provider_request", (event) => {
			const payload = event.payload as { model?: unknown } | null | undefined;
			if (!payload || typeof payload.model !== "string") return;
			const apiId = aliases.get(payload.model);
			if (apiId && apiId !== payload.model) {
				payload.model = apiId;
				return payload;
			}
		});

		pi.registerProvider("opencode", {
			name: "OpenCode",
			baseUrl: BASE_URL,
			api: "openai-completions",
			apiKey: API_KEY,
			// Delegate to the built-in openai-completions implementation with a
			// custom fetch so 429s on the primary host transparently retry via the
			// koyeb proxy (see failoverFetch).
			streamSimple: (model, context, options) =>
				openaiStreams.streamSimple(model, context, { ...options, fetch: failoverFetch }),
			models: present(FALLBACK),
			refreshModels: async ({ signal, stored, publish, allowNetwork, force }) => {
				// Only trust persisted entries this extension wrote; the store key is
				// shared with pi's builtin OpenCode provider (pi.dev remote catalog).
				const mine = (stored as { tag?: unknown } | undefined)?.tag === STORE_TAG;
				const storedModels = mine
					? ((stored?.models as unknown as ProviderModelConfig[] | undefined) ?? [])
					: [];
				const serveStored = () => present(storedModels.length > 0 ? storedModels : FALLBACK);

				if (signal.aborted) return serveStored();
				if (!allowNetwork) return serveStored();

				// Re-probe at most every CACHE_TTL_MS unless forced.
				const checkedAt = (stored as { checkedAt?: unknown } | undefined)?.checkedAt;
				if (!force && mine && typeof checkedAt === "number" && Date.now() - checkedAt < CACHE_TTL_MS) {
					return serveStored();
				}

				// Trusted models (fallback + previously verified) are never dropped by a
				// transient outage; on a regular refresh only new catalog entries are
				// probed, so refreshes stay cheap and don't hammer the gateway.
				const entryFresh = mine && typeof checkedAt === "number" && Date.now() - checkedAt < CACHE_TTL_MS;
				const trusted = [...FALLBACK, ...storedModels];
				const trustedIds = new Set(trusted.map((model) => model.id));
				// Models rejected with "not supported" are skipped until the persisted
				// entry goes stale, at which point they get one more chance.
				const rejectedRaw = (stored as { rejected?: unknown } | undefined)?.rejected;
				const rejectedIds =
					entryFresh && Array.isArray(rejectedRaw)
						? new Set<string>(rejectedRaw.filter((id): id is string => typeof id === "string"))
						: new Set<string>();
				let free: ProviderModelConfig[] = [];
				let verified: ProviderModelConfig[] = [];
				let rejected: ProviderModelConfig[] = [];
				try {
					const catalog = (await fetchJson(CATALOG_URL, signal)) as Catalog;
					free = catalogFreeModels(catalog);
					const candidates = force
						? free
						: free.filter((model) => !trustedIds.has(model.id) && !rejectedIds.has(model.id));
					const result = await probeAll(candidates, force ? trusted : [], signal);
					verified = result.verified;
					rejected = result.rejected;
				} catch (error) {
					console.warn(`[opencode] model discovery unavailable: ${String(error)}`);
					// Catalog unreachable: re-verify the known list so the picker stays honest.
					verified = (await probeAll(FALLBACK, FALLBACK, signal)).verified;
				}
				if (signal.aborted) return serveStored();

				// Drop persisted models no longer present in the catalog, merge with
				// the verified fallback set, and dedupe.
				const freeIds = new Set(free.map((model) => model.id));
				const keepStored = free.length > 0 ? storedModels.filter((model) => freeIds.has(model.id)) : storedModels;
				const merged: ProviderModelConfig[] = [];
				for (const model of [...FALLBACK, ...keepStored, ...verified]) {
					if (!merged.some((entry) => entry.id === model.id)) merged.push(model);
				}

				if (merged.length > 0) {
					// tag/rejected are extension-private metadata on the shared store key;
					// ModelsStoreEntry only declares the fields pi itself reads. The
					// persisted list keeps exact API ids; presentation aliases them.
					const entry = {
						tag: STORE_TAG,
						models: merged as Model<Api>[],
						rejected: rejected.map((model) => model.id),
						checkedAt: Date.now(),
					};
					await publish({ persist: entry });
					return present(merged);
				}

				// Nothing verified (gateway changed or offline): keep the previous
				// catalog so the provider never shows up empty.
				console.warn("[opencode] no free models verified, keeping previous catalog");
				return serveStored();
			},
		});
	} catch (error) {
		console.error("[opencode] REGISTRATION ERROR:", error instanceof Error ? error.message : String(error));
		throw error;
	}
}
