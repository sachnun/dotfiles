import type { ExtensionAPI, ProviderModelConfig } from "@earendil-works/pi-coding-agent";

const PROVIDER_ID = "freebux";
const BASE_URL = "https://freebux.up.railway.app/v1";
const API = "openai-completions";
const CONTEXT_WINDOW = 1000000;
const MAX_TOKENS = 128000;
const THINKING_LEVEL_MAP: NonNullable<ProviderModelConfig["thinkingLevelMap"]> = { xhigh: "xhigh", max: "max" };

interface CatalogModel {
	id: string;
	display_name?: string;
	reasoning?: boolean;
	input?: string[];
}

const SEED: CatalogModel[] = [
	{ id: "deepseek/deepseek-v4-flash", display_name: "DeepSeek V4.1 Flash", reasoning: true, input: ["text", "image"] },
	{ id: "google/gemini-3.8-flash", display_name: "Gemini 3.8 Flash", input: ["text", "image"] },
	{ id: "meta/muse-spark-1.2-contributor", display_name: "Muse Spark 1.2", reasoning: true, input: ["text"] },
	{ id: "mimo/mimo-v2.5", display_name: "MiMo 2.6 Flash", input: ["text", "image"] },
	{ id: "mimo/mimo-v2.6-pro", display_name: "MiMo 2.6 Pro", input: ["text", "image"] },
	{ id: "openai/gpt-6-luna", display_name: "GPT-6 Luna", reasoning: true, input: ["text", "image"] },
	{ id: "stealth/space-bunny-alpha", display_name: "Space Bunny Alpha", reasoning: true, input: ["text", "image"] },
	{ id: "upstage/solar-mini4", display_name: "Solar Mini 4", input: ["text"] },
	{ id: "upstage/solar-pro4", display_name: "Solar Pro 4", input: ["text"] },
	{ id: "z-ai/glm-5.3-flash", display_name: "GLM 5.3 Flash", reasoning: true, input: ["text", "image"] },
];

function toProviderModel(model: CatalogModel): ProviderModelConfig {
	const input = model.input ?? [];
	return {
		id: model.id,
		name: model.display_name || model.id,
		reasoning: model.reasoning ?? false,
		...(model.reasoning ? { thinkingLevelMap: { ...THINKING_LEVEL_MAP } } : {}),
		input: input.includes("image") ? ["text", "image"] : ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: CONTEXT_WINDOW,
		maxTokens: MAX_TOKENS,
	};
}

function fallback(cached: ProviderModelConfig[]): ProviderModelConfig[] {
	return cached.length > 0 ? cached : SEED.map(toProviderModel);
}

async function fetchCatalog(apiKey: string, signal: AbortSignal): Promise<ProviderModelConfig[]> {
	const response = await fetch(`${BASE_URL}/models`, {
		headers: { accept: "application/json", Authorization: `Bearer ${apiKey}` },
		signal: AbortSignal.any([signal, AbortSignal.timeout(15000)]),
	});
	if (!response.ok) throw new Error(`GET /models failed: ${response.status}`);
	const payload = (await response.json()) as { data?: CatalogModel[] };
	return (payload.data ?? []).map(toProviderModel);
}

export default function (pi: ExtensionAPI) {
	pi.registerProvider(PROVIDER_ID, {
		name: "Freebux",
		baseUrl: BASE_URL,
		api: API,
		apiKey: "$FREEBUX_API_KEY",
		models: SEED.map(toProviderModel),
		async refreshModels(context) {
			const cached = context.stored?.models.filter((model) => model.provider === PROVIDER_ID) ?? [];
			if (!context.allowNetwork || context.signal.aborted) return fallback(cached);

			const apiKey = context.credential?.type === "api_key" ? context.credential.key : undefined;
			if (!apiKey) return fallback(cached);

			try {
				const catalog = await fetchCatalog(apiKey, context.signal);
				if (catalog.length === 0) return fallback(cached);
				await context.publish({
					persist: {
						models: catalog.map((model) => ({ ...model, api: API, provider: PROVIDER_ID, baseUrl: BASE_URL })),
						checkedAt: Date.now(),
					},
				});
				return catalog;
			} catch {
				return fallback(cached);
			}
		},
	});
}
