import type {
	ExtensionAPI,
	ExtensionContext,
	ExtensionUIContext,
	ProviderModelConfig,
} from "@earendil-works/pi-coding-agent";
import type { Model, Api } from "@earendil-works/pi-ai";

const BASE_URL = "https://freebux.up.railway.app/v1";
const TIMEOUT_MS = 15_000;
const POLL_MS = 30_000;
const POLL_MS_INACTIVE = 10_000;
const STATUS_KEY = "freebux-status";

interface FreebuxModel {
	id?: unknown;
	name?: unknown;
	display_name?: unknown;
	context_window?: unknown;
	max_tokens?: unknown;
	reasoning?: unknown;
	input?: unknown;
}

interface QuotaSnapshot {
	limit?: number;
	used?: number;
	remaining?: number;
	period?: string;
	reset_at?: string;
	reset_timezone?: string;
}

interface TokenState {
	state?: string;
	session_status?: string;
	session_model?: string;
	session_expires_at?: string;
	session_quota?: { limit?: number; remaining?: number };
	quota_by_model?: Record<string, QuotaSnapshot>;
}

interface StatusResponse {
	token_state?: TokenState[];
}

function asPositiveNumber(value: unknown, fallback: number): number {
	return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : fallback;
}

function asString(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

async function fetchJson(url: string, signal?: AbortSignal): Promise<unknown> {
	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);
	const abort = () => controller.abort();
	signal?.addEventListener("abort", abort, { once: true });

	try {
		const response = await fetch(url, { headers: { Accept: "application/json" }, signal: controller.signal });
		if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
		return await response.json();
	} finally {
		clearTimeout(timeout);
		signal?.removeEventListener("abort", abort);
	}
}

function toProviderModel(model: FreebuxModel): ProviderModelConfig | undefined {
	const id = asString(model.id);
	if (!id) return undefined;

	const input: ("text" | "image")[] = Array.isArray(model.input) && model.input.includes("image") ? ["text", "image"] : ["text"];
	const reasoning = model.reasoning === true;

	return {
		id,
		name: asString(model.display_name) ?? asString(model.name) ?? id,
		reasoning,
		input,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: asPositiveNumber(model.context_window, 131_072),
		maxTokens: asPositiveNumber(model.max_tokens, 16_384),
		// xhigh/max only show up when thinkingLevelMap has non-null entries.
		// OpenRouter format sends the effort value through as-is (passthrough).
		thinkingLevelMap: reasoning
			? {
					xhigh: "xhigh",
					max: "max",
				}
			: undefined,
		compat: { supportsDeveloperRole: false, thinkingFormat: "openrouter" },
	};
}

async function fetchModels(signal?: AbortSignal): Promise<ProviderModelConfig[]> {
	const payload = (await fetchJson(`${BASE_URL}/models`, signal)) as { data?: unknown };
	if (!Array.isArray(payload.data) || payload.data.length === 0) throw new Error("freebux: no models");

	return payload.data
		.map((model) => (model && typeof model === "object" ? toProviderModel(model as FreebuxModel) : undefined))
		.filter((model): model is ProviderModelConfig => model !== undefined);
}

function fetchStatus(signal?: AbortSignal): Promise<StatusResponse> {
	return fetchJson(`${BASE_URL.replace(/\/v1\/?$/, "")}/api/status`, signal) as Promise<StatusResponse>;
}

const BAR_WIDTH = 12;

function asciiBar(fraction: number, width = BAR_WIDTH): string {
	const clamped = Math.max(0, Math.min(1, fraction));
	const filled = Math.round(clamped * width);
	return "#".repeat(filled) + "-".repeat(width - filled);
}

// Time-only sessions (no quota data): the quota effectively never runs out,
// so the bar keeps at least one '#' and marks the elapsed portion with '+'.
function timeBar(fraction: number, width = BAR_WIDTH): string {
	const clamped = Math.max(0, Math.min(1, fraction));
	const filled = Math.max(1, Math.min(width, Math.round(clamped * width)));
	return "#".repeat(filled) + "+".repeat(width - filled);
}

const STATE_LABEL: Record<string, string> = {
	cooling: "++++++------",
	expired: "------------",
};

// Total session length assumed when the API provides no quota data.
const SESSION_DURATION_SECS = 60 * 60;

