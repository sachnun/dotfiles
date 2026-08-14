// OpenCode Zen anonymous free tier, direct by default.
// Models: models.dev api.json (gzipped ~364KB), cached with ETag revalidation.
// Free = cost 0 && not deprecated. UA "opencode/*" avoids the 429 fallback
// quota; a real 429 falls back to unroxy until UTC midnight + 5m.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ProviderModelConfig } from "@earendil-works/pi-coding-agent";
import { openAICompletionsApi } from "@earendil-works/pi-ai/compat";

const DIRECT = "https://opencode.ai/zen/v1";
const PROXY = "https://unroxy.koyeb.app/opencode.ai/zen/v1";
const CATALOG = "https://models.opencode.ai/api.json";
const CACHE = join(homedir(), ".cache", "opencode-models-v2.json");
const RATE_LIMITED = /(^|\D)429(\D|$)|freeusagelimit|rate\s*limit|usage\s*limit|quota|retry\s+delay/i;

const openai = openAICompletionsApi();
type M = Parameters<typeof openai.streamSimple>[0];
type C = Parameters<typeof openai.streamSimple>[1];
type O = Parameters<typeof openai.streamSimple>[2];

let proxyUntil = 0;
const midnight = () => Date.now() - (Date.now() % 86_400_000) + 86_400_000 + 300_000;
const toCleanId = (id: string) => (id.endsWith("-free") ? id.slice(0, -5) : id);
const routed = (model: M, baseUrl: string): M => ({
    ...model,
    baseUrl,
    headers: { ...model.headers, "user-agent": "opencode/pi" },
});

type Cat = {
    id: string; name: string; reasoning?: boolean; status?: string;
    limit?: { context?: number; output?: number };
    cost?: { input?: number; output?: number };
    modalities?: { input?: string[] };
};
type Catalog = Record<string, { models?: Record<string, Cat> }>;
type Cache = { etag: string; models: ProviderModelConfig[] };

const readCache = (): Cache | undefined => { try { return JSON.parse(readFileSync(CACHE, "utf8")); } catch { return undefined; } };
const writeCache = (etag: string, models: ProviderModelConfig[]) => {
    try { mkdirSync(join(homedir(), ".cache"), { recursive: true }); writeFileSync(CACHE, JSON.stringify({ etag, models })); } catch {}
};

const freeModels = (c: Catalog): ProviderModelConfig[] => {
    const oc = c["opencode"]?.models ?? {};
    const go = c["opencode-go"]?.models ?? {};
    // models.dev under-reports free context; borrow it from the paid counterpart.
    const paid = (m: Cat): Cat | undefined => {
        const p = oc[toCleanId(m.id)];
        return (p && p !== m ? p : undefined) ?? go[toCleanId(m.id)];
    };
    return Object.values(oc)
        .filter((m) => (m.cost?.input ?? 1) === 0 && (m.cost?.output ?? 1) === 0 && m.status !== "deprecated")
        .map((m) => ({
            id: m.id, name: m.name, api: "openai-completions" as const, baseUrl: DIRECT,
            reasoning: m.reasoning ?? false,
            thinkingLevelMap: m.reasoning ? { xhigh: "max", max: "max" } : undefined,
            input: m.modalities?.input?.includes("image") ? (["text", "image"] as const) : (["text"] as const),
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            contextWindow: paid(m)?.limit?.context ?? m.limit?.context ?? 0,
            maxTokens: m.limit?.output ?? 0,
        }));
};

const loadModels = async (): Promise<ProviderModelConfig[]> => {
    const cache = readCache();
    const res = await fetch(CATALOG, { signal: AbortSignal.timeout(20_000), headers: cache ? { "if-none-match": cache.etag } : undefined });
    if (res.status === 304 && cache) return cache.models;
    if (!res.ok) throw new Error(`models.dev HTTP ${res.status}`);
    const etag = res.headers.get("etag");
    const models = freeModels((await res.json()) as Catalog);
    if (etag) writeCache(etag, models);
    return models;
};

export default async function (pi: ExtensionAPI) {
    try {
        const models = await loadModels();
        const aliases = new Map(models.map((m) => [toCleanId(m.id), m.id]));

        pi.on("before_provider_request", (event) => {
            const p = event.payload as { model?: unknown } | null | undefined;
            if (!p || typeof p.model !== "string") return;
            const real = aliases.get(p.model);
            if (real && real !== p.model) { p.model = real; return p; }
        });

        pi.registerProvider("opencode", {
            name: "OpenCode",
            baseUrl: DIRECT,
            api: "openai-completions",
            apiKey: "public",
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
            models: models.map((m) => ({ ...m, id: toCleanId(m.id) })),
        });
    } catch (error) {
        console.error("[opencode] REGISTRATION ERROR:", error instanceof Error ? error.message : String(error));
        throw error;
    }
}
