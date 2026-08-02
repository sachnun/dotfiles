/**
 * AIHubMix Provider
 *
 * Register provider `aihubmix` (OpenAI-compatible) buat pi.
 * - /login aihubmix → prompt API key (sk-***)
 * - Model list auto-discover dari /v1/models setelah login
 */

import { createProvider, openAICompletionsApi } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const BASE_URL = "https://aihubmix.com/v1";

export default function (pi: ExtensionAPI) {
	pi.registerProvider(
		createProvider({
			id: "aihubmix",
			name: "AIHubMix",
			baseUrl: BASE_URL,
			api: openAICompletionsApi(),
			auth: {
				apiKey: {
					name: "AIHubMix API key",
					async login(interaction) {
						const key = await interaction.prompt({
							type: "secret",
							message: "Enter AIHubMix API key (sk-...)",
						});
						if (!key) throw new Error("No API key provided");
						return { type: "api_key", key };
					},
					async resolve({ credential }) {
						return credential?.key
							? { auth: { apiKey: credential.key }, source: "stored API key" }
							: undefined;
					},
				},
			},
			models: [
				{
					id: "auto",
					name: "AIHubMix auto",
					provider: "aihubmix",
					baseUrl: BASE_URL,
					api: "openai-completions",
					reasoning: true,
					input: ["text", "image"],
					cost: { input: 2, output: 2, cacheRead: 0, cacheWrite: 0 },
					contextWindow: 1000000,
					maxTokens: 16384,
				},
			],
			// Auto-discover model list + metadata asli (context, pricing, fitur)
			// dari endpoint katalog AIHubMix: /api/v1/models?type=llm
			async fetchModels({ credential, allowNetwork, signal }) {
				const key = credential?.key;
				if (!allowNetwork || !key) return [];
				try {
					const res = await fetch(`https://aihubmix.com/api/v1/models?type=llm`, {
						headers: { Authorization: `Bearer ${key}` },
						signal,
					});
					if (!res.ok) return [];
					const payload = (await res.json()) as {
						data?: Array<{
							model_id: string;
							model_name?: string;
							context_length?: number;
							max_output?: number;
							pricing?: { input?: number; output?: number; cache_read?: number };
							features?: string;
							input_modalities?: string;
							types?: string;
						}>
					};
					return (payload.data ?? [])
						.filter((m) => !(m.types ?? "").includes("image_generation"))
						.map((m) => ({
							id: m.model_id,
							name: m.model_name || m.model_id,
							provider: "aihubmix",
							baseUrl: BASE_URL,
							api: "openai-completions",
							reasoning: (m.features ?? "").includes("thinking"),
							input: ((m.input_modalities ?? "").includes("image")
								? ["text", "image"]
								: ["text"]) as const,
							cost: {
								input: m.pricing?.input ?? 0,
							output: m.pricing?.output ?? 0,
							cacheRead: m.pricing?.cache_read ?? 0,
							cacheWrite: 0,
						},
						contextWindow: m.context_length || 128000,
						maxTokens: m.max_output || 16384,
					}));
				} catch {
					return [];
				}
			},
		}),
	);
}
