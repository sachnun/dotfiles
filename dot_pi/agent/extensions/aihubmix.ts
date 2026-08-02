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
					input: ["text"],
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
					contextWindow: 128000,
					maxTokens: 16384,
				},
			],
			// Auto-discover model list dari /v1/models (dipakai setelah login)
			async fetchModels({ credential, allowNetwork, signal }) {
				const key = credential?.key;
				if (!allowNetwork || !key) return [];
				try {
					const res = await fetch(`${BASE_URL}/models`, {
						headers: { Authorization: `Bearer ${key}` },
						signal,
					});
					if (!res.ok) return [];
					const payload = (await res.json()) as { data?: Array<{ id: string }> };
					return (payload.data ?? []).map((m) => ({
						id: m.id,
						name: m.id,
						provider: "aihubmix",
						baseUrl: BASE_URL,
						api: "openai-completions",
						reasoning: false,
						input: ["text"] as const,
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
						contextWindow: 128000,
						maxTokens: 16384,
					}));
				} catch {
					return [];
				}
			},
		}),
	);
}
