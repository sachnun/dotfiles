// Sources:
//   - https://models.dev/api.json: per-model metadata (context, max tokens,
//     modalities, reasoning) for pi's picker; metadata only, since its
//     cost.input === 0 set is broader than the gateway's anonymous tier.
//   - the gateway's own free-tier list: ids ending in "-free"; only these
//     get registered.
//
// The ~3.6MB catalog is cached to ~/.pi/agent/cache with a 3h TTL (plus the
// tiny free-id list) so startup serves models with zero network traffic;
// writes are atomic, and failures throw — no fallback data.
//
// Overrides pi's builtin "opencode" provider (OpenCode Zen, needs
// OPENCODE_API_KEY) with the anonymous "public" key.
//
// Ids are aliased: the picker shows clean ids ("-free" stripped),
// before_provider_request rewrites requests back to the exact API id (the
// gateway rejects ids without "-free").

import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type {
    ExtensionAPI,
    ProviderModelConfig,
} from "@earendil-works/pi-coding-agent";
import {
    openAICompletionsApi,
    type Api,
    type Model,
    type ThinkingLevelMap,
} from "@earendil-works/pi-ai/compat";

const BASE_URL = "https://opencode.ai/zen/v1";
const CATALOG_URL = "https://models.dev/api.json";
const API_KEY = "public";
const FETCH_TIMEOUT_MS = 30_000;
const CACHE_TTL_MS = 3 * 60 * 60 * 1000;
const CACHE_FILE = join(
    homedir(),
    ".pi",
    "agent",
    "cache",
    "opencode-catalog.json",
);
const ZERO_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
const COMPAT = {
    maxTokensField: "max_tokens" as const,
    supportsDeveloperRole: false,
};

// Built-in openai-completions delegate: keeps the full pi request path (hooks, retries, usage).
const openaiStreams = openAICompletionsApi();

// "xhigh"/"max" must be mapped to be selectable in pi; other levels pass through by name.
const THINKING_LEVELS: ThinkingLevelMap = { xhigh: "xhigh", max: "max" };

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

// Marks our persisted entries: the "opencode" store key is shared with pi's builtin provider.
const STORE_TAG = "opencode-extension";

// ---- catalog types (models.dev schema) ----

interface CatalogModel {
    id?: unknown;
    name?: unknown;
    reasoning?: unknown;
    cost?: { input?: unknown };
    limit?: { context?: unknown; output?: unknown };
    modalities?: { input?: unknown[] };
}

type Catalog = Record<string, { models?: Record<string, CatalogModel> }>;

interface CatalogCache {
    fetchedAt: number;
    catalog: Catalog;
    freeIds: string[];
}

// ---- catalog cache ----
//
// refreshModels runs on every startup, so a fresh disk copy keeps startup
// offline; writes are atomic (tmp + rename) so a crash never corrupts it.

async function readCachedCatalog(): Promise<CatalogCache | undefined> {
    try {
        const parsed = JSON.parse(
            await readFile(CACHE_FILE, "utf8"),
        ) as Partial<CatalogCache>;
        // Old cache format (no freeIds) is invalid: re-fetch both sources.
        if (
            typeof parsed.fetchedAt !== "number" ||
            !parsed.catalog ||
            !Array.isArray(parsed.freeIds)
        )
            return undefined;
        return {
            fetchedAt: parsed.fetchedAt,
            catalog: parsed.catalog,
            freeIds: parsed.freeIds.filter(
                (id): id is string => typeof id === "string",
            ),
        };
    } catch {
        return undefined;
    }
}

async function writeCachedCatalog(
    catalog: Catalog,
    freeIds: string[],
): Promise<void> {
    try {
        await mkdir(dirname(CACHE_FILE), { recursive: true });
        await writeFile(
            `${CACHE_FILE}.tmp`,
            JSON.stringify({ fetchedAt: Date.now(), catalog, freeIds }),
        );
        await rename(`${CACHE_FILE}.tmp`, CACHE_FILE);
    } catch (error) {
        console.warn(`[opencode] cache write failed: ${String(error)}`);
    }
}

// ---- helpers ----

const asString = (value: unknown) =>
    typeof value === "string" && value.trim() ? value.trim() : undefined;
