// Model source: pi's bundled OpenCode catalog (@earendil-works/pi-ai/providers/all,
// getBuiltinModels("opencode")). Metadata is versioned with pi itself, so no
// network fetch and no disk cache are needed — this is a fully static provider.
// Only ids ending in "-free" get registered: the gateway's anonymous tier (the
// gateway re-validates ids at request time, so a stale entry just fails that
// one request).
//
// Overrides pi's builtin "opencode" provider (OpenCode Zen, needs
// OPENCODE_API_KEY) with the anonymous "public" key.
//
// Ids are aliased: the picker shows clean ids ("-free" stripped),
// before_provider_request rewrites requests back to the exact API id (the
// gateway rejects ids without "-free").

import type {
    ExtensionAPI,
    ProviderModelConfig,
} from "@earendil-works/pi-coding-agent";
import { openAICompletionsApi } from "@earendil-works/pi-ai/compat";
import { getBuiltinModels } from "@earendil-works/pi-ai/providers/all";

const BASE_URL = "https://opencode.ai/zen/v1";
const API_KEY = "public";

// Built-in openai-completions delegate: keeps the full pi request path (hooks, retries, usage).
const openaiStreams = openAICompletionsApi();

// Bundled catalog entries, restricted to the gateway's anonymous free tier.
const freeModels = () =>
    getBuiltinModels("opencode").filter((model) =>
        model.id.endsWith("-free"),
    ) as ProviderModelConfig[];

// Clean display id -> exact API id; before_provider_request rewrites requests back.
const aliases = new Map<string, string>();
const toCleanId = (apiId: string) =>
    apiId.endsWith("-free") ? apiId.slice(0, -5) : apiId;

// Present a model list with aliased (clean) ids and record the alias mapping.
const present = (models: ProviderModelConfig[]): ProviderModelConfig[] => {
    aliases.clear();
    for (const model of models) aliases.set(toCleanId(model.id), model.id);
    return models.map((model) => ({ ...model, id: toCleanId(model.id) }));
};

export default function (pi: ExtensionAPI) {
    try {
        // Rewrite clean id -> exact API id (e.g. "deepseek-v4-flash" -> "deepseek-v4-flash-free").
        pi.on("before_provider_request", (event) => {
            const payload = event.payload as
                { model?: unknown } | null | undefined;
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
            // Delegate to the built-in openai-completions implementation.
            streamSimple: (model, context, options) =>
                openaiStreams.streamSimple(model, context, options),
            models: present(freeModels()),
        });
    } catch (error) {
        console.error(
            "[opencode] REGISTRATION ERROR:",
            error instanceof Error ? error.message : String(error),
        );
        throw error;
    }
}
