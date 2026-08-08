import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { highlightCode } from "@earendil-works/pi-coding-agent";
import { Container, Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { dirname, resolve } from "node:path";

/**
 * Existing-profile Chrome bridge for pi.
 *
 * This is intentionally not a remote-debugging-port integration. Chrome blocks default-profile
 * remote debugging in many normal launches, so pi-chrome uses a companion extension from the
 * browser-extension folder bundled next to this Pi extension.
 *
 * The companion extension runs inside the user's real Chrome profile and polls this local
 * pi extension for commands. That gives pi access to the user's existing tabs/authenticated
 * profile, subject to the browser extension permissions the user grants.
 *
 * The model gets ONE native tool (`chrome`): a raw Chrome DevTools Protocol passthrough
 * (action `page.cdp` in the companion extension). The tool schema is small and always active;
 * there is no skill and no CLI — the agent figures out the details from the CDP reference.
 * This file also runs the bridge + the ●/○ connection status indicator. Every chrome_* call
 * probes the extension first and fails fast with a red error when it is not connected,
 * so the command timeout only applies once the connection is confirmed.
 */

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

type BridgeCommand = {
	id: string;
	action: string;
	params: Record<string, unknown>;
};

type PendingCommand = {
	command: BridgeCommand;
	resolve: (value: unknown) => void;
	reject: (error: Error) => void;
	timer: NodeJS.Timeout;
	deliveredAt?: number;
};

type BridgeResult = {
	id: string;
	ok: boolean;
	result?: unknown;
	error?: string;
};

const PI_CHROME_PKG_PATH = resolve(__dirname, "..", "..", "package.json");
function readPiChromeVersion(): string {
	try {
		const pkg = JSON.parse(readFileSync(PI_CHROME_PKG_PATH, "utf8")) as { version?: string };
		if (pkg.version) return pkg.version;
	} catch {}
	return "0.0.0-dev";
}
const PI_CHROME_VERSION = readPiChromeVersion();
const PI_CHROME_GLOBAL_KEY = "__piChromeProfileBridgeLoaded__";
const DEFAULT_HOST = process.env.PI_CHROME_BRIDGE_HOST ?? "127.0.0.1";
const DEFAULT_PORT = Number(process.env.PI_CHROME_BRIDGE_PORT ?? "17318");
const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_TEXT_CHARS = 15_000;
// Extension long-poll wait: lower = fresher lastSeenAt and snappier SSE status events.
const POLL_WAIT_MS = 5_000;
// How stale lastSeenAt must be before the statusbar flips to disconnected (healthy polls
// arrive every ~5s, so 15s is a safe no-flap window).
const STATUS_STALE_MS = 15_000;

type ScriptCommand = { method: string; params?: Record<string, unknown>; save?: string; pick?: string } | { target: Record<string, unknown> };

// Parse the `commands` script: a JSON array (or single object) of {method, params?, save?} CDP
// calls plus optional {target:{urlIncludes|titleIncludes|targetId}} entries that switch the
// working tab for subsequent commands (like `cd` in bash).
function parseScript(raw: unknown): ScriptCommand[] {
	if (typeof raw !== "string" || !raw) {
		throw new Error(
			"chrome requires commands: a JSON array (or single object) of {method, params?} — e.g. '[{\"method\":\"Page.navigate\",\"params\":{\"url\":\"https://example.com\"}}]'",
		);
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		throw new Error("commands must be valid JSON — an array (or single object) of {method, params?} commands");
	}
	const list = Array.isArray(parsed) ? parsed : [parsed];
	const script: ScriptCommand[] = [];
	for (const item of list) {
		if (!item || typeof item !== "object" || Array.isArray(item)) {
			throw new Error("each command must be an object {method, params?} or {target:{...}}");
		}
		const cmd = item as Record<string, unknown>;
		if (cmd.target !== undefined) {
			if (!cmd.target || typeof cmd.target !== "object" || Array.isArray(cmd.target)) {
				throw new Error("{target} must be an object with urlIncludes | titleIncludes | targetId");
			}
			script.push({ target: cmd.target as Record<string, unknown> });
		} else {
			if (typeof cmd.method !== "string" || !/^[A-Za-z]+\.[A-Za-z]+$/.test(cmd.method)) {
				throw new Error(`invalid CDP method: ${String(cmd.method)}`);
			}
			script.push({
				method: cmd.method,
				params: cmd.params && typeof cmd.params === "object" && !Array.isArray(cmd.params) ? (cmd.params as Record<string, unknown>) : {},
				save: typeof cmd.save === "string" && cmd.save ? cmd.save : undefined,
				pick: typeof cmd.pick === "string" && cmd.pick ? cmd.pick : undefined,
			});
		}
	}
	return script;
}

// Extract a dot-path subtree from a value, e.g. "result.result.value" or "results.0.url".
// Array indices are numeric path segments; a missing segment yields undefined.
function applyPick(value: unknown, path: string): unknown {
	let current = value;
	for (const segment of path.split(".")) {
		if (current === null || current === undefined) return undefined;
		if (Array.isArray(current)) {
			const index = Number(segment);
			if (!Number.isInteger(index)) return undefined;
			current = current[index];
		} else if (typeof current === "object") {
			current = (current as Record<string, unknown>)[segment];
		} else {
			return undefined;
		}
	}
	return current;
}

function truncateText(text: unknown, maxChars = MAX_TEXT_CHARS): string {
  const value = String(text ?? "");
  if (value.length <= maxChars) return value;
  // Don't split a UTF-16 surrogate pair (emoji etc.) at the cut point.
  let end = maxChars;
  const code = value.charCodeAt(end - 1);
  if (code >= 0xd800 && code <= 0xdbff) end -= 1;
  return `${value.slice(0, end)}\n\n[truncated ${value.length - maxChars} characters]`;
}

// First saveable blob in a CDP result (recursive, shallow). Used by `save` to write binary
// output to a file: base64 blobs (Page.captureScreenshot / Page.printToPDF) or raw MHTML text
// (Page.captureSnapshot returns quoted-printable MHTML, not base64).
function findSaveableBlob(value: unknown, depth = 0): { data: string; encoding: "base64" | "utf8" } | undefined {
  if (depth > 4 || value === null || value === undefined) return undefined;
  if (typeof value === "string" && value.length > 500) {
    if (/^[A-Za-z0-9+/=\r\n]+$/.test(value)) return { data: value, encoding: "base64" };
    if (value.startsWith("From: <Saved by Blink>")) return { data: value, encoding: "utf8" };
    return undefined;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findSaveableBlob(item, depth + 1);
      if (found) return found;
    }
    return undefined;
  }
  if (typeof value === "object") {
    for (const key of Object.keys(value as Record<string, unknown>)) {
      const found = findSaveableBlob((value as Record<string, unknown>)[key], depth + 1);
      if (found) return found;
    }
  }
  return undefined;
}

