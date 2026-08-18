// OpenCode Zen anonymous free tier, direct by default. Free = cost 0, not deprecated.
import type { ExtensionAPI, ProviderModelConfig } from "@earendil-works/pi-coding-agent";
import type { Model, Api } from "@earendil-works/pi-ai";
import { openAICompletionsApi } from "@earendil-works/pi-ai/compat";

const DIRECT = "https://opencode.ai/zen/v1";
const PROXY = "https://unroxy.koyeb.app/opencode.ai/zen/v1";
const CATALOG = "https://models.opencode.ai/api.json";
const RATE_LIMITED = /(^|\D)429(\D|$)|freeusagelimit|rate\s*limit|usage\s*limit|quota|retry\s+delay/i;

const openai = openAICompletionsApi();
type M = Parameters<typeof openai.streamSimple>[0];
type C = Parameters<typeof openai.streamSimple>[1];
type O = Parameters<typeof openai.streamSimple>[2];

let proxyUntil = 0;
const midnight = () => Date.now() - (Date.now() % 86_400_000) + 86_400_000 + 300_000;
const clean = (id: string) => (id.endsWith("-free") ? id.slice(0, -5) : id);
const routed = (model: M, baseUrl: string): M => ({ ...model, baseUrl, headers: { ...model.headers, "user-agent": "opencode/pi" } });

type Cat = { id: string; name: string; reasoning?: boolean; status?: string; limit?: { context?: number; output?: number }; cost?: { input?: number; output?: number }; modalities?: { input?: string[] } };
type Catalog = Record<string, { models?: Record<string, Cat> }>;
type Compat = NonNullable<ProviderModelConfig["compat"]>;

const COMPAT: Compat = { supportsStore: false, supportsDeveloperRole: false, maxTokensField: "max_tokens" };
const T = (low: string | null, medium: string | null, high: string, max: string | null): ProviderModelConfig["thinkingLevelMap"] =>
    ({ off: null, minimal: null, low, medium, high, xhigh: null, max });
const OVERRIDES: Record<string, { compat?: Compat; thinkingLevelMap?: ProviderModelConfig["thinkingLevelMap"] }> = {
    "deepseek-v4-flash-free": { compat: { ...COMPAT, requiresReasoningContentOnAssistantMessages: true }, thinkingLevelMap: T(null, null, "high", "max") },
    "hy3-free": { thinkingLevelMap: T("low", "medium", "high", null) },
    "laguna-s-2.1-free": { thinkingLevelMap: T("low", "medium", "high", null) },
};

const freeModels = (c: Catalog): ProviderModelConfig[] => {
    const oc = c["opencode"]?.models ?? {}, go = c["opencode-go"]?.models ?? {};
    const paid = (m: Cat): Cat | undefined => { const p = oc[clean(m.id)]; return (p && p !== m ? p : undefined) ?? go[clean(m.id)]; };
    return Object.values(oc)
        .filter((m) => (m.cost?.input ?? 1) === 0 && (m.cost?.output ?? 1) === 0 && m.status !== "deprecated")
        .map((m) => {
            const o = OVERRIDES[m.id];
            return {
                id: m.id, name: m.name, api: "openai-completions" as const, baseUrl: DIRECT,
                reasoning: m.reasoning ?? false,
                thinkingLevelMap: o?.thinkingLevelMap ?? (m.reasoning ? { xhigh: "max", max: "max" } : undefined),
                input: m.modalities?.input?.includes("image") ? (["text", "image"] as const) : (["text"] as const),
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                contextWindow: paid(m)?.limit?.context ?? m.limit?.context ?? 0,
                maxTokens: m.limit?.output ?? 0,
                compat: o?.compat ?? COMPAT,
            };
        });
};

async function fetchCatalog(signal?: AbortSignal): Promise<ProviderModelConfig[]> {
	const res = await fetch(CATALOG, { signal: signal ?? AbortSignal.timeout(20_000) });
	if (!res.ok) throw new Error(`models.dev HTTP ${res.status}`);
	return freeModels((await res.json()) as Catalog);
}

export default function (pi: ExtensionAPI) {
	// Non-blocking discovery: register immediately with an empty catalog and
	// populate it in the background (plus pi's own catalog refresh via
	// refreshModels). A slow/unreachable catalog must not delay session start.
	let models: ProviderModelConfig[] = [];
	void fetchCatalog()
		.then((fresh) => {
			models.splice(0, models.length, ...fresh);
		})
		.catch(() => {
			// Silent: catalog discovery is best-effort.
		});

	pi.registerProvider("opencode", {
		name: "OpenCode", baseUrl: DIRECT, api: "openai-completions", apiKey: "public",
		models,
		refreshModels: async ({ signal, stored, publish, allowNetwork }) => {
			// Offline/abort → serve the persisted catalog (or current in-memory list).
			if (!allowNetwork || signal.aborted) return (stored?.models as unknown as ProviderModelConfig[]) ?? models;
			try {
				const fresh = await fetchCatalog(signal);
				if (fresh.length > 0) {
					await publish({ persist: { models: fresh as Model<Api>[], checkedAt: Date.now() } });
					return fresh;
				}
				return (stored?.models as unknown as ProviderModelConfig[]) ?? models;
			} catch (error) {
				// Keep the last-known catalog on failure instead of dropping it.
				if (stored?.models?.length) return stored.models as unknown as ProviderModelConfig[];
				return models;
			}
		},
		async *streamSimple(model: M, context: C, options: O) {
			const via = (url: string) => openai.streamSimple(routed(model, url), context, options);
			const direct = Date.now() >= proxyUntil;
			let first = true;
			for await (const ev of via(direct ? DIRECT : PROXY)) {
				if (direct && first && ev.type === "error" && RATE_LIMITED.test(ev.error?.errorMessage ?? "")) {
					proxyUntil = midnight();
					yield* via(PROXY);
					return;
				}
				first = false;
				yield ev;
			}
		},
	});
}
