// OpenCode Zen anonymous free tier, direct by default.
//
// The gateway gives non-opencode clients a lower fallback daily quota (it keys
// the check on the User-Agent header) — that's why plain pi requests 429ed.
// Sending an opencode-style User-Agent puts us on the normal free quota.
// Fallback: only on a 429, retry the same request via the unroxy proxy and
// stay on it until UTC midnight + 5m, then probe direct again.

import type { ExtensionAPI, ProviderModelConfig } from "@earendil-works/pi-coding-agent";
import { openAICompletionsApi } from "@earendil-works/pi-ai/compat";
import { getBuiltinModels } from "@earendil-works/pi-ai/providers/all";

const DIRECT = "https://opencode.ai/zen/v1";
const PROXY = "https://unroxy.koyeb.app/opencode.ai/zen/v1";
const RATE_LIMITED = /(^|\D)429(\D|$)|freeusagelimit|rate\s*limit|usage\s*limit|quota|retry\s+delay/i;

const openai = openAICompletionsApi();
type Model = Parameters<typeof openai.streamSimple>[0];
type Context = Parameters<typeof openai.streamSimple>[1];
type Options = Parameters<typeof openai.streamSimple>[2];

// Clean picker id -> gateway id ("deepseek-v4-flash" -> "deepseek-v4-flash-free").
const models = (getBuiltinModels("opencode") as ProviderModelConfig[])
    .filter((m) => m.id.endsWith("-free"))
    .map((m) => ({ ...m, id: m.id.slice(0, -5) }));
const aliases = new Map(models.map((m) => [m.id, m.id + "-free"]));

let proxyUntil = 0; // use the proxy while Date.now() < this

const midnight = () => {
    const d = new Date();
    return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1) + 5 * 60_000;
};

const routed = (model: Model, baseUrl: string): Model => ({
    ...model,
    baseUrl,
    headers: { ...model.headers, "user-agent": "opencode/pi" },
});

export default function (pi: ExtensionAPI) {
    pi.on("before_provider_request", (event) => {
        const p = event.payload as { model?: unknown } | null | undefined;
        if (!p || typeof p.model !== "string") return;
        const apiId = aliases.get(p.model);
        if (apiId) {
            p.model = apiId;
            return p;
        }
    });

    pi.registerProvider("opencode", {
        name: "OpenCode",
        baseUrl: DIRECT,
        api: "openai-completions",
        apiKey: "public",
        async *streamSimple(model: Model, context: Context, options: Options) {
            if (Date.now() < proxyUntil) {
                yield* openai.streamSimple(routed(model, PROXY), context, options);
                return;
            }
            let first = true;
            for await (const ev of openai.streamSimple(routed(model, DIRECT), context, options)) {
                if (first && ev.type === "error" && RATE_LIMITED.test(ev.error?.errorMessage ?? "")) {
                    proxyUntil = midnight();
                    yield* openai.streamSimple(routed(model, PROXY), context, options);
                    return;
                }
                first = false;
                yield ev;
            }
        },
        models,
    });
}
