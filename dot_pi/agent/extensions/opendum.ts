import type { ExtensionAPI, ProviderModelConfig } from "@earendil-works/pi-coding-agent";

const PROVIDER_ID = "opendum";
const BASE_URL = "https://proxy.opendum.tech/v1";
const API = "openai-completions";
const THINKING_LEVELS: (keyof NonNullable<ProviderModelConfig["thinkingLevelMap"]>)[] = ["minimal", "low", "medium", "high", "xhigh", "max"];

interface CatalogModel {
	id: string;
	reasoning?: boolean;
	reasoning_effort?: string[];
	limit?: { context?: number; output?: number };
	modalities?: { input?: string[] };
}

const ACRONYMS = new Set(["ai", "glm", "gpt"]);

function toModelName(id: string): string {
	return id
		.split("/")
		.pop()!
		.split(/[-_]/)
		.filter(Boolean)
		.map((part) => (ACRONYMS.has(part.toLowerCase()) ? part.toUpperCase() : /\d/.test(part) ? part : part[0].toUpperCase() + part.slice(1)))
		.join(" ");
}

function toThinkingLevelMap(efforts: string[]): ProviderModelConfig["thinkingLevelMap"] {
	if (efforts.length === 0) return undefined;
	const map: NonNullable<ProviderModelConfig["thinkingLevelMap"]> = {};
	for (const level of THINKING_LEVELS) map[level] = efforts.includes(level) ? level : null;
	return map;
}

function toProviderModel(model: CatalogModel): ProviderModelConfig {
	const modalities = model.modalities?.input ?? [];
	const reasoning = model.reasoning ?? true;
	return {
		id: model.id,
		name: toModelName(model.id),
		reasoning,
		...(reasoning ? { thinkingLevelMap: toThinkingLevelMap(model.reasoning_effort ?? []) } : {}),
		input: modalities.includes("image") ? ["text", "image"] : ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: model.limit?.context || 500000,
		maxTokens: model.limit?.output || 128000,
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
		name: "Opendum",
		baseUrl: BASE_URL,
		api: API,
		apiKey: "$OPENDUM_API_KEY",
		async refreshModels(context) {
			const cached = context.stored?.models.filter((model) => model.provider === PROVIDER_ID) ?? [];
			if (!context.allowNetwork || context.signal.aborted) return cached;

			const apiKey = context.credential?.type === "api_key" ? context.credential.key : undefined;
			if (!apiKey) return cached;

			try {
				const catalog = await fetchCatalog(apiKey, context.signal);
				if (catalog.length === 0) return cached;
				await context.publish({
					persist: {
						models: catalog.map((model) => ({ ...model, api: API, provider: PROVIDER_ID, baseUrl: BASE_URL })),
						checkedAt: Date.now(),
					},
				});
				return catalog;
			} catch {
				return cached;
			}
		},
	});
}
