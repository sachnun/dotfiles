import type { ExtensionAPI, ProviderModelConfig } from "@earendil-works/pi-coding-agent";
import type { Model, Api } from "@earendil-works/pi-ai";

const BASE_URL = "https://freebux.up.railway.app/v1";
const FETCH_TIMEOUT_MS = 10_000;

// Shared across the two cache-only refresh calls pi runs at startup, so a
// fresh install performs exactly one network fetch. Pi supersedes concurrent
// refreshes by aborting the previous caller's signal, so this fetch uses its
// own caller-independent signal.
let startupFetch: Promise<ProviderModelConfig[]> | undefined;

function fetchModelsOnce(): Promise<ProviderModelConfig[]> {
	if (!startupFetch) {
		startupFetch = fetchModels(AbortSignal.timeout(FETCH_TIMEOUT_MS)).catch(() => []);
	}
	return startupFetch;
}

async function fetchModels(signal?: AbortSignal): Promise<ProviderModelConfig[]> {
	const res = await fetch(`${BASE_URL}/models`, { headers: { Accept: "application/json" }, signal });
	if (!res.ok) throw new Error(`HTTP ${res.status}`);
	const data = (await res.json()) as { data?: unknown };
	if (!Array.isArray(data.data)) return [];
	return data.data.flatMap((m) => {
		if (typeof m !== "object" || m === null) return [];
		const raw = m as Record<string, unknown>;
		const id = typeof raw.id === "string" ? raw.id : "";
		if (!id) return [];
		const reasoning = raw.reasoning === true;
		const name = typeof raw.display_name === "string" ? raw.display_name : typeof raw.name === "string" ? raw.name : id;
		const input: ("text" | "image")[] = Array.isArray(raw.input) && raw.input.includes("image") ? ["text", "image"] : ["text"];
		return [
			{
				id,
				name,
				reasoning,
				input,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: typeof raw.context_window === "number" && raw.context_window > 0 ? raw.context_window : 131_072,
				maxTokens: typeof raw.max_tokens === "number" && raw.max_tokens > 0 ? raw.max_tokens : 16_384,
				thinkingLevelMap: reasoning ? { xhigh: "xhigh", max: "max" } : undefined,
				compat: { supportsDeveloperRole: false, thinkingFormat: "openrouter" },
			},
		];
	});
}

export default function (pi: ExtensionAPI) {
	pi.registerProvider("freebux", {
		name: "Freebux",
		baseUrl: BASE_URL,
		api: "openai-completions",
		apiKey: "freebux",
		models: [],
		refreshModels: async ({ signal, stored, publish, allowNetwork }) => {
			if (signal.aborted) return undefined;
			if (!allowNetwork) {
				// Cache-only phase (startup, credential sync): restore the persisted
				// catalog. Only when the model-store is empty (first run) fetch once
				// and persist it, so later startups skip the network round-trip.
				if (stored?.models?.length) {
					return stored.models as unknown as ProviderModelConfig[];
				}
				const fresh = await fetchModelsOnce();
				if (signal.aborted || fresh.length === 0) return undefined;
				await publish({ persist: { models: fresh as Model<Api>[], checkedAt: Date.now() } });
				return fresh;
			}
			try {
				const fresh = await fetchModels(signal);
				if (signal.aborted) return undefined;
				if (fresh.length > 0) {
					await publish({ persist: { models: fresh as Model<Api>[], checkedAt: Date.now() } });
					return fresh;
				}
			} catch {}
			return stored?.models as unknown as ProviderModelConfig[] | undefined;
		},
	});
}
