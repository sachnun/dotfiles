import type { ExtensionAPI, ProviderModelConfig } from "@earendil-works/pi-coding-agent";
import type { Model, Api } from "@earendil-works/pi-ai";

const BASE_URL = "https://freebux.up.railway.app/v1";

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
			if (!allowNetwork || signal.aborted) return (stored?.models as unknown as ProviderModelConfig[]) ?? [];
			try {
				const fresh = await fetchModels(signal);
				if (fresh.length > 0) {
					await publish({ persist: { models: fresh as Model<Api>[], checkedAt: Date.now() } });
					return fresh;
				}
			} catch {}
			return (stored?.models as unknown as ProviderModelConfig[]) ?? [];
		},
	});
}