function extensionRoot(): string {
	// Resolve relative to this extension file, not ctx.cwd. ctx.cwd can temporarily be
	// an attachment/clipboard path when Pi is handling pasted images.
	if (typeof __dirname === "string") return __dirname;
	return process.cwd();
}

function readRequestBody(request: IncomingMessage): Promise<string> {
	return new Promise((resolveBody, rejectBody) => {
		const chunks: Buffer[] = [];
		request.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
		request.on("end", () => resolveBody(Buffer.concat(chunks).toString("utf8")));
		request.on("error", rejectBody);
	});
}

function corsHeadersFor(request: IncomingMessage): Record<string, string> {
	const origin = String(request.headers.origin ?? "");
	if (!origin.startsWith("chrome-extension://")) return {};
	return {
		"access-control-allow-origin": origin,
		"access-control-allow-methods": "GET,POST,OPTIONS",
		"access-control-allow-headers": "content-type",
		"access-control-expose-headers": "x-pi-chrome-version",
		"vary": "origin",
	};
}

function isBrowserOriginAllowed(request: IncomingMessage): boolean {
	const origin = String(request.headers.origin ?? "");
	if (origin) return origin.startsWith("chrome-extension://");
	const secFetchSite = String(request.headers["sec-fetch-site"] ?? "");
	return !secFetchSite || secFetchSite === "none" || secFetchSite === "same-origin";
}

function isLocalProcessRequest(request: IncomingMessage): boolean {
	return !request.headers.origin && !request.headers["sec-fetch-site"];
}

function sendJson(response: ServerResponse, status: number, body: unknown, extraHeaders?: Record<string, string>): void {
	response.writeHead(status, {
		"content-type": "application/json; charset=utf-8",
		"cache-control": "no-store",
		...(extraHeaders ?? {}),
	});
	response.end(JSON.stringify(body));
}

class ChromeProfileBridge {
	private server: Server | undefined;
	private pending = new Map<string, PendingCommand>();
	private queue: BridgeCommand[] = [];
	private waiters: Array<(command: BridgeCommand | undefined) => void> = [];
	private lastSeenAt: number | undefined;
	private clientName: string | undefined;
	private mode: "server" | "client" | undefined;
	private sseClients = new Set<ServerResponse>();
	private sseState: "connected" | "disconnected" | undefined;
	private stalenessTimer: NodeJS.Timeout | undefined;

	constructor(
		private readonly host: string,
		private readonly port: number,
	) {}

	get url(): string {
		return `http://${this.host}:${this.port}`;
	}

	get connected(): boolean {
		// The companion extension polls /next almost continuously while its service worker is
		// alive, and a 30 s keepalive alarm wakes a suspended worker. So a live extension always
		// polls within ~30 s; treat a poll older than 60 s as disconnected (e.g. extension
		// disabled, Chrome closed). Real chrome_* tool calls are the end-to-end health check.
		return this.isFresh(60_000);
	}

	private isFresh(staleMs: number): boolean {
		return this.lastSeenAt !== undefined && Date.now() - this.lastSeenAt < staleMs;
	}

