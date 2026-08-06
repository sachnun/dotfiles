import type {
	ExtensionAPI,
	ExtensionContext,
	ExtensionUIContext,
	ProviderModelConfig,
} from "@earendil-works/pi-coding-agent";
import type { Model, Api } from "@earendil-works/pi-ai";

const BASE_URL = "https://freebux.up.railway.app/v1";
const TIMEOUT_MS = 15_000;
const POLL_MS = 60_000;
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

function formatDuration(totalSeconds: number): string {
	const minutes = Math.max(1, Math.round(totalSeconds / 60));
	return minutes >= 60 ? `${Math.floor(minutes / 60)}h ${minutes % 60}m` : `${minutes}m`;
}

function formatStatus(data: StatusResponse, modelId: string): string | undefined {
	const token = data.token_state?.find((t) => t.session_model === modelId);
	if (!token) return "idle";

	const state = token.state ?? token.session_status;
	if (state !== "active") return state === "cooling_down" ? "cooling" : (state ?? "idle");

	const expires = token.session_expires_at ? Date.parse(token.session_expires_at) : Number.NaN;
	const secs = Number.isFinite(expires) ? Math.round((expires - Date.now()) / 1000) : undefined;

	// Quota per model (hours), older API shape: session_quota.
	const quota = token.quota_by_model?.[modelId] ?? token.session_quota;
	const quotaLimit = typeof quota?.limit === "number" && quota.limit > 0 ? quota.limit : 0;
	const quotaRemaining = typeof quota?.remaining === "number" ? Math.max(0, quota.remaining) : 0;

	// Total waktu: sisa kuota (jam) + sisa sesi (menit).
	if (quotaLimit > 0 && quotaRemaining > 0) {
		const totalMinutes = quotaRemaining * 60 + Math.max(0, Math.round((secs ?? 0) / 60));
		const hours = Math.floor(totalMinutes / 60);
		const minutes = totalMinutes % 60;
		return `active ${minutes > 0 ? `${hours}h ${minutes}m` : `${hours}h`}`;
	}

	if (secs === undefined) return "active";
	return secs <= 0 ? "expired" : `active ${formatDuration(secs)}`;
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
	let statusTimer: ReturnType<typeof setInterval> | undefined;
	let statusInFlight = false;
	let modelId: string | undefined;

	const refreshStatus = async () => {
		if (!statusUi || statusInFlight) return;
		if (!modelId) {
			statusUi.setStatus(STATUS_KEY, undefined);
			return;
		}
		// Snapshot the UI context: the session may shut down (and null it)
		// while the status fetch is in flight.
		const ui = statusUi;
		statusInFlight = true;
		const theme = ui.theme;
		try {
			const data = await fetchStatus();
			const text = formatStatus(data, modelId);
			const color: "dim" | "error" = text === "banned" ? "error" : "dim";
			ui.setStatus(STATUS_KEY, text ? theme.fg(color, text) : undefined);
		} catch {
			ui.setStatus(STATUS_KEY, theme.fg("warning", "offline"));
		} finally {
			statusInFlight = false;
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
		bind(ctx);
		statusTimer ??= setInterval(refreshStatus, POLL_MS);
	});

	pi.on("model_select", (event, ctx) => {
		bind(ctx);
		trackModel(event.model.provider, event.model.id);
	});

	pi.on("turn_start", (_event, ctx) => bind(ctx));
	pi.on("turn_end", (_event, ctx) => bind(ctx));

	pi.on("session_shutdown", () => {
		clearInterval(statusTimer);
		statusTimer = undefined;
		statusUi = undefined;
		modelId = undefined;
	});
}
