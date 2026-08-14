// OpenCode Zen anonymous free tier, direct by default. Free = cost 0, not deprecated.
import type { ExtensionAPI, ProviderModelConfig } from "@earendil-works/pi-coding-agent";
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

export default async function (pi: ExtensionAPI) {
    try {
        const res = await fetch(CATALOG, { signal: AbortSignal.timeout(20_000) });
        if (!res.ok) throw new Error(`models.dev HTTP ${res.status}`);
        const models = freeModels((await res.json()) as Catalog);
        const aliases = new Map(models.map((m) => [clean(m.id), m.id]));

        pi.on("before_provider_request", (event) => {
            const p = event.payload as { model?: unknown } | null | undefined;
            if (!p || typeof p.model !== "string") return;
            const real = aliases.get(p.model);
            if (real && real !== p.model) { p.model = real; return p; }
        });

        pi.registerProvider("opencode", {
            name: "OpenCode", baseUrl: DIRECT, api: "openai-completions", apiKey: "public",
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
            models: models.map((m) => ({ ...m, id: clean(m.id) })),
        });
    } catch (error) {
        console.error("[opencode] REGISTRATION ERROR:", error instanceof Error ? error.message : String(error));
        throw error;
    }
}