	// True when the Chrome companion extension is actively polling the bridge. In server mode
	// that is our own lastSeenAt. In client mode (another Pi session owns the port, so the
	// extension never talks to us) we ask the owner for its lastSeenAt and apply the same
	// staleness window — independent of the owner's code version.
	async probeConnected(staleMs = 60_000): Promise<boolean> {
		if (this.mode !== "client") return this.isFresh(staleMs);
		if (await this.probeOwner(staleMs)) return true;
		// Owner unreachable (its Pi session closed, or it just lost the port). Self-heal here
		// instead of waiting for a chrome_* command: grab the now-free port and become the
		// server so the extension reconnects to us and the ● indicator recovers on its own.
		// Only one client wins the bind; losers stay clients and probe whoever won.
		const promoted = await this.tryPromoteToServer().catch(() => false);
		if (promoted) return this.isFresh(staleMs);
		// Another client won the race mid-probe; re-check against the new owner.
		return this.probeOwner(staleMs);
	}

	private async probeOwner(staleMs = 60_000): Promise<boolean> {
		try {
			const response = await fetch(`${this.url}/status`, { cache: "no-store", signal: AbortSignal.timeout(3_000) });
			if (!response.ok) return false;
			const status = (await response.json()) as { lastSeenAt?: number };
			return typeof status.lastSeenAt === "number" && Date.now() - status.lastSeenAt < staleMs;
		} catch {
			return false;
		}
	}

	// ---- Real-time status (SSE) ----
	// Status events are pushed to local pi processes via GET /events, so the statusbar updates
	// the moment the extension polls (connected) or stops polling (disconnected) — no polling.
	private onExtensionSeen(): void {
		if (this.sseState !== "connected") {
			this.sseState = "connected";
			this.emitStatus();
		}
	}
	private checkStaleness(): void {
		const state =
			this.lastSeenAt !== undefined && Date.now() - this.lastSeenAt <= STATUS_STALE_MS ? "connected" : "disconnected";
		if (this.sseState !== state) {
			this.sseState = state;
			this.emitStatus();
		}
	}
	private emitStatus(): void {
		const frame = `data: ${JSON.stringify({ connected: this.sseState === "connected", lastSeenAt: this.lastSeenAt ?? null })}\n\n`;
		for (const client of this.sseClients) {
			try {
				client.write(frame);
			} catch {
				this.sseClients.delete(client);
			}
		}
	}

	status(): Record<string, unknown> {
		return {
			url: this.url,
			mode: this.mode ?? "starting",
			connected: this.connected,
			lastSeenAt: this.lastSeenAt,
			clientName: this.clientName,
			queuedCommands: this.queue.length,
			pendingCommands: this.pending.size,
		};
	}

	async start(): Promise<void> {
		if (this.server || this.mode === "client") return;
		await this.bindServerOrClient();
		if (this.mode === "server") {
			this.stalenessTimer = setInterval(() => this.checkStaleness(), 2_000);
			this.stalenessTimer.unref?.();
		}
	}

	// Try to own the bridge port. On success we are the server; on EADDRINUSE another Pi
	// session owns it and we run as a client that forwards commands to that owner.
	private async bindServerOrClient(): Promise<void> {
		const server = createServer((request, response) => {
			void this.handle(request, response).catch((error) => {
				sendJson(response, 500, { error: (error as Error).message });
			});
		});
		try {
			await new Promise<void>((resolveStart, rejectStart) => {
				server.once("error", rejectStart);
				server.listen(this.port, this.host, () => {
					server.off("error", rejectStart);
					resolveStart();
				});
			});
			this.server = server;
			this.mode = "server";
		} catch (error) {
			server.close();
			if ((error as NodeJS.ErrnoException).code !== "EADDRINUSE") throw error;
			// Another Pi session already owns the bridge port. Use it as the shared
			// machine-local broker so multiple Pi sessions can control Chrome at once.
			this.mode = "client";
		}
	}

	// Client-mode self-heal: when the owning Pi session disappears, fetches to its port fail
	// with `fetch failed` / ECONNREFUSED forever. Try to grab the now-free port and become the
	// server ourselves so chrome_* tools recover without a manual restart. Single-flight: the
	// 10 s status ticker and command forwarding can both trigger promotion concurrently, and
	// two overlapping binds would let the loser overwrite the winner's mode back to "client".
	private promoteInFlight: Promise<boolean> | undefined;
	private tryPromoteToServer(): Promise<boolean> {
		if (this.promoteInFlight) return this.promoteInFlight;
		this.promoteInFlight = this.doPromoteToServer().finally(() => {
			this.promoteInFlight = undefined;
		});
		return this.promoteInFlight;
	}

	private async doPromoteToServer(): Promise<boolean> {
		if (this.mode !== "client") return this.mode === "server";
		this.mode = undefined;
		await this.bindServerOrClient();
		return this.mode === "server";
	}

