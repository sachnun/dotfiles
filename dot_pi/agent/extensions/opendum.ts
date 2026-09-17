import type { ExtensionAPI, ProviderModelConfig } from "@earendil-works/pi-coding-agent";

const PROVIDER_ID = "opendum";
const PROVIDER_NAME = "Opendum";
const BASE_URL = "https://proxy.opendum.tech/v1";
const API = "openai-completions";

const FALLBACK: ProviderModelConfig[] = [
	{
		id: "deepseek-v4.1-flash",
		name: "deepseek-v4.1-flash",
		reasoning: true,
		thinkingLevelMap: { max: "max" },
		input: ["text", "image"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 1000000,
		maxTokens: 32768,
	},
	{
		id: "gemini-3.8-flash",
		name: "gemini-3.8-flash",
		reasoning: true,
		thinkingLevelMap: { max: "max" },
		input: ["text", "image"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 1048576,
		maxTokens: 65536,
	},
	{
		id: "muse-spark-1.3-contributor",
		name: "muse-spark-1.3-contributor",
		reasoning: true,
		thinkingLevelMap: { max: "max" },
		input: ["text", "image"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 1048576,
		maxTokens: 131072,
	},
];

interface CatalogModel {
	id: string;
	limit?: { context?: number; output?: number };
	modalities?: { input?: string[] };
}

const NON_REASONING = /^(llama-|mistral-small-|kimi-k2$)/;

function toProviderModel(model: CatalogModel): ProviderModelConfig {
	const modalities = model.modalities?.input ?? [];
	const input: ("text" | "image")[] =
		modalities.includes("image") || modalities.includes("pdf") ? ["text", "image"] : ["text"];
	const reasoning = !NON_REASONING.test(model.id);
	return {
		id: model.id,
		name: model.id,
		reasoning,
		...(reasoning ? { thinkingLevelMap: { max: "max" } } : {}),
		input,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: model.limit?.context && model.limit.context > 0 ? model.limit.context : 128000,
		maxTokens: model.limit?.output && model.limit.output > 0 ? model.limit.output : 8192,
	};
}

function toProviderConfig(model: ProviderModelConfig): ProviderModelConfig {
	return {
		id: model.id,
		name: model.name,
		reasoning: model.reasoning,
		thinkingLevelMap: model.thinkingLevelMap,
		input: model.input,
		cost: model.cost,
		contextWindow: model.contextWindow,
		maxTokens: model.maxTokens,
	};
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
		name: PROVIDER_NAME,
		baseUrl: BASE_URL,
		api: API,
		apiKey: "$OPENDUM_API_KEY",
		models: FALLBACK,
		async refreshModels(context) {
			const cached =
				context.stored?.models.filter((model) => model.provider === PROVIDER_ID).map(toProviderConfig) ?? [];
			if (!context.allowNetwork || context.signal.aborted) return cached.length > 0 ? cached : FALLBACK;

			const apiKey = context.credential?.type === "api_key" ? context.credential.key : undefined;
			if (!apiKey) return cached.length > 0 ? cached : FALLBACK;

			try {
				const catalog = await fetchCatalog(apiKey, context.signal);
				if (catalog.length === 0) return cached.length > 0 ? cached : FALLBACK;
				await context.publish({
					persist: {
						models: catalog.map((model) => ({
							...model,
							api: API,
							provider: PROVIDER_ID,
							baseUrl: BASE_URL,
						})),
						checkedAt: Date.now(),
					},
				});
				return catalog;
			} catch {
				return cached.length > 0 ? cached : FALLBACK;
			}
		},
	});
}
