import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { resolve } from "node:path";
const PI_CHROME_PKG_PATH = resolve(__dirname, "..", "..", "package.json");
function readPiChromeVersion() {
    try {
        const pkg = JSON.parse(readFileSync(PI_CHROME_PKG_PATH, "utf8"));
        if (pkg.version)
            return pkg.version;
    }
    catch { }
    return "0.0.0-dev";
}
const PI_CHROME_VERSION = readPiChromeVersion();
const PI_CHROME_GLOBAL_KEY = "__piChromeProfileBridgeLoaded__";
const DEFAULT_HOST = process.env.PI_CHROME_BRIDGE_HOST ?? "127.0.0.1";
const DEFAULT_PORT = Number(process.env.PI_CHROME_BRIDGE_PORT ?? "17318");
const DEFAULT_TIMEOUT_MS = 30000;
function extensionRoot() {
    // Resolve relative to this extension file, not ctx.cwd. ctx.cwd can temporarily be
    // an attachment/clipboard path when Pi is handling pasted images.
    if (typeof __dirname === "string")
        return __dirname;
    return process.cwd();
}
function readRequestBody(request) {
    return new Promise((resolveBody, rejectBody) => {
        const chunks = [];
        request.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
        request.on("end", () => resolveBody(Buffer.concat(chunks).toString("utf8")));
        request.on("error", rejectBody);
    });
}
function corsHeadersFor(request) {
    const origin = String(request.headers.origin ?? "");
    if (!origin.startsWith("chrome-extension://"))
        return {};
    return {
        "access-control-allow-origin": origin,
        "access-control-allow-methods": "GET,POST,OPTIONS",
        "access-control-allow-headers": "content-type",
        "access-control-expose-headers": "x-pi-chrome-version",
        "vary": "origin",
    };
}
function isBrowserOriginAllowed(request) {
    const origin = String(request.headers.origin ?? "");
    if (origin)
        return origin.startsWith("chrome-extension://");
    const secFetchSite = String(request.headers["sec-fetch-site"] ?? "");
    return !secFetchSite || secFetchSite === "none" || secFetchSite === "same-origin";
}
function isLocalProcessRequest(request) {
    return !request.headers.origin && !request.headers["sec-fetch-site"];
}
function sendJson(response, status, body, extraHeaders) {
    response.writeHead(status, {
        "content-type": "application/json; charset=utf-8",
        "cache-control": "no-store",
        ...(extraHeaders ?? {}),
    });
    response.end(JSON.stringify(body));
}
class ChromeProfileBridge {
    host;
    port;
    server;
    pending = new Map();
    queue = [];
    waiters = [];
    lastSeenAt;
    clientName;
    mode;
    constructor(host, port) {
        this.host = host;
        this.port = port;
    }
    get url() {
        return `http://${this.host}:${this.port}`;
    }
    get connected() {
        // The companion extension polls /next almost continuously while its service worker is
        // alive, and a 30 s keepalive alarm wakes a suspended worker. So a live extension always
        // polls within ~30 s; treat a poll older than 60 s as disconnected (e.g. extension
        // disabled, Chrome closed). Real chrome_* tool calls are the end-to-end health check.
        return this.lastSeenAt !== undefined && Date.now() - this.lastSeenAt < 60000;
    }
    // True when the Chrome companion extension is actively polling the bridge. In server mode
    // that is our own lastSeenAt. In client mode (another Pi session owns the port, so the
    // extension never talks to us) we ask the owner for its lastSeenAt and apply our own
    // staleness window — independent of the owner's code version.
    async probeConnected() {
        if (this.mode !== "client")
            return this.connected;
        try {
            const response = await fetch(`${this.url}/status`, { cache: "no-store", signal: AbortSignal.timeout(3000) });
            if (!response.ok)
                return false;
            const status = (await response.json());
            return typeof status.lastSeenAt === "number" && Date.now() - status.lastSeenAt < 60000;
        }
        catch {
            return false;
        }
    }
    status() {
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
    async start() {
        if (this.server || this.mode === "client")
            return;
        await this.bindServerOrClient();
    }
    // Try to own the bridge port. On success we are the server; on EADDRINUSE another Pi
    // session owns it and we run as a client that forwards commands to that owner.
    async bindServerOrClient() {
        const server = createServer((request, response) => {
            void this.handle(request, response).catch((error) => {
                sendJson(response, 500, { error: error.message });
            });
        });
        try {
            await new Promise((resolveStart, rejectStart) => {
                server.once("error", rejectStart);
                server.listen(this.port, this.host, () => {
                    server.off("error", rejectStart);
                    resolveStart();
                });
            });
            this.server = server;
            this.mode = "server";
        }
        catch (error) {
            server.close();
            if (error.code !== "EADDRINUSE")
                throw error;
            // Another Pi session already owns the bridge port. Use it as the shared
            // machine-local broker so multiple Pi sessions can control Chrome at once.
            this.mode = "client";
        }
    }
    // Client-mode self-heal: when the owning Pi session disappears, fetches to its port fail
    // with `fetch failed` / ECONNREFUSED forever. Try to grab the now-free port and become the
    // server ourselves so chrome_* tools recover without a manual restart.
    async tryPromoteToServer() {
        if (this.mode !== "client")
            return this.mode === "server";
        this.mode = undefined;
        await this.bindServerOrClient();
        return this.mode === "server";
    }
    stop() {
        if (this.mode === "client") {
            this.mode = undefined;
            return;
        }
        for (const pending of this.pending.values()) {
            clearTimeout(pending.timer);
            pending.reject(new Error("Chrome profile bridge stopped"));
        }
        this.pending.clear();
        this.queue = [];
        for (const waiter of this.waiters)
            waiter(undefined);
        this.waiters = [];
        this.server?.close();
        this.server = undefined;
        this.mode = undefined;
    }
    send(action, params, timeoutMs = DEFAULT_TIMEOUT_MS, signal) {
        if (this.mode === "client")
            return this.sendViaOwner(action, params, timeoutMs, signal);
        return this.sendLocal(action, params, timeoutMs, signal);
    }
    sendLocal(action, params, timeoutMs = DEFAULT_TIMEOUT_MS, signal) {
        const id = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
        const command = { id, action, params };
        return new Promise((resolveCommand, rejectCommand) => {
            if (signal?.aborted) {
                rejectCommand(new Error("Chrome command aborted"));
                return;
            }
            const cleanupAbort = () => {
                if (signal)
                    signal.removeEventListener("abort", onAbort);
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
            if (signal)
                signal.addEventListener("abort", onAbort, { once: true });
            this.enqueue(command);
        });
    }
    // Classify why a local command timed out so the agent isn't left guessing. The three
    // distinct failure modes are: extension never polled (not installed / not running),
    // extension polled but never picked up this command, and extension picked up the command
    // but never posted a result back (long-running action or a failed /result post).
    timeoutMessage(entry, timeoutMs) {
        const pollAgeMs = this.lastSeenAt === undefined ? undefined : Date.now() - this.lastSeenAt;
        if (entry?.deliveredAt) {
            return `Timed out after ${timeoutMs}ms: the Chrome extension received the command but never returned a result. The action may be long-running, or the result post failed. Reload 'Pi' at chrome://extensions.`;
        }
        if (pollAgeMs === undefined || pollAgeMs > 60000) {
            return `Timed out after ${timeoutMs}ms: the Chrome extension is not polling (last seen ${pollAgeMs === undefined ? "never" : Math.round(pollAgeMs / 1000) + "s ago"}). Load the bundled 'Pi' extension (the connector/ folder next to this Pi extension) in your normal Chrome profile and keep that Chrome window open.`;
        }
        return `Timed out after ${timeoutMs}ms: the Chrome extension is polling (last seen ${Math.round(pollAgeMs / 1000)}s ago) but did not pick up this command in time. Retry; if it persists, reload 'Pi' at chrome://extensions.`;
    }
    async sendViaOwner(action, params, timeoutMs, signal) {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeoutMs + 2000);
        const forwardAbort = () => controller.abort();
        if (signal) {
            if (signal.aborted)
                controller.abort();
            else
                signal.addEventListener("abort", forwardAbort, { once: true });
        }
        try {
            const response = await fetch(`${this.url}/command`, {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ action, params, timeoutMs }),
                signal: controller.signal,
            });
            const payload = (await response.json().catch(() => ({})));
            if (response.status === 404) {
                throw new Error("A running Pi session owns the Chrome bridge but is using an older pi-chrome without multi-session support. Restart that Pi session after `pi update`, then retry.");
            }
            if (!response.ok || !payload.ok)
                throw new Error(payload.error ?? `Chrome bridge owner HTTP ${response.status}`);
            return payload.result;
        }
        catch (error) {
            if (error.name === "AbortError") {
                if (signal?.aborted)
                    throw new Error("Chrome command aborted");
                throw new Error(`Timed out waiting for shared Chrome bridge owner after ${timeoutMs}ms`);
            }
            // `fetch failed` / ECONNREFUSED means the Pi session that owned the bridge port is gone.
            // Try to take over the port ourselves and re-run the command locally instead of staying
            // stuck as a client pointed at a dead owner.
            if (this.isOwnerUnreachable(error)) {
                const promoted = await this.tryPromoteToServer().catch(() => false);
                if (promoted)
                    return this.sendLocal(action, params, timeoutMs, signal);
                throw new Error("The Pi session that owned the Chrome bridge is unreachable and this session could not take over the bridge port. Restart this Pi session.");
            }
            throw error;
        }
        finally {
            clearTimeout(timer);
            if (signal)
                signal.removeEventListener("abort", forwardAbort);
        }
    }
    isOwnerUnreachable(error) {
        const message = error?.message ?? "";
        const code = error?.code ?? "";
        const cause = error?.cause;
        const causeCode = cause?.code ?? "";
        return (/fetch failed|ECONNREFUSED|ECONNRESET|other side closed|socket hang up/i.test(message) ||
            code === "ECONNREFUSED" ||
            causeCode === "ECONNREFUSED" ||
            causeCode === "ECONNRESET");
    }
    enqueue(command) {
        const waiter = this.waiters.shift();
        if (waiter)
            waiter(command);
        else
            this.queue.push(command);
    }
    async handle(request, response) {
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
            const body = JSON.parse(await readRequestBody(request));
            if (!body.action) {
                sendJson(response, 400, { ok: false, error: "Missing command action" });
                return;
            }
            try {
                const result = await this.sendLocal(body.action, body.params ?? {}, body.timeoutMs ?? DEFAULT_TIMEOUT_MS);
                sendJson(response, 200, { ok: true, result });
            }
            catch (error) {
                sendJson(response, 504, { ok: false, error: error.message });
            }
            return;
        }
        if (request.method === "GET" && url.pathname === "/next") {
            if (!isBrowserOriginAllowed(request)) {
                sendJson(response, 403, { ok: false, error: "browser origin not allowed" });
                return;
            }
            this.lastSeenAt = Date.now();
            this.clientName = url.searchParams.get("name") ?? undefined;
            let aborted = false;
            let activeWaiter;
            request.once("close", () => {
                aborted = true;
                if (activeWaiter)
                    this.waiters = this.waiters.filter((entry) => entry !== activeWaiter);
            });
            let command = this.queue.shift();
            if (!command) {
                command = await this.waitForCommand(25000, (waiter) => {
                    activeWaiter = waiter;
                });
            }
            if (aborted) {
                // Long-poll connection died before we could deliver. Requeue any command we pulled
                // so the next live /next picks it up instead of dropping it on the floor.
                if (command)
                    this.queue.unshift(command);
                return;
            }
            // Mark the command as delivered so a later timeout can distinguish "extension never
            // picked it up" from "extension is running it / failed to post a result".
            if (command) {
                const entry = this.pending.get(command.id);
                if (entry)
                    entry.deliveredAt = Date.now();
            }
            // Re-read version on every /next so bumping package.json takes effect without pi restart.
            const currentVersion = readPiChromeVersion();
            sendJson(response, 200, command
                ? { type: "command", command, expectedExtensionVersion: currentVersion }
                : { type: "none", expectedExtensionVersion: currentVersion }, { ...corsHeaders, "x-pi-chrome-version": currentVersion });
            return;
        }
        if (request.method === "POST" && url.pathname === "/result") {
            if (!isBrowserOriginAllowed(request)) {
                sendJson(response, 403, { ok: false, error: "browser origin not allowed" });
                return;
            }
            this.lastSeenAt = Date.now();
            const result = JSON.parse(await readRequestBody(request));
            const pending = this.pending.get(result.id);
            if (!pending) {
                sendJson(response, 404, { ok: false, error: "unknown command id" }, corsHeaders);
                return;
            }
            clearTimeout(pending.timer);
            this.pending.delete(result.id);
            if (result.ok)
                pending.resolve(result.result);
            else
                pending.reject(new Error(result.error ?? "Chrome extension command failed"));
            sendJson(response, 200, { ok: true }, corsHeaders);
            return;
        }
        sendJson(response, 404, { error: "not found" });
    }
    waitForCommand(timeoutMs, registerWaiter) {
        return new Promise((resolveWait) => {
            let settled = false;
            const waiter = (command) => {
                if (settled)
                    return;
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
export default function (pi) {
    const instanceToken = Symbol("pi-chrome-instance");
    const currentRoot = extensionRoot();
    const globalState = globalThis;
    const alreadyLoaded = globalState[PI_CHROME_GLOBAL_KEY];
    if (alreadyLoaded?.token || (alreadyLoaded && alreadyLoaded.root !== currentRoot)) {
        console.warn(`pi-chrome already loaded from ${alreadyLoaded.root} (v${alreadyLoaded.version}); skipping duplicate from ${currentRoot}.`);
        return;
    }
    // pi-chrome <=0.15.19 set the singleton flag but did not clear it on reload.
    // If the stale flag points at this same extension root, replace it instead of
    // skipping the freshly reloaded extension.
    globalState[PI_CHROME_GLOBAL_KEY] = { version: PI_CHROME_VERSION, root: currentRoot, token: instanceToken };
    const bridge = new ChromeProfileBridge(DEFAULT_HOST, DEFAULT_PORT);
    let statusTicker;
    // Remembered so session-scoped sends can tag tabs with this session's group even when ctx isn't handy.
    let sessionCtx;
    // Stable per-session key the service worker uses to scope its dedicated automation tab/window
    // to *this* session (one extension brokers all sessions). The session id is stable across
    // /reload, so the automation target is reused rather than orphaned. Returns undefined only
    // before session_start, in which case the worker uses its default bucket.
    const sessionKeyFor = (ctx) => {
        const id = ctx?.sessionManager?.getSessionId?.();
        return typeof id === "string" && id ? `session:${id}` : undefined;
    };
    // Close THIS session's dedicated automation window/tab. Fire-and-forget and best-effort: it
    // must never block /quit, /reload, or session end, and the service-worker side only ever
    // closes targets this session created itself (never user tabs/windows, never another
    // session's target). Errors (bridge down, target already closed) are intentionally swallowed.
    const cleanupAutomationTargetBestEffort = () => {
        const sessionKey = sessionKeyFor(sessionCtx);
        void bridge.send("automation.cleanup", sessionKey !== undefined ? { sessionKey } : {}, 3000).catch(() => undefined);
    };
    // Drives the ●/○ connection status indicator. The chrome_* capability itself is loaded
    // on-demand via the `chrome` skill (see ~/.pi/agent/skills/chrome/SKILL.md), so there are
    // no tools to enable/disable here.
    const refreshChromeStatus = async (ctx) => {
        if (await bridge.probeConnected()) {
            ctx.ui.setStatus("chrome", ctx.ui.theme.fg("success", "●") + ctx.ui.theme.fg("dim", " chrome"));
        }
        else {
            ctx.ui.setStatus("chrome", ctx.ui.theme.fg("dim", "○ chrome"));
        }
    };
    pi.on("session_start", async (_event, ctx) => {
        sessionCtx = ctx;
        await bridge.start();
        await refreshChromeStatus(ctx);
        // Refresh the status indicator every 10 s (the companion extension polls the bridge
        // every second; connected = polled within the last 60 s).
        clearInterval(statusTicker);
        statusTicker = setInterval(() => void refreshChromeStatus(ctx), 10000);
    });
    // The chrome capability is deliberately NOT registered as a pi skill, so no /skill:chrome
    // command appears and nothing is listed under skills in the startup header. Instead, while
    // Chrome is connected we inject a one-line pointer into the system prompt; the agent reads
    // the SKILL.md manual only when it actually needs to control Chrome (progressive disclosure
    // with zero command/UI clutter). When Chrome is disconnected nothing is injected at all.
    const CHROME_POINTER = `
<chrome-control>
Chrome control is available through the pi-chrome bridge (companion extension "Pi" in the user's Chrome). When the user asks you to open, read, or operate Chrome, a website, or a web page, read the manual at ~/.pi/agent/extensions/chrome/skill/chrome/SKILL.md and drive the CLI at ~/.pi/agent/extensions/chrome/skill/chrome/chrome.ts.
</chrome-control>`;
    pi.on("before_agent_start", async (event) => {
        if (!(await bridge.probeConnected())) {
            return { systemPrompt: event.systemPrompt };
        }
        return { systemPrompt: event.systemPrompt + CHROME_POINTER };
    });
    pi.on("session_shutdown", (event) => {
        clearInterval(statusTicker);
        // Tidy up this session's dedicated automation window on real session end, but NOT on
        // "reload": /reload tears down and re-evaluates this module while the *same* session
        // (same sessionKey) continues, so we keep the window so it is reused, not churned. The
        // call is fire-and-forget and runs before bridge.stop() so it never blocks shutdown.
        // (Owner-session quit may not deliver in time since stop() closes the bridge server;
        // that only ever leaves a clearly pi-chrome window for the user to close — never a user
        // tab.)
        if (event?.reason !== "reload")
            cleanupAutomationTargetBestEffort();
        bridge.stop();
        if (globalState[PI_CHROME_GLOBAL_KEY]?.token === instanceToken) {
            delete globalState[PI_CHROME_GLOBAL_KEY];
        }
    });
}