	stop(): void {
		if (this.mode === "client") {
			this.mode = undefined;
			return;
		}
		clearInterval(this.stalenessTimer);
		for (const pending of this.pending.values()) {
			clearTimeout(pending.timer);
			pending.reject(new Error("Chrome profile bridge stopped"));
		}
		this.pending.clear();
		this.queue = [];
		for (const waiter of this.waiters) waiter(undefined);
		this.waiters = [];
		// Close live SSE status streams so watchers unblock promptly instead of hanging on a
		// dead connection (server.close() alone leaves keep-alive responses open).
		for (const client of this.sseClients) {
			try {
				client.end();
			} catch {}
		}
		this.sseClients.clear();
		// Destroy ALL existing connections, not just the listener. server.close() only closes
		// connections that were idle at close-time; a keep-alive connection that was mid-poll
		// (the connector long-polls /next) stays open and the OLD handler keeps serving it. The
		// connector would then keep polling the dead bridge on its pooled connection forever
		// and never reach the next session's bridge on the same port. RST-ing everything forces
		// the connector's next poll onto a fresh connection that hits the new bridge.
		this.server?.closeAllConnections?.();
		this.server?.close();
		this.server = undefined;
		this.mode = undefined;
	}

	send(action: string, params: Record<string, unknown>, timeoutMs = DEFAULT_TIMEOUT_MS, signal?: AbortSignal): Promise<unknown> {
		if (this.mode === "client") return this.sendViaOwner(action, params, timeoutMs, signal);
		return this.sendLocal(action, params, timeoutMs, signal);
	}

	private sendLocal(action: string, params: Record<string, unknown>, timeoutMs = DEFAULT_TIMEOUT_MS, signal?: AbortSignal): Promise<unknown> {
		const id = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
		const command = { id, action, params };
		return new Promise((resolveCommand, rejectCommand) => {
			if (signal?.aborted) {
				rejectCommand(new Error("Chrome command aborted"));
				return;
			}
			const cleanupAbort = () => {
				if (signal) signal.removeEventListener("abort", onAbort);
			};
			const onAbort = () => {
				clearTimeout(timer);
				this.pending.delete(id);
				this.queue = this.queue.filter((queued) => queued.id !== id);
				cleanupAbort();
				rejectCommand(new Error("Chrome command aborted"));
			};
			const timer = setTimeout(() => {
				const entry = this.pending.get(id);
				this.pending.delete(id);
				this.queue = this.queue.filter((queued) => queued.id !== id);
				cleanupAbort();
				rejectCommand(new Error(this.timeoutMessage(entry, timeoutMs)));
			}, timeoutMs);
			this.pending.set(id, {
				command,
				resolve: (value) => { cleanupAbort(); resolveCommand(value); },
				reject: (err) => { cleanupAbort(); rejectCommand(err); },
				timer,
			});
			if (signal) signal.addEventListener("abort", onAbort, { once: true });
			this.enqueue(command);
		});
	}

	// Classify why a local command timed out so the agent isn't left guessing. The three
	// distinct failure modes are: extension never polled (not installed / not running),
	// extension polled but never picked up this command, and extension picked up the command
	// but never posted a result back (long-running action or a failed /result post).
	private timeoutMessage(entry: PendingCommand | undefined, timeoutMs: number): string {
		const pollAgeMs = this.lastSeenAt === undefined ? undefined : Date.now() - this.lastSeenAt;
		if (entry?.deliveredAt) {
			return `Timed out after ${timeoutMs}ms: the Chrome extension received the command but never returned a result. The action may be long-running, or the result post failed. Reload 'Pi' at chrome://extensions.`;
		}
		if (pollAgeMs === undefined || pollAgeMs > 60_000) {
			return `Timed out after ${timeoutMs}ms: the Chrome extension is not polling (last seen ${pollAgeMs === undefined ? "never" : Math.round(pollAgeMs / 1000) + "s ago"}). Load the bundled 'Pi' extension (the connector/ folder next to this Pi extension) in your normal Chrome profile and keep that Chrome window open.`;
		}
		return `Timed out after ${timeoutMs}ms: the Chrome extension is polling (last seen ${Math.round(pollAgeMs / 1000)}s ago) but did not pick up this command in time. Retry; if it persists, reload 'Pi' at chrome://extensions.`;
	}