function formatStatus(data: StatusResponse, modelId: string): string | undefined {
	const token = data.token_state?.find((t) => t.session_model === modelId);
	// Idle (no session token): keep the status hidden.
	if (!token) return undefined;

	const state = token.state ?? token.session_status;
	if (state !== "active") {
		// idle/banned/offline stay hidden: idle has no session, and
		// banned/offline are already surfaced by the API JSON.
		if (!state || state === "idle" || state === "banned" || state === "offline") return undefined;
		const key = state === "cooling_down" ? "cooling" : state;
		return STATE_LABEL[key];
	}

	const expires = token.session_expires_at ? Date.parse(token.session_expires_at) : Number.NaN;
	const secs = Number.isFinite(expires) ? Math.round((expires - Date.now()) / 1000) : undefined;

	const quota = token.quota_by_model?.[modelId] ?? token.session_quota;
	const quotaTotal = typeof quota?.limit === "number" && quota.limit > 0 ? quota.limit * 3600 : 0;
	const quotaLeft = typeof quota?.remaining === "number" ? Math.max(0, quota.remaining) * 3600 : Number.POSITIVE_INFINITY;

	if (secs === undefined) return undefined;
	if (secs <= 0) return STATE_LABEL.expired;

	if (quotaTotal > 0 && Number.isFinite(quotaLeft)) {
		// Quota-based: the bar mirrors the model's remaining quota (hours), not
		// the session window. Each session spends 1 hour of the daily quota,
		// so quota is the actual limiting factor.
		return asciiBar(quotaLeft / quotaTotal);
	}

	// Time-only session: quota never runs out, so the bar never fully
	// depletes (always at least one '#') and uses '+' for elapsed time.
	return timeBar(secs / SESSION_DURATION_SECS);
}

export default async function (pi: ExtensionAPI) {
	let models: ProviderModelConfig[] = [];
	try {
		models = await fetchModels();
	} catch (error) {
		console.warn(`[freebux] model discovery unavailable: ${String(error)}`);
	}

	pi.registerProvider("freebux", {
		name: "Freebux",
		baseUrl: BASE_URL,
		api: "openai-completions",
		apiKey: "freebux",
		models,
		refreshModels: async ({ signal, stored, publish }) => {
			// Abort/offline → serve the persisted catalog.
			if (signal.aborted) return (stored?.models as unknown as ProviderModelConfig[]) ?? [];
			try {
				const fresh = await fetchModels(signal);
				await publish({
					persist: { models: fresh as Model<Api>[], checkedAt: Date.now() },
				});
				return fresh;
			} catch (error) {
				if (stored?.models?.length) return stored.models as unknown as ProviderModelConfig[];
				throw error;
			}
		},
	});

	let statusUi: ExtensionUIContext | undefined;
	let statusTimer: ReturnType<typeof setTimeout> | undefined;
	let statusInFlight = false;
	let modelId: string | undefined;
	let lastActive = false;

	// Poll faster while the session is not active (cooling, expired, idle,
	// fetch failure) so the flip back to active is noticed sooner.
	const scheduleNext = () => {
		statusTimer = setTimeout(refreshStatus, lastActive ? POLL_MS : POLL_MS_INACTIVE);
	};

	const refreshStatus = async () => {
		if (!statusUi || statusInFlight) return;
		if (!modelId) {
			statusUi.setStatus(STATUS_KEY, undefined);
			scheduleNext();
			return;
		}
		// Snapshot the UI context: the session may shut down (and null it)
		// while the status fetch is in flight.
		const ui = statusUi;
		statusInFlight = true;
		const theme = ui.theme;
		try {
			const data = await fetchStatus();
			const token = data.token_state?.find((t) => t.session_model === modelId);
			lastActive = (token?.state ?? token?.session_status) === "active";
			const text = formatStatus(data, modelId);
			ui.setStatus(STATUS_KEY, text ? theme.fg("dim", text) : undefined);
		} catch {
			// Fetch failure: clear the status; banned/offline come from the API JSON.
			lastActive = false;
			ui.setStatus(STATUS_KEY, undefined);
		} finally {
			statusInFlight = false;
			scheduleNext();
		}
	};

	const trackModel = (provider: string | undefined, id: string | undefined) => {
		modelId = provider === "freebux" ? id : undefined;
		void refreshStatus();
	};

	const bind = (ctx: ExtensionContext) => {
		statusUi = ctx.ui;
		trackModel(ctx.model?.provider, ctx.model?.id);
	};

	pi.on("session_start", (_event, ctx) => {
		// bind() triggers an immediate refresh, which starts the poll chain.
		bind(ctx);
	});

	pi.on("model_select", (event, ctx) => {
		bind(ctx);
		trackModel(event.model.provider, event.model.id);
	});

	pi.on("session_shutdown", () => {
		clearTimeout(statusTimer);
		statusTimer = undefined;
		statusUi = undefined;
		modelId = undefined;
	});
}
