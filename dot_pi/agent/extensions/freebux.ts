import { homedir } from "node:os";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type {
	ExtensionAPI,
	ExtensionContext,
	ExtensionUIContext,
	ProviderModelConfig,
	ReadonlyFooterDataProvider,
	Theme,
} from "@earendil-works/pi-coding-agent";

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

interface TokenState {
	state?: string;
	session_status?: string;
	session_model?: string;
	session_expires_at?: string;
	session_quota?: { limit?: number; remaining?: number };
}

interface StatusResponse {
	available_models?: string[];
	token_state?: TokenState[];
}

interface Usage {
	input?: number;
	output?: number;
	cacheRead?: number;
	cacheWrite?: number;
	cost?: { total?: number };
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

	return {
		id,
		name: asString(model.display_name) ?? asString(model.name) ?? id,
		reasoning: true,
		input,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: asPositiveNumber(model.context_window, 272_000),
		maxTokens: asPositiveNumber(model.max_tokens, 16_384),
		thinkingLevelMap: { xhigh: "max", max: "max" },
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
	if (data.available_models && !data.available_models.includes(modelId)) return "inactive";

	const token = data.token_state?.find(
		(t) => t.session_model === modelId && (t.session_status === "active" || t.state === "active"),
	);
	if (!token) return "inactive";

	const expires = token.session_expires_at ? Date.parse(token.session_expires_at) : Number.NaN;
	const secs = Number.isFinite(expires) ? Math.round((expires - Date.now()) / 1000) : undefined;

	const { limit, remaining } = token.session_quota ?? {};
	const quotaRemaining = typeof remaining === "number" ? remaining : 0;
	const quotaLimit = typeof limit === "number" && limit > 0 ? limit : 0;

	// 1 quota unit = 1 hour. Combine with remaining session time into one value.
	if (quotaLimit > 0 && quotaRemaining > 0) {
		const totalMinutes = quotaRemaining * 60 + Math.max(0, Math.round((secs ?? 0) / 60));
		const hours = Math.floor(totalMinutes / 60);
		const minutes = totalMinutes % 60;
		return minutes > 0 ? `${hours}h ${minutes}m` : `${hours}h`;
	}

	if (secs !== undefined) return secs <= 0 ? "expired" : formatDuration(secs);
	if (quotaLimit > 0) return `${quotaRemaining}/${quotaLimit}h`;
	return undefined;
}

function renderFooter(
	ctx: ExtensionContext | undefined,
	theme: Theme,
	footerData: ReadonlyFooterDataProvider,
	width: number,
): string[] {
	if (!ctx) return [];

	// Line 1: pwd + branch + session name (left) with status right-aligned.
	const home = homedir();
	let pwd = ctx.sessionManager.getCwd();
	if (home && pwd.startsWith(home)) pwd = `~${pwd.slice(home.length)}`;
	const branch = footerData.getGitBranch();
	if (branch) pwd = `${pwd} (${branch})`;
	const sessionName = ctx.sessionManager.getSessionName();
	if (sessionName) pwd = `${pwd} • ${sessionName}`;
	const pwdText = theme.fg("dim", pwd);

	const statuses = Array.from(footerData.getExtensionStatuses().entries())
		.sort(([a], [b]) => a.localeCompare(b))
		.map(([, text]) => text.replace(/[\r\n\t]/g, " ").replace(/ +/g, " ").trim())
		.join(" ");

	const lines: string[] = [];
	if (statuses) {
		const pwdW = visibleWidth(pwdText);
		const statusW = visibleWidth(statuses);
		if (pwdW + 2 + statusW <= width) {
			lines.push(pwdText + " ".repeat(width - pwdW - statusW) + statuses);
		} else {
			lines.push(truncateToWidth(pwdText, width - statusW - 1, theme.fg("dim", "...")) + " " + statuses);
		}
	} else {
		lines.push(truncateToWidth(pwdText, width, theme.fg("dim", "...")));
	}

	// Line 2: token stats + model on the right.
	let input = 0,
		output = 0,
		cacheRead = 0,
		cacheWrite = 0,
		cost = 0;
	let hitRate: number | undefined;
	for (const entry of ctx.sessionManager.getBranch()) {
		const msg = (entry as { message?: { role?: string; usage?: Usage } }).message;
		if (!msg || !msg.usage || (msg.role !== "assistant" && msg.role !== "toolResult")) continue;
		input += msg.usage.input ?? 0;
		output += msg.usage.output ?? 0;
		cacheRead += msg.usage.cacheRead ?? 0;
		cacheWrite += msg.usage.cacheWrite ?? 0;
		cost += msg.usage.cost?.total ?? 0;
		if (msg.role === "assistant") {
			const prompt = (msg.usage.input ?? 0) + (msg.usage.cacheRead ?? 0) + (msg.usage.cacheWrite ?? 0);
			if (prompt > 0) hitRate = ((msg.usage.cacheRead ?? 0) / prompt) * 100;
		}
	}
	const fmt = (n: number) => (n < 1000 ? `${n}` : `${(n / 1000).toFixed(1)}k`);
	const parts: string[] = [];
	if (input) parts.push(`↑${fmt(input)}`);
	if (output) parts.push(`↓${fmt(output)}`);
	if (cacheRead) parts.push(`R${fmt(cacheRead)}`);
	if (cacheWrite) parts.push(`W${fmt(cacheWrite)}`);
	if ((cacheRead > 0 || cacheWrite > 0) && hitRate !== undefined) parts.push(`CH${hitRate.toFixed(1)}%`);
	if (cost > 0) parts.push(`$${cost.toFixed(3)}`);
	const usage = ctx.getContextUsage();
	const windowTokens = usage?.contextWindow ?? ctx.model?.contextWindow ?? 0;
	if (usage?.percent !== null && usage?.percent !== undefined) {
		const pct = usage.percent;
		const text = `${pct.toFixed(1)}%/${fmt(windowTokens)}`;
		parts.push(pct > 90 ? theme.fg("error", text) : pct > 70 ? theme.fg("warning", text) : text);
	} else {
		parts.push(`?/${fmt(windowTokens)}`);
	}
	const statsLeft = parts.join(" ");

	const model = ctx.model;
	let right = model?.id || "no-model";
	if (model?.reasoning) right += ` • ${ctx.thinkingLevel || "off"}`;
	if (footerData.getAvailableProviderCount() > 1 && model) right = `(${model.provider}) ${right}`;

	const leftW = visibleWidth(statsLeft);
	const rightW = visibleWidth(right);
	if (leftW + 2 + rightW <= width) {
		lines.push(theme.fg("dim", statsLeft) + " ".repeat(width - leftW - rightW) + theme.fg("dim", right));
	} else {
		lines.push(truncateToWidth(theme.fg("dim", `${statsLeft}  ${right}`), width, theme.fg("dim", "...")));
	}

	return lines;
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
		refreshModels: async ({ signal }) => fetchModels(signal),
	});

	// Footer status: time & quota for the freebux model in use.
	let statusUi: ExtensionUIContext | undefined;
	let statusTimer: ReturnType<typeof setInterval> | undefined;
	let statusInFlight = false;
	let modelId: string | undefined;

	// Custom footer: right-aligned status (setStatus cannot control position).
	let footerCtx: ExtensionContext | undefined;
	let footerInstalled = false;

	const installFooter = (ctx: ExtensionContext) => {
		footerCtx = ctx;
		if (footerInstalled) return;
		footerInstalled = true;
		ctx.ui.setFooter((tui, theme, footerData) => {
			const unsub = footerData.onBranchChange(() => tui.requestRender());
			return {
				dispose: unsub,
				invalidate() {},
				render(width: number): string[] {
					return renderFooter(footerCtx, theme, footerData, width);
				},
			};
		});
	};

	const refreshStatus = async () => {
		if (!statusUi || statusInFlight) return;
		if (!modelId) {
			statusUi.setStatus(STATUS_KEY, undefined);
			return;
		}
		statusInFlight = true;
		try {
			const data = await fetchStatus();
			const text = formatStatus(data, modelId);
			if (statusUi) statusUi.setStatus(STATUS_KEY, text ? statusUi.theme.fg("dim", text) : undefined);
		} catch {
			if (statusUi) statusUi.setStatus(STATUS_KEY, statusUi.theme.fg("dim", "offline"));
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
		installFooter(ctx);
		trackModel(ctx.model?.provider, ctx.model?.id);
	};

	pi.on("session_start", (_event, ctx) => {
		bind(ctx);
		statusTimer ??= setInterval(refreshStatus, POLL_MS);
	});

	pi.on("model_select", (event, ctx) => {
		statusUi = ctx.ui;
		installFooter(ctx);
		trackModel(event.model.provider, event.model.id);
	});

	pi.on("turn_start", (_event, ctx) => bind(ctx));
	pi.on("turn_end", (_event, ctx) => bind(ctx));

	pi.on("session_shutdown", () => {
		clearInterval(statusTimer);
		statusTimer = undefined;
		statusUi = undefined;
		modelId = undefined;
		footerCtx = undefined;
	});
}