	private async sendViaOwner(action: string, params: Record<string, unknown>, timeoutMs: number, signal?: AbortSignal): Promise<unknown> {
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), timeoutMs + 2_000);
		const forwardAbort = () => controller.abort();
		if (signal) {
			if (signal.aborted) controller.abort();
			else signal.addEventListener("abort", forwardAbort, { once: true });
		}
		try {
			const response = await fetch(`${this.url}/command`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ action, params, timeoutMs }),
				signal: controller.signal,
			});
			const payload = (await response.json().catch(() => ({}))) as { ok?: boolean; result?: unknown; error?: string };
			if (response.status === 404) {
				throw new Error(
					"A running Pi session owns the Chrome bridge but is using an older pi-chrome without multi-session support. Restart that Pi session after `pi update`, then retry.",
				);
			}
			if (!response.ok || !payload.ok) throw new Error(payload.error ?? `Chrome bridge owner HTTP ${response.status}`);
			return payload.result;
		} catch (error) {
			if ((error as Error).name === "AbortError") {
				if (signal?.aborted) throw new Error("Chrome command aborted");
				throw new Error(`Timed out waiting for shared Chrome bridge owner after ${timeoutMs}ms`);
			}
			// `fetch failed` / ECONNREFUSED means the Pi session that owned the bridge port is gone.
			// Try to take over the port ourselves and re-run the command locally instead of staying
			// stuck as a client pointed at a dead owner.
			if (this.isOwnerUnreachable(error)) {
				const promoted = await this.tryPromoteToServer().catch(() => false);
				if (promoted) return this.sendLocal(action, params, timeoutMs, signal);
				throw new Error(
					"The Pi session that owned the Chrome bridge is unreachable and this session could not take over the bridge port. Restart this Pi session.",
				);
			}
			throw error;
		} finally {
			clearTimeout(timer);
			if (signal) signal.removeEventListener("abort", forwardAbort);
		}
	}

	private isOwnerUnreachable(error: unknown): boolean {
		const message = (error as Error)?.message ?? "";
		const code = (error as NodeJS.ErrnoException)?.code ?? "";
		const cause = (error as { cause?: NodeJS.ErrnoException })?.cause;
		const causeCode = cause?.code ?? "";
		return (
			/fetch failed|ECONNREFUSED|ECONNRESET|other side closed|socket hang up/i.test(message) ||
			code === "ECONNREFUSED" ||
			causeCode === "ECONNREFUSED" ||
			causeCode === "ECONNRESET"
		);
	}

	private enqueue(command: BridgeCommand): void {
		const waiter = this.waiters.shift();
		if (waiter) waiter(command);
		else this.queue.push(command);
	}

	private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
		const url = new URL(request.url ?? "/", this.url);
		const corsHeaders = corsHeadersFor(request);
		if (request.method === "OPTIONS") {
			if (!isBrowserOriginAllowed(request)) {
				sendJson(response, 403, { ok: false, error: "browser origin not allowed" });
				return;
			}
			sendJson(response, 200, { ok: true }, corsHeaders);
			return;
		}
		if (request.method === "GET" && url.pathname === "/status") {
			sendJson(response, 200, this.status());
			return;
		}
		if (request.method === "POST" && url.pathname === "/command") {
			if (!isLocalProcessRequest(request)) {
				sendJson(response, 403, { ok: false, error: "Chrome commands are accepted only from local Pi processes" });
				return;
			}
			const body = JSON.parse(await readRequestBody(request)) as {
				action?: string;
				params?: Record<string, unknown>;
				timeoutMs?: number;
			};
			if (!body.action) {
				sendJson(response, 400, { ok: false, error: "Missing command action" });
				return;
			}
			try {
				const result = await this.sendLocal(body.action, body.params ?? {}, body.timeoutMs ?? DEFAULT_TIMEOUT_MS);
				sendJson(response, 200, { ok: true, result });
			} catch (error) {
				sendJson(response, 504, { ok: false, error: (error as Error).message });
			}
			return;
		}
		if (request.method === "GET" && url.pathname === "/next") {
			if (!isBrowserOriginAllowed(request)) {
				sendJson(response, 403, { ok: false, error: "browser origin not allowed" });
				return;
			}
			this.lastSeenAt = Date.now();
			this.onExtensionSeen();
			this.clientName = url.searchParams.get("name") ?? undefined;
			let aborted = false;
			let activeWaiter: ((command: BridgeCommand | undefined) => void) | undefined;
			request.once("close", () => {
				aborted = true;
				if (activeWaiter) this.waiters = this.waiters.filter((entry) => entry !== activeWaiter);
			});
			let command = this.queue.shift();
			if (!command) {
				command = await this.waitForCommand(POLL_WAIT_MS, (waiter) => {
					activeWaiter = waiter;
				});
			}
			if (aborted) {
				// Long-poll connection died before we could deliver. Requeue any command we pulled
				// so the next live /next picks it up instead of dropping it on the floor.
				if (command) this.queue.unshift(command);
				return;
			}
			// Mark the command as delivered so a later timeout can distinguish "extension never
			// picked it up" from "extension is running it / failed to post a result".
			if (command) {
				const entry = this.pending.get(command.id);
				if (entry) entry.deliveredAt = Date.now();
			}
			// Re-read version on every /next so bumping package.json takes effect without pi restart.
			const currentVersion = readPiChromeVersion();
			sendJson(
				response,
				200,
				command
					? { type: "command", command, expectedExtensionVersion: currentVersion }
					: { type: "none", expectedExtensionVersion: currentVersion },
				{ ...corsHeaders, "x-pi-chrome-version": currentVersion },
			);
			return;
		}
		if (request.method === "POST" && url.pathname === "/result") {
			if (!isBrowserOriginAllowed(request)) {
				sendJson(response, 403, { ok: false, error: "browser origin not allowed" });
				return;
			}
			this.lastSeenAt = Date.now();
			this.onExtensionSeen();
			const result = JSON.parse(await readRequestBody(request)) as BridgeResult;
			const pending = this.pending.get(result.id);
			if (!pending) {
				sendJson(response, 404, { ok: false, error: "unknown command id" }, corsHeaders);
				return;
			}
			clearTimeout(pending.timer);
			this.pending.delete(result.id);
			if (result.ok) pending.resolve(result.result);
			else pending.reject(new Error(result.error ?? "Chrome extension command failed"));
			sendJson(response, 200, { ok: true }, corsHeaders);
			return;
		}
		if (request.method === "GET" && url.pathname === "/events") {
			if (!isLocalProcessRequest(request)) {
				sendJson(response, 403, { ok: false, error: "not allowed" });
				return;
			}
			if (this.mode !== "server") {
				sendJson(response, 409, { ok: false, error: "not the bridge owner" });
				return;
			}
			response.writeHead(200, {
				"content-type": "text/event-stream",
				"cache-control": "no-store",
				"connection": "keep-alive",
			});
			this.checkStaleness();
			response.write(`data: ${JSON.stringify({ connected: this.sseState === "connected", lastSeenAt: this.lastSeenAt ?? null })}\n\n`);
			this.sseClients.add(response);
			request.on("close", () => this.sseClients.delete(response));
			return;
		}
		sendJson(response, 404, { error: "not found" });
	}

	private waitForCommand(
		timeoutMs: number,
		registerWaiter?: (waiter: (command: BridgeCommand | undefined) => void) => void,
	): Promise<BridgeCommand | undefined> {
		return new Promise((resolveWait) => {
			let settled = false;
			const waiter = (command: BridgeCommand | undefined) => {
				if (settled) return;
				settled = true;
				clearTimeout(timer);
				this.waiters = this.waiters.filter((entry) => entry !== waiter);
				resolveWait(command);
			};
			const timer = setTimeout(() => waiter(undefined), timeoutMs);
			this.waiters.push(waiter);
			registerWaiter?.(waiter);
		});
	}
}