const asPositiveNumber = (value: unknown) =>
    typeof value === "number" && Number.isFinite(value) && value > 0
        ? value
        : undefined;

// Fetch both sources with one timeout/abort wiring; failures throw (no fallback).
// Free tier = the gateway's own list: ids ending in "-free".
async function fetchSources(
    signal?: AbortSignal,
): Promise<[Catalog, string[]]> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    const abort = () => controller.abort();
    signal?.addEventListener("abort", abort, { once: true });
    const get = async (url: string, headers: Record<string, string> = {}) => {
        const response = await fetch(url, {
            headers: { Accept: "application/json", ...headers },
            signal: controller.signal,
        });
        if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
        return response.json() as Promise<unknown>;
    };
    try {
        const [catalog, models] = await Promise.all([
            get(CATALOG_URL),
            get(`${BASE_URL}/models`, { Authorization: `Bearer ${API_KEY}` }),
        ]);
        const freeIds = ((models as { data?: { id?: unknown }[] }).data ?? [])
            .map((entry) =>
                typeof entry?.id === "string" ? entry.id : undefined,
            )
            .filter(
                (id): id is string =>
                    typeof id === "string" && id.endsWith("-free"),
            );
        return [catalog as Catalog, freeIds];
    } finally {
        clearTimeout(timer);
        signal?.removeEventListener("abort", abort);
    }
}

// Display names end in " Free"; stripped for a tidier picker (id stays exact).
function toProviderModel(model: CatalogModel): ProviderModelConfig | undefined {
    const id = asString(model.id);
    // Models without limits are skipped: contextWindow/maxTokens are required on Model.
    const contextWindow = asPositiveNumber(model.limit?.context);
    const maxTokens = asPositiveNumber(model.limit?.output);
    if (!id || !contextWindow || !maxTokens) return undefined;
    return {
        id,
        name: (asString(model.name) ?? id).replace(/\s+Free$/i, ""),
        reasoning: model.reasoning === true,
        // Non-null entries make "xhigh"/"max" selectable; non-reasoning models get no map.
        thinkingLevelMap:
            model.reasoning === true ? THINKING_LEVELS : undefined,
        input:
            Array.isArray(model.modalities?.input) &&
            model.modalities.input.includes("image")
                ? ["text", "image"]
                : ["text"],
        cost: ZERO_COST,
        contextWindow,
        maxTokens,
        compat: COMPAT,
    };
}

// Free-tier gate: only models with cost.input === 0 are usable anonymously
// (checked on the raw catalog cost before mapping).
function catalogFreeModels(catalog: Catalog): ProviderModelConfig[] {
    const provider = catalog.opencode;
    if (!provider?.models) return [];
    return Object.values(provider.models)
        .filter((model) => (model?.cost?.input ?? 0) === 0)
        .map(toProviderModel)
        .filter((model): model is ProviderModelConfig => model !== undefined);
}

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
            models: present([]),
            refreshModels: async ({ signal, publish, allowNetwork, force }) => {
                if (!allowNetwork || signal.aborted) return present([]);

                // Fresh disk cache: no network (common startup path); force re-fetches.
                let catalog: Catalog;
                let freeIds: string[];
                const cached = await readCachedCatalog();
                if (
                    cached &&
                    !force &&
                    Date.now() - cached.fetchedAt < CACHE_TTL_MS
                ) {
                    ({ catalog, freeIds } = cached);
                } else {
                    // No fallback: a failed fetch throws and pi records the error.
                    [catalog, freeIds] = await fetchSources(signal);
                    await writeCachedCatalog(catalog, freeIds);
                }

                // Catalog metadata, restricted to the gateway's free tier.
                const models = catalogFreeModels(catalog).filter((model) =>
                    freeIds.includes(model.id),
                );
                if (models.length === 0) return present([]);
                // tag marks our entry on the store key shared with pi's builtin provider.
                const entry = {
                    tag: STORE_TAG,
                    models: models as Model<Api>[],
                    checkedAt: Date.now(),
                };
                await publish({ persist: entry });
                return present(models);
            },
        });
    } catch (error) {
        console.error(
            "[opencode] REGISTRATION ERROR:",
            error instanceof Error ? error.message : String(error),
        );
        throw error;
    }
}
