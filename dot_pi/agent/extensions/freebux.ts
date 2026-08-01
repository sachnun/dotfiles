import type { ExtensionAPI, ProviderModelConfig } from "@earendil-works/pi-coding-agent";

const DEFAULT_BASE_URL = "https://freebux.up.railway.app/v1";
const REQUEST_TIMEOUT_MS = 15_000;

interface FreebuxModel {
	id?: unknown;
	name?: unknown;
	display_name?: unknown;
	context_window?: unknown;
	max_tokens?: unknown;
	reasoning?: unknown;
	input?: unknown;
}

interface FreebuxModelsResponse {
	data?: unknown;
}

function asPositiveNumber(value: unknown, fallback: number): number {
	return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : fallback;
}

function asString(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function supportsReasoning(modelId: string): boolean {
	const id = modelId.toLowerCase();
	return (
		id.includes("gpt-5") ||
		id.includes("deepseek-v4") ||
		id.includes("kimi-k2") ||
		id.includes("minimax-m3") ||
		id.includes("mimo-v2.5-pro") ||
		id.includes("glm-5")
	);
}

function toProviderModel(model: FreebuxModel): ProviderModelConfig | undefined {
	const id = asString(model.id);
	if (!id) return undefined;

	const reasoning = typeof model.reasoning === "boolean" ? model.reasoning : supportsReasoning(id);
	const input = Array.isArray(model.input) && model.input.includes("image") ? ["text", "image"] : ["text"];

	return {
		id,
		name: asString(model.display_name) ?? asString(model.name) ?? id,
		reasoning,
		input,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: asPositiveNumber(model.context_window, 272_000),
		maxTokens: asPositiveNumber(model.max_tokens, 16_384),
		compat: {
			supportsDeveloperRole: false,
			...(reasoning ? { thinkingFormat: "openrouter" } : {}),
		},
	};
}

async function fetchModels(baseUrl: string, signal?: AbortSignal): Promise<ProviderModelConfig[]> {
	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
	const abort = () => controller.abort();
	signal?.addEventListener("abort", abort, { once: true });

	try {
		const response = await fetch(`${baseUrl}/models`, {
			headers: { Accept: "application/json" },
			signal: controller.signal,
		});
		if (!response.ok) {
			throw new Error(`Freebux model discovery failed (${response.status} ${response.statusText})`);
		}

		const payload = (await response.json()) as FreebuxModelsResponse;
		if (!Array.isArray(payload.data)) {
			throw new Error("Freebux model discovery returned an invalid payload");
		}

		const models = payload.data
			.map((model) => (model && typeof model === "object" ? toProviderModel(model as FreebuxModel) : undefined))
			.filter((model): model is ProviderModelConfig => model !== undefined);
		if (models.length === 0) throw new Error("Freebux model discovery returned no models");
		return models;
	} finally {
		clearTimeout(timeout);
		signal?.removeEventListener("abort", abort);
	}
}

const FALLBACK_MODELS: ProviderModelConfig[] = [
	"openai/gpt-5.6-luna",
	"deepseek/deepseek-v4-pro",
	"deepseek/deepseek-v4-flash",
	"minimax/minimax-m3",
	"mimo/mimo-v2.5-pro",
].map((id) => toProviderModel({ id })!);

export default async function (pi: ExtensionAPI) {
	const baseUrl = (process.env.FREEBUX_BASE_URL ?? DEFAULT_BASE_URL).replace(/\/$/, "");
	let models = FALLBACK_MODELS;

	try {
		models = await fetchModels(baseUrl);
	} catch (error) {
		console.warn(`[freebux] model discovery unavailable, using fallback models: ${String(error)}`);
	}

	pi.registerProvider("freebux", {
		name: "Freebux",
		baseUrl,
		api: "openai-completions",
		apiKey: process.env.FREEBUX_API_KEY || "freebux",
		models,
		refreshModels: async ({ signal }) => fetchModels(baseUrl, signal),
	});
}