export default function (pi: ExtensionAPI): void {
	const instanceToken = Symbol("pi-chrome-instance");
	const currentRoot = extensionRoot();
	const globalState = globalThis as typeof globalThis & {
		[PI_CHROME_GLOBAL_KEY]?: { version: string; root: string; token?: symbol };
	};
	const alreadyLoaded = globalState[PI_CHROME_GLOBAL_KEY];
	// Skip only a genuinely different pi-chrome copy (loaded from another extension root). A
	// stale flag pointing at this same root (e.g. left by pi-chrome <=0.15.19, which never
	// cleared it on reload) must not suppress the freshly reloaded instance — replace it
	// instead of skipping.
	if (alreadyLoaded && alreadyLoaded.root !== currentRoot) {
		console.warn(
			`pi-chrome already loaded from ${alreadyLoaded.root} (v${alreadyLoaded.version}); skipping duplicate from ${currentRoot}.`,
		);
		return;
	}
	globalState[PI_CHROME_GLOBAL_KEY] = { version: PI_CHROME_VERSION, root: currentRoot, token: instanceToken };

	const bridge = new ChromeProfileBridge(DEFAULT_HOST, DEFAULT_PORT);

	// The one native tool: raw Chrome DevTools Protocol passthrough. Registered once at load;
	// the bridge starts on demand. Description is intentionally concise — no skill, no CLI.
	// renderCall/renderResult follow the built-in-tool-renderer.ts example: compact header,
	// summary when collapsed, full output when expanded (ctrl+o / click).
	pi.registerTool({
		name: "chrome",
		label: "Chrome",
		description:
			"Control the user's real Chrome via a CDP script. commands: JSON array or single object of " +
			"{method, params?, save?}, run sequentially on one tab, stop at first CDP error. " +
			"{target:{urlIncludes|titleIncludes|targetId}} switches the working tab (like cd). " +
			"save:path writes binary (PDF/MHTML). pick:'dot.path' returns only that subtree " +
			"(full result if path misses). Output: single-line JSON. " +
			"Examples: read a page (trimmed): " +
			"'[{\"method\":\"Runtime.evaluate\",\"params\":{\"expression\":\"document.body.innerText.slice(0,3000)\",\"returnByValue\":true},\"pick\":\"result.value\"}]'; " +
			"batch: '[{\"target\":{\"urlIncludes\":\"example.com\"}},{\"method\":\"Page.navigate\",\"params\":{\"url\":\"https://example.com\"}},{\"method\":\"Runtime.evaluate\",\"params\":{\"expression\":\"document.title\",\"returnByValue\":true}}]'.",
		promptSnippet:
			"Drive the user's Chrome via raw CDP (navigate, read/run JS, click, type, emulate)",
		parameters: Type.Object({
			commands: Type.Optional(Type.String({ description: "CDP script: JSON array (or single object) of {method, params?, save?} run sequentially on one tab, stops on first CDP error; {target:{urlIncludes|titleIncludes|targetId}} switches the working tab (like cd)" })),
			timeoutMs: Type.Optional(Type.Number({ description: "Command timeout in ms (default 30000)" })),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			await bridge.start();
			const script = parseScript(params.commands);
			// Fast-fail on a dead connection instead of burning the full command timeout: if the
			// extension isn't polling, error immediately; the timeout below only applies once
			// the connection is confirmed. Same STATUS_STALE_MS window as the status indicator,
			// so the two never disagree.
			if (!(await bridge.probeConnected(STATUS_STALE_MS))) {
				throw new Error(
					"Chrome NOT connected — open Chrome and enable the 'Pi' extension at chrome://extensions.",
				);
			}
			const result = (await bridge.send(
				"page.cdp",
				{ commands: script },
				params.timeoutMs ?? DEFAULT_TIMEOUT_MS,
			)) as { method?: string; results?: Array<{ method?: string; result?: unknown; error?: string }> };
			const results = result?.results;
			if (!Array.isArray(results)) {
				throw new Error(`chrome: unexpected bridge result ${JSON.stringify(result).slice(0, 500)}`);
			}
			// Per-command save: zip script entries with results (same order and length).
			const saved: string[] = [];
			for (let i = 0; i < results.length; i++) {
				const cmd = script[i];
				const res = results[i];
				if (cmd && "save" in cmd && typeof cmd.save === "string" && cmd.save && res && !res.error) {
					const blob = findSaveableBlob(res.result);
					if (!blob) {
						throw new Error(`chrome: no saveable data for ${res.method ?? `command ${i + 1}`} result (expected base64 binary or MHTML)`);
					}
					const outputPath = resolve(ctx.cwd, cmd.save);
					await mkdir(dirname(outputPath), { recursive: true });
					const buf =
						blob.encoding === "base64"
							? Buffer.from(blob.data.replace(/\s+/g, ""), "base64")
							: Buffer.from(blob.data, "utf8");
					await writeFile(outputPath, buf);
					saved.push(`Saved ${res.method ?? `command ${i + 1}`} binary (${Math.round(buf.length / 1024)} KB) to ${outputPath}`);
				}
			}
			if (saved.length > 0) {
				return { content: [{ type: "text", text: saved.join("\n") }], details: { method: "cdp", kind: "file" } };
			}
			// Response trimming: output is always single-line JSON (token saver). pick = dot-path
			// subtree to return instead of the full result (optional, per command).
			const pickedValue = (res: { result?: unknown }, index: number): unknown => {
				const cmd = script[index];
				if (cmd && "pick" in cmd && cmd.pick) {
					// Safe pick: a missing path falls back to the full result instead of null.
					const picked = applyPick(res.result, cmd.pick);
					return picked === undefined ? res.result : picked;
				}
				return res.result;
			};
			// Single-command scripts render like a classic single call; multi-command as a batch.
			if (results.length === 1 && results[0].method) {
				if (results[0].error) throw new Error(`${results[0].method}: ${results[0].error}`);
				return {
					content: [{ type: "text", text: `CDP ${results[0].method}:\n${truncateText(JSON.stringify(pickedValue(results[0], 0)))}` }],
					details: { method: results[0].method, kind: "text" },
				};
			}
			const displayed = results.map((res, i) =>
				res && res.method && !res.error ? { method: res.method, result: pickedValue(res, i) } : res,
			);
			return {
				content: [{ type: "text", text: `CDP cdp.batch:\n${truncateText(JSON.stringify({ results: displayed }))}` }],
				details: { method: "cdp", kind: "text" },
			};
		},

		// 1-line header when collapsed; when expanded (ctrl+o / click), show the full input in
		// the same multi-line dim format as the expanded output.
		renderCall(args, theme, context) {
			const header = theme.fg("toolTitle", theme.bold("chrome "));
			if (!context.expanded) {
				let text = header;
				if (typeof args.commands === "string" && args.commands) {
					const snippet = args.commands.length > 40 ? `${args.commands.slice(0, 37)}...` : args.commands;
					text += theme.fg("dim", ` ${snippet}`);
				}
				return new Text(text, 0, 0);
			}
			let scriptText = typeof args.commands === "string" && args.commands ? args.commands : "{}";
			try {
				scriptText = JSON.stringify(JSON.parse(scriptText), null, 2);
			} catch {}
			const lines = scriptText.split("\n");
			let text = `${header}\n`;
			for (const line of lines.slice(0, 30)) text += `${theme.fg("dim", line)}\n`;
			if (lines.length > 30) text += theme.fg("muted", `... ${lines.length - 30} more lines`);
			return new Text(text, 0, 0);
		},

		// No summary label when collapsed (the header already shows chrome <method>);
		// full output only when expanded (ctrl+o / click), like built-in tools.
		renderResult(result, { expanded, isPartial }, theme, context) {
			if (isPartial) return new Text(theme.fg("warning", "Running..."), 0, 0);
			const content = result.content[0];
			const output = content?.type === "text" ? content.text : "";
			const details = result.details as { method?: string; kind?: string } | undefined;
			if (context?.isError || output.startsWith("chrome:") || output.startsWith("Error")) {
				return new Text(theme.fg("error", output.split("\n")[0].slice(0, 120)), 0, 0);
			}
			const method = details?.method ?? "CDP";
			if (details?.kind === "file") {
				return new Text(theme.fg("success", `${method} → ${output}`), 0, 0);
			}
			if (!expanded) return new Container();
			// The model-facing text is compact (single-line JSON); re-pretty-print and syntax-highlight
			// it for the TUI so expanded output stays readable for humans.
			const lines = output.split("\n");
			const header = lines[0] ?? "";
			const truncated = /\[truncated \d+ characters\]/.test(output);
			const body = lines.slice(1).join("\n").replace(/\n\n\[truncated \d+ characters\]$/, "");
			let prettyBody: string | null = null;
			try {
				prettyBody = JSON.stringify(JSON.parse(body), null, 2);
			} catch {
				prettyBody = null;
			}
			const highlighted = highlightCode(prettyBody ?? body, "json");
			let text = `${theme.fg("dim", header)}\n`;
			for (const line of highlighted.slice(0, 30)) text += `${line}\n`;
			if (highlighted.length > 30) text += theme.fg("muted", `... ${highlighted.length - 30} more lines`);
			if (truncated) text += theme.fg("muted", "\n[truncated output — see tool result for full data]");
			return new Text(text, 0, 0);
		},
	});

	// Stable per-session key the service worker uses to scope its dedicated automation tab/window
	// to *this* session (one extension brokers all sessions). The session id is stable across
	// /reload, so the automation target is reused rather than orphaned. Undefined only before
	// session_start, in which case the worker uses its default bucket.
	const sessionKeyFor = (ctx: ExtensionContext): string | undefined => {
		const id = ctx.sessionManager?.getSessionId?.();
		return typeof id === "string" && id ? `session:${id}` : undefined;
	};
	// Current session's automation bucket, captured as plain data (never a ctx) so shutdown
	// cleanup never touches a ctx that may already be invalidated by session replacement.
	let currentSessionKey: string | undefined;

	// Close THIS session's dedicated automation window/tab. Fire-and-forget and best-effort: it
	// must never block /quit, /reload, or session end, and the service-worker side only ever
	// closes targets this session created itself (never user tabs/windows, never another
	// session's target). Errors (bridge down, target already closed) are intentionally swallowed.
	const cleanupAutomationTargetBestEffort = (): void => {
		void bridge.send("automation.cleanup", currentSessionKey !== undefined ? { sessionKey: currentSessionKey } : {}, 3_000).catch(() => undefined);
	};

	// Drives the ●/○ connection status indicator. The chrome capability itself is the native
	// `chrome` tool registered above — no skill, no CLI.
	// The indicator watches the BRIDGE PORT with a lightweight /status probe every couple of
	// seconds. A raw TCP connect alone is not enough: the port stays up while any Pi session
	// runs, even when the Chrome extension is disabled — only the bridge's lastSeenAt (fed by
	// the extension's /next polls) reflects whether the extension is actually connected. One
	// /status request covers both: port down → fetch fails instantly; port up but extension
	// silent for STATUS_STALE_MS → ○. probeConnected() also handles client mode (owner probe)
	// and self-heal promotion.
	// The probe never captures a ctx — it reads a current-ctx slot that session_start sets and
	// session_shutdown clears, so a probe still in flight during shutdown becomes a no-op
	// instead of touching a stale ctx (which throws after session replacement).
	let statusCtx: ExtensionContext | undefined;
	let statusTimer: NodeJS.Timeout | undefined;
	const setStatusConnected = (connected: boolean): void => {
		const ctx = statusCtx;
		if (!ctx) return;
		ctx.ui.setStatus(
			"chrome",
			connected
				? ctx.ui.theme.fg("success", "●") + ctx.ui.theme.fg("dim", " chrome")
				: ctx.ui.theme.fg("dim", "○ chrome"),
		);
	};
	const probeStatus = async (): Promise<void> => {
		try {
			setStatusConnected(await bridge.probeConnected(STATUS_STALE_MS));
		} catch {
			setStatusConnected(false);
		}
	};

	pi.on("session_start", async (_event, ctx) => {
		currentSessionKey = sessionKeyFor(ctx);
		statusCtx = ctx;
		await bridge.start();
		// Initial status from a live probe; the port watcher keeps it fresh.
		await probeStatus();
		if (!statusTimer) {
			statusTimer = setInterval(() => void probeStatus(), 2_000);
			statusTimer.unref?.();
		}
	});

	// No skill registration: the `chrome` tool above is the only model-facing surface.
	pi.on("session_shutdown", (event) => {
		// Stop the port watcher and invalidate its ctx slot *first*, so a probe still in flight
		// becomes a no-op instead of touching a stale ctx and crashing pi.
		if (statusTimer) {
			clearInterval(statusTimer);
			statusTimer = undefined;
		}
		statusCtx = undefined;
		// Tidy up this session's dedicated automation window on real session end, but NOT on
		// "reload": /reload tears down and re-evaluates this module while the *same* session
		// (same sessionKey) continues, so we keep the window so it is reused, not churned. The
		// call is fire-and-forget and runs before bridge.stop() so it never blocks shutdown.
		// (Owner-session quit may not deliver in time since stop() closes the bridge server;
		// that only ever leaves a clearly pi-chrome window for the user to close — never a user
		// tab.)
		if (event?.reason !== "reload") cleanupAutomationTargetBestEffort();
		bridge.stop();
		if (globalState[PI_CHROME_GLOBAL_KEY]?.token === instanceToken) {
			delete globalState[PI_CHROME_GLOBAL_KEY];
		}
	});
}
