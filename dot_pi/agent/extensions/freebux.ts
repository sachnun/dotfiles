import type { ExtensionAPI, ProviderModelConfig } from "@earendil-works/pi-coding-agent";
import type { Model, Api } from "@earendil-works/pi-ai";

const BASE_URL = "https://freebux.up.railway.app/v1";
const TIMEOUT_MS = 15_000;

interface FreebuxModel {
	id?: unknown;
	name?: unknown;
	display_name?: unknown;
	context_window?: unknown;
	max_tokens?: unknown;
	reasoning?: unknown;
	input?: unknown;
}

function asPositiveNumber(value: unknown, fallback: number): number {
	return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : fallback;
}

function asString(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

async function fetchJson(url: string, signal?: AbortSignal): Promise<unknown> {
	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);
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

function toProviderModel(model: FreebuxModel): ProviderModelConfig | undefined {
	const id = asString(model.id);
	if (!id) return undefined;

	const input: ("text" | "image")[] = Array.isArray(model.input) && model.input.includes("image") ? ["text", "image"] : ["text"];
	const reasoning = model.reasoning === true;

	return {
		id,
		name: asString(model.display_name) ?? asString(model.name) ?? id,
		reasoning,
		input,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: asPositiveNumber(model.context_window, 131_072),
		maxTokens: asPositiveNumber(model.max_tokens, 16_384),
		// xhigh/max only show up when thinkingLevelMap has non-null entries.
		// OpenRouter format sends the effort value through as-is (passthrough).
		thinkingLevelMap: reasoning
			? {
					xhigh: "xhigh",
					max: "max",
				}
			: undefined,
		compat: { supportsDeveloperRole: false, thinkingFormat: "openrouter" },
	};
}

async function fetchModels(signal?: AbortSignal): Promise<ProviderModelConfig[]> {
	const payload = (await fetchJson(`${BASE_URL}/models`, signal)) as { data?: unknown };
	if (!Array.isArray(payload.data) || payload.data.length === 0) throw new Error("freebux: no models");

	return payload.data
		.map((model) => (model && typeof model === "object" ? toProviderModel(model as FreebuxModel) : undefined))
		.filter((model): model is ProviderModelConfig => model !== undefined);
}

export default function (pi: ExtensionAPI) {
	// Model discovery is non-blocking: the provider registers immediately with
	// an empty catalog and the fetch runs in the background (plus pi's own
	// catalog refresh via refreshModels). A slow/unreachable API must not
	// delay extension load — and therefore session start.
	let models: ProviderModelConfig[] = [];
	void fetchModels()
		.then((fresh) => {
			models.splice(0, models.length, ...fresh);
		})
		.catch(() => {
			// Silent: model discovery is best-effort.
		});

	pi.registerProvider("freebux", {
		name: "Freebux",
		baseUrl: BASE_URL,
		api: "openai-completions",
		apiKey: "freebux",
		models,
		refreshModels: async ({ signal, stored, publish, allowNetwork }) => {
			// Offline/abort → serve the persisted catalog (or current in-memory list).
			if (!allowNetwork || signal.aborted) return (stored?.models as unknown as ProviderModelConfig[]) ?? models;
			try {
				const fresh = await fetchModels(signal);
				if (fresh.length > 0) {
					await publish({
						persist: { models: fresh as Model<Api>[], checkedAt: Date.now() },
					});
					return fresh;
				}
				return (stored?.models as unknown as ProviderModelConfig[]) ?? models;
			} catch (error) {
				// Keep the last-known catalog on failure instead of dropping it.
				if (stored?.models?.length) return stored.models as unknown as ProviderModelConfig[];
				return models;
			}
		},
	});
}
