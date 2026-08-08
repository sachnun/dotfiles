/**
 * Telegram bridge — minimalist pi extension (zero deps).
 *
 * Turns a private Telegram DM into a mobile operator surface for the running
 * pi session. Requires Telegram private-chat Threaded Mode (BotFather →
 * /mybots → bot → Bot Settings → Threaded Mode).
 *
 * Lifecycle (one Telegram thread per pi session, random name from the
 * palette, like upstream):
 *   - session_start (startup) → status stays hidden; connect via /telegram
 *   - session_shutdown (quit) → delete that thread via deleteForumTopic
 *     (session replacements like /new, /reload, /resume keep the thread)
 *   - the pi status bar shows "<threadName> · <state>" (e.g. "Timber · idle")
 *
 * Single-device model (strict, no file sync):
 *   - Telegram allows concurrent getUpdates (no 409 conflict), so leadership
 *     is explicit: the bot's bio (profile short description) is the shared
 *     leader marker. On connect each device writes "pi:leader:<deviceId>",
 *     waits, and verifies it was not overwritten; the active leader
 *     re-checks every few seconds and steps down when another device takes
 *     over.
 *   - same device, many sessions: one session per device polls (leader);
 *     every session gets its own thread. The leader routes messages in the
 *     other sessions' threads to their inboxes; a child drains its inbox
 *     and answers in its own thread. Local leader.json + pid in tmp/
 *     arbitrates; when the leader disconnects or dies, a child takes over
 *     automatically (unless another device holds the bio marker).
 *   - the device that wrote last wins; the previous leader fully disconnects
 *     (deletes its session thread, stays off until /telegram is run again),
 *     and its standby children are kicked the same way — another device's
 *     marker means this device is out entirely, no follower mode. The marker
 *     is only cleared by the device that owns it: a device that never
 *     connected, or was already kicked, never wipes it on quit.
 *   - the marker also records the leader's thread id, so the next leader
 *     deletes the stale thread on connect (crash orphans auto-cleaned).
 *   - no cross-device file sync: token, pairing, offset and the device id
 *     are all local to each device; set up each device with /telegram.
 *
 * pi command:
 *   /telegram  → login (set token), connect directly, or disconnect/logout
 *     (no auto-connect — connection is manual via /telegram)
 *
 * Telegram commands (owner only):
 *   /start  → pair owner (first user) + status
 *   /stop   → abort the current pi run
 *
 * (No /new or /reload: pi 0.84's public extension API cannot trigger a full
 * new session or extension reload from the polling loop — ctx.newSession()
 * and ctx.reload() are command-context-only. Run them in the terminal.)
 *
 * Outbound (verbose): thinking is streamed by default as a headerless
 * expandable blockquote (like upstream), the tool activity feed
 * (tool + result lines), and the final answer as a Rich Message (Rich
 * Markdown). While streaming, a Rich Draft preview is animated every ~2s.
 * Tools: none — the assistant can't push files or buttons to Telegram.
 *
 * Notes on pi 0.84 API limits (verified empirically):
 *   - pi.sendUserMessage("/cmd") does NOT dispatch extension commands
 *     (sendUserMessage forces expandPromptTemplates:false). So Telegram
 *     control commands are handled directly in the polling loop.
 *   - ctx.newSession()/ctx.reload() exist only on ExtensionCommandContext,
 *     unreachable from the polling loop. A real /new (fresh LLM context) or
 *     extension reload from Telegram is therefore impossible; use the
 *     terminal for those.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { randomBytes } from "node:crypto";
import { appendFile, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import {
	escapeHtml,
	sanitizeFilename,
	splitMessage,
	sleep,
	TgClient,
	type TgMessage,
	type TgUpdate,
} from "./telegram.ts";

const CONFIG_FILE = join(homedir(), ".pi", "agent", "telegram.json");
const TMP_DIR = join(homedir(), ".pi", "agent", "tmp", "telegram");
// Volatile runtime state (offset, file downloads) lives outside telegram.json
// and is local to this device — no cross-device sync by design.
const OFFSET_FILE = join(TMP_DIR, "offset.json"); // local polling offset (per device)
// Leader protocol: the bot's bio (profile short description) is the shared
// leader marker. Each device writes "pi:leader:<deviceId>" on connect; the
// active leader re-checks it periodically and steps down when overwritten.
const DEVICE_ID_FILE = join(TMP_DIR, "device-id"); // stable per-device id (not synced)
const LEADER_PREFIX = "pi:leader:";
const LEADER_CONFIRM_MS = 5000; // wait before trusting our marker (no atomic CAS)
const LEADER_CHECK_INTERVAL_MS = 3000; // how often the leader re-verifies ownership
// Same-device election: one leader (poller) per device; other sessions are
// standby children that take over when the leader disconnects or dies.
const INSTANCE_ID = `${process.pid}-${Math.random().toString(36).slice(2, 8)}`; // per process/session
const LEADER_FILE = join(TMP_DIR, "leader.json"); // local leader record (same-device only)
const LOCAL_CLAIM_CONFIRM_MS = 1500; // local leader-slot claim confirm (no CAS)
const CHILD_POLL_INTERVAL_MS = 2000; // how often children check for takeover
// Per-session threads + routing (only the leader polls; children process
// messages routed to their own thread via an inbox file).
const THREADS_DIR = join(TMP_DIR, "threads"); // one <threadId>.json per session
const INBOX_DIR = join(TMP_DIR, "inbox"); // routed updates per session
// Thinking streaming limits (same as upstream llblab/pi-telegram):
// rolling window of the latest chars + "… [N earlier chars omitted]" header.
const REASONING_BUFFER_MAX_CHARS = 1200;
const REASONING_MESSAGE_MAX_FRAMES = 24;
const REASONING_MIN_INTERVAL_MS = 1200;
const REASONING_MIN_DELTA_CHARS = 160;
const ACTIVITY_MESSAGE_MAX_CHARS = 3900;

// Random thread-name palette (same words as upstream llblab/pi-telegram).
const THREAD_NAME_PALETTE: string[] = [
	"Atlas", "Aster", "Aurora", "Anchor", "Ashen",
	"Beacon", "Briar", "Boreal", "Birch", "Bison",
	"Cedar", "Comet", "Cipher", "Coral", "Cinder",
	"Delta", "Dawn", "Drift", "Dune", "Dagger",
	"Ember", "Echo", "Eagle", "Eden", "Elder",
	"Falcon", "Fjord", "Flint", "Forest", "Fable",
	"Grove", "Glade", "Glyph", "Garnet", "Gale",
	"Harbor", "Hawk", "Hazel", "Helix", "Haven",
	"Iris", "Ivory", "Iron", "Isle", "Idea",
	"Jade", "Juno", "Jolt", "Jewel", "Jasper",
	"Kite", "Karma", "Kernel", "Kodiak", "Kelp",
	"Lumen", "Laurel", "Lynx", "Lotus", "Lagoon",
	"Maple", "Meteor", "Meadow", "Marble", "Moss",
	"Nimbus", "Nova", "Nectar", "North", "Noble",
	"Orion", "Onyx", "Opal", "Orbit", "Olive",
	"Pine", "Pulse", "Praxis", "Pebble", "Prism",
	"Quartz", "Quill", "Quasar", "Quest", "Quiver",
	"River", "Raven", "Rune", "Reef", "Ridge",
	"Spruce", "Solar", "Signal", "Stone", "Sable",
	"Timber", "Talon", "Terra", "Torch", "Tide",
	"Umber", "Unity", "Ursa", "Uplink", "Ulmus",
	"Violet", "Vector", "Vista", "Vale", "Vortex",
	"Willow", "Warden", "Wave", "Winter", "Wisp",
	"Xenon", "Xylem", "Xavier", "Xylo", "Xerus",
	"Yarrow", "Yonder", "Yukon", "Yale", "Yogi",
	"Zenith", "Zephyr", "Zircon", "Zebra", "Zion",
];

function generateThreadName(): string {
	return THREAD_NAME_PALETTE[Math.floor(Math.random() * THREAD_NAME_PALETTE.length)] ?? "Pi";
}
const THREADED_MODE_INSTRUCTIONS =
	"Threaded Mode is not enabled.\n\n" +
	"This bot requires Threaded Mode (private chat). To enable it:\n\n" +
	"1. Open @BotFather in Telegram\n" +
	"2. Send /mybots → choose your bot\n" +
	"3. Bot Settings → Threaded Mode → Enable\n\n" +
	"Then send /start again.";

// Stable identity — kept in telegram.json (syncable).
interface TelegramConfig {
	botToken?: string;
	allowedUserId?: number;
	chatId?: number;
}

// Volatile runtime state — in-memory only (this instance's bound thread).
interface TelegramState {
	threadId?: number;
	threadName?: string;
}

interface Target {
	chatId: number;
	threadId?: number;
}

type SendUserMessageContent = Parameters<ExtensionAPI["sendUserMessage"]>[0];

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

async function loadConfig(): Promise<TelegramConfig> {
	try {
		const raw = JSON.parse(await readFile(CONFIG_FILE, "utf8")) as TelegramConfig & {
			profiles?: { default?: { botToken?: string; lastUpdateId?: number } };
		};
		// Migration: old llblab format kept the token under profiles.default.
		if (typeof raw.botToken === "string") {
			// Keep only stable identity.
			const stable: TelegramConfig = { botToken: raw.botToken, allowedUserId: raw.allowedUserId, chatId: raw.chatId };
			// One-time cleanup: migrate volatile leftovers (old lastUpdateId /
			// thread fields) out of the config into offset.json.
			const rawAny = raw as TelegramConfig & { lastUpdateId?: number; threadId?: number; threadName?: string };
			if (rawAny.lastUpdateId !== undefined || rawAny.threadId !== undefined || rawAny.threadName !== undefined) {
				if (rawAny.lastUpdateId !== undefined) {
					try {
						const existing = JSON.parse(await readFile(OFFSET_FILE, "utf8")) as { lastUpdateId?: number };

						if (existing.lastUpdateId === undefined) await saveOffset({ lastUpdateId: rawAny.lastUpdateId });

						} catch {

						await saveOffset({ lastUpdateId: rawAny.lastUpdateId });

						}
				}
				await saveConfig(stable);
			}
			return stable;
		}
		const old = raw.profiles?.default;
		if (old?.botToken) {
			const migrated: TelegramConfig = { botToken: old.botToken };
			await saveConfig(migrated);
			return migrated;
		}
		return {};
	} catch {
		return {};
	}
}

async function loadOffset(): Promise<{ lastUpdateId?: number }> {
	try {
		return JSON.parse(await readFile(OFFSET_FILE, "utf8")) as { lastUpdateId?: number };
	} catch {
		return {};
	}
}

async function saveConfig(cfg: TelegramConfig): Promise<void> {
	await mkdir(dirname(CONFIG_FILE), { recursive: true });
	const tmp = `${CONFIG_FILE}.tmp`;
	await writeFile(tmp, JSON.stringify(cfg, null, 2) + "\n", { mode: 0o600 });
	await rename(tmp, CONFIG_FILE);
}

async function saveOffset(offset: { lastUpdateId?: number }): Promise<void> {
	await mkdir(dirname(OFFSET_FILE), { recursive: true });
	const tmp = `${OFFSET_FILE}.tmp`;
	await writeFile(tmp, JSON.stringify(offset, null, 2) + "\n", { mode: 0o600 });
	await rename(tmp, OFFSET_FILE);
}

// ---------------------------------------------------------------------------
// Extension entry
// ---------------------------------------------------------------------------

export default function (pi: ExtensionAPI) {
	let cfg: TelegramConfig = {};
	let state: TelegramState = {}; // in-memory: this instance's thread
	let offset: { lastUpdateId?: number } = {}; // shared polling offset
	let client: TgClient | undefined;
	let sessionCtx: ExtensionContext | undefined;
	let pollRunning = false;
	let pollCtl: AbortController | undefined;
	let typingTimer: NodeJS.Timeout | undefined;
	let botUsername = "";
	let aborted = false;
	let lastUserMsgId: number | undefined;
	let reminderSent = false;
	let deviceId = "";
	let leaderTimer: NodeJS.Timeout | undefined;
	let role: "leader" | "child" | undefined;
	let childTimer: NodeJS.Timeout | undefined;

	const getClient = (): TgClient => (client ??= new TgClient(cfg.botToken ?? ""));

	function target(): Target | undefined {
		if (cfg.allowedUserId === undefined || cfg.chatId === undefined) return undefined;
		return { chatId: cfg.chatId, threadId: state.threadId };
	}

	/** Persist stable identity (telegram.json) — only on login/logout/pairing. */
	async function persistCfg(partial: Partial<TelegramConfig>): Promise<void> {
		cfg = { ...cfg, ...partial };
		await saveConfig(cfg);
	}

	/** Persist the shared polling offset (only the active poller writes it). */
	async function persistOffset(lastUpdateId: number): Promise<void> {
		offset.lastUpdateId = lastUpdateId;
		await saveOffset(offset).catch(() => {});
	}

	// -----------------------------------------------------------------------
	// Outbound helpers
	// -----------------------------------------------------------------------

	/** Send plain text silently (intermediate/status messages — no notification). */
	async function sendPlain(text: string, options: { threadId?: number } = {}): Promise<void> {
		const t = target();
		if (!t) return;
		const threadId = options.threadId ?? t.threadId;
		if (threadId === undefined) return; // disconnected — no session thread
		for (const chunk of splitMessage(text)) {
			try {
				await getClient().sendMessage(t.chatId, chunk, {
					threadId,
					replyTo: lastUserMsgId,
					disableNotification: true,
				});
			} catch {
				// Ignore: thread may be deleted (after quit).
			}
			lastUserMsgId = undefined;
		}
	}

	/** Send HTML-rendered text silently (status replies). */
	async function sendHtml(text: string, options: { threadId?: number } = {}): Promise<void> {
		const t = target();
		if (!t) return;
		const threadId = options.threadId ?? t.threadId;
		if (threadId === undefined) return; // disconnected — no session thread
		for (const chunk of splitMessage(text)) {
			try {
				await getClient().sendMessage(t.chatId, chunk, {
					threadId,
					parseMode: "HTML",
					replyTo: lastUserMsgId,
					disableNotification: true,
				});
			} catch {
				// Fall back to plain text if HTML entities fail.
				try {
					await getClient().sendMessage(t.chatId, chunk, { threadId: t.threadId, replyTo: lastUserMsgId, disableNotification: true });
				} catch {
					// Ignore.
				}
			}
			lastUserMsgId = undefined;
		}
	}

	/** Send a Rich Message (Rich Markdown) to the owner; falls back to HTML, then plain.
	 *  Loud by default (final answer); pass silent: true for intermediate content. */
	async function sendRich(text: string, options: { replyMarkup?: unknown; silent?: boolean } = {}): Promise<void> {
		const t = target();
		if (!t || t.threadId === undefined) return; // disconnected — no session thread
		// Rich messages support up to 32768 chars; chunk conservatively.
		for (const chunk of splitMessage(text, 30000)) {
			const replyTo = lastUserMsgId;
			try {
				await getClient().sendRichMessage(t.chatId, chunk, {
					threadId: t.threadId,
					replyTo,
					replyMarkup: options.replyMarkup,
					disableNotification: options.silent,
				});
			} catch {
				// Rich Markdown rejected → try HTML, then plain text.
				try {
					const sent = await getClient().sendMessage(t.chatId, chunk, {
						threadId: t.threadId,
						parseMode: "HTML",
						replyTo,
					});
				} catch {
					try {
						const sent = await getClient().sendMessage(t.chatId, chunk, { threadId: t.threadId, replyTo });
					} catch {
						// Thread may be deleted (after quit).
					}
				}
			}
			lastUserMsgId = undefined;
		}
	}

	function startTyping(): void {
		if (typingTimer || !target()) return;
		const t = target()!;
		if (t.threadId === undefined) return;
		const ping = () => getClient().sendChatAction(t.chatId, t.threadId, "typing").catch(() => {});
		ping();
		typingTimer = setInterval(ping, 5000);
	}

	function stopTyping(): void {
		if (typingTimer) {
			clearInterval(typingTimer);
			typingTimer = undefined;
		}
	}

	// -----------------------------------------------------------------------
	// Status
	// -----------------------------------------------------------------------

	function updateStatus(): void {
		if (!sessionCtx) return;
		// Show the session thread name (lowercase label) for both leader and
		// child — every session has its own thread. While loading, unpaired,
		// or on error there is nothing meaningful to show, so the status
		// entry stays hidden instead of a placeholder label.
		if (!state.threadName) {
			sessionCtx.ui.setStatus("telegram", undefined);
			return;
		}
		sessionCtx.ui.setStatus("telegram", state.threadName.toLowerCase());
	}

	function statusLines(): string[] {
		const m = sessionCtx?.model;
		const lines = [
			`<b>${escapeHtml(botUsername || "telegram")}</b> · bridge active`,
			`owner: <code>${cfg.allowedUserId ?? "—"}</code>`,
			`role: <code>${role ?? "—"}</code>`,
			`thread: <code>${state.threadName ?? state.threadId ?? "—"}</code>`,
			`model: <code>${escapeHtml(m ? `${m.provider}/${m.id}` : "—")}</code>`,
			`thinking: <code>${escapeHtml(String(sessionCtx?.thinkingLevel ?? "—"))}</code>`,
			`status: ${sessionCtx?.isIdle() ? "idle" : "working"}`,
			`session: <code>${escapeHtml(basename(sessionCtx?.sessionManager.getSessionFile() ?? "—"))}</code>`,
			"",
			"Commands: /start · /stop",
		];
		return lines;
	}

	function basename(path: string): string {
		return path.split(/[\\/]/).pop() ?? path;
	}

	// -----------------------------------------------------------------------
	// Session thread (one thread per pi session)
	// -----------------------------------------------------------------------

	/** Create a fresh session thread via createForumTopic; persists it as the outbound target. */
	async function createSessionThread(): Promise<number | undefined> {
		const t = target();
		if (!t?.chatId) return undefined;
		// Random name from the palette (like upstream), one per pi session.
		const name = generateThreadName();
		try {
			const topic = await getClient().createForumTopic(t.chatId, name);
			state.threadId = topic.message_thread_id;
			state.threadName = name;
			await registerThread(state.threadId, name);
			return topic.message_thread_id;
		} catch {
			// Threaded Mode off or API failure → fall back to the existing
			// thread (or the All tab when none exists).
			return undefined;
		}
	}

	// -----------------------------------------------------------------------
	// Telegram command handlers
	// -----------------------------------------------------------------------

	async function handleStart(m: TgMessage, threadId: number | undefined): Promise<void> {
		if (cfg.allowedUserId === undefined || cfg.chatId === undefined) {
			if (!threadId) {
				// Threaded Mode not active → refuse to pair, show instructions.
				await sendPlain(THREADED_MODE_INSTRUCTIONS, { threadId });
				return;
			}
			await persistCfg({ allowedUserId: m.from?.id, chatId: m.chat.id });
			// Pairing done: create this pi session's thread and welcome the owner there.
			const tid = await createSessionThread();
			updateStatus();
			await sendPlain(
				tid
					? `Owner paired (${m.from?.id}). Session thread created — all replies land in the \"${state.threadName}\" thread. Send a prompt to start.`
					: `Owner paired (${m.from?.id}). Send a prompt to start.`,
				{ threadId: tid ?? threadId },
			);
			return;
		}
		await sendHtml(statusLines().join("\n"));
	}


	function handleStop(ctx: ExtensionContext): void {
		if (ctx.isIdle()) {
			sendPlain("No run in progress.").catch(() => {});
			return;
		}
		aborted = true;
		ctx.abort();
		sendPlain("Stopped.").catch(() => {});
	}

	// -----------------------------------------------------------------------
	// Inbound: prompts (text / photo / document)
	// -----------------------------------------------------------------------

	function dispatchToPi(content: SendUserMessageContent): void {
		const ctx = sessionCtx;
		if (!ctx) return;
		if (ctx.isIdle()) {
			pi.sendUserMessage(content);
		} else {
			pi.sendUserMessage(content, { deliverAs: "followUp" });
		}
	}

	async function handlePrompt(m: TgMessage): Promise<void> {
		if (m.photo?.length) {
			const fileId = m.photo[m.photo.length - 1].file_id;
			const file = await getClient().getFile(fileId).catch(() => undefined);
			if (file?.file_path) {
				const data = await getClient().downloadFile(file.file_path).catch(() => undefined);
				if (data) {
					dispatchToPi([
						{ type: "text", text: m.caption ?? "Photo" },
						{
							type: "image",
							source: {
								type: "base64",
								mediaType: "image/jpeg",
								data: Buffer.from(data).toString("base64"),
							},
						},
					] as SendUserMessageContent);
					return;
				}
			}
			dispatchToPi(m.caption ?? "Photo (download failed)");
			return;
		}

		if (m.document) {
			const file = await getClient().getFile(m.document.file_id).catch(() => undefined);
			if (file?.file_path) {
				const data = await getClient().downloadFile(file.file_path).catch(() => undefined);
				if (data) {
					const name = sanitizeFilename(m.document.file_name ?? "file");
					const dest = join(TMP_DIR, `${Date.now()}_${name}`);
					await mkdir(TMP_DIR, { recursive: true });
					await writeFile(dest, data);
					const caption = m.caption ? `${m.caption}\n` : "";
					dispatchToPi(`File: ${name} (${data.length} bytes)\n${caption}Saved at: ${dest}`);
					return;
				}
			}
			dispatchToPi(`File: ${m.document.file_name ?? "file"} (download failed)`);
			return;
		}

		if (m.text) {
			dispatchToPi(m.text);
		}
	}

	// -----------------------------------------------------------------------
	// Update routing
	// -----------------------------------------------------------------------

	async function handleUpdate(u: TgUpdate): Promise<void> {
		const m = u.message;
		if (!m || m.chat.type !== "private") return;

		// Routing: a message in another live session's thread is forwarded to
		// that session's inbox; each session answers in its own thread. Only
		// the leader polls, so it does the routing.
		if (m.message_thread_id && m.message_thread_id !== state.threadId) {
			const owner = await lookupThreadOwner(m.message_thread_id);
			if (owner && owner !== INSTANCE_ID) {
				await routeToInstance(owner, u);
				return;
			}
		}

		// Reply-to only makes sense when the message arrived in the session
		// thread; cross-thread replies would be rejected by the API.
		lastUserMsgId = m.message_thread_id === state.threadId ? m.message_id : undefined;

		const isOwner = cfg.allowedUserId !== undefined && m.from?.id === cfg.allowedUserId;
		if (!isOwner) {
			if (m.text === "/start") await handleStart(m, m.message_thread_id);
			// Strangers are ignored.
			return;
		}

		if (!m.message_thread_id && !reminderSent) {
			reminderSent = true;
			sendPlain("Threaded Mode is off — re-enable it in BotFather (Bot Settings → Threaded Mode).").catch(() => {});
		}

		const text = m.text ?? "";
		if (text === "/start") {
			await handleStart(m, m.message_thread_id);
		} else if (text === "/new" || text === "/reload") {
			// Full /new and /reload are command-context-only in pi 0.84 and
			// cannot be triggered from the polling loop — point to the terminal.
			sendPlain(
				`${text} is not available from Telegram in pi 0.84.\nRun ${text} in the pi terminal.`,
			).catch(() => {});
		} else if (text === "/stop") {
			if (sessionCtx) handleStop(sessionCtx);
		} else {
			await handlePrompt(m);
		}
	}

	// -----------------------------------------------------------------------
	// Polling
	// -----------------------------------------------------------------------

	function stopPolling(): void {
		pollRunning = false;
		pollCtl?.abort();
		pollCtl = undefined;
		if (leaderTimer) {
			clearInterval(leaderTimer);
			leaderTimer = undefined;
		}
		stopTyping();
	}

	function startPolling(): void {
		if (pollRunning || !cfg.botToken) return;
		pollRunning = true;
		pollCtl = new AbortController();
		const signal = pollCtl.signal;
		const tg = getClient();
		// Re-verify ownership periodically; step down if another device
		// overwrote the leader marker in the bot description.
		leaderTimer = setInterval(() => void checkLeadership(), LEADER_CHECK_INTERVAL_MS);

		// Expose the bot command list in Telegram's UI.
		tg.setMyCommands([
			{ command: "start", description: "Status / pairing" },
			{ command: "stop", description: "Stop current run" },
		]).catch(() => {});
		tg.getMe().then((me) => (botUsername = `@${me.username ?? ""}`)).catch(() => {});

		const loop = async () => {
			while (pollRunning) {
				try {
					const updates = await tg.getUpdates((offset.lastUpdateId ?? 0) + 1, 30, signal);
					for (const u of updates) {
						await handleUpdate(u);
					}
					if (updates.length > 0) {
						const maxId = Math.max(...updates.map((u) => u.update_id));
						await persistOffset(maxId);
					}
				} catch (err) {
					if (signal.aborted || !pollRunning) break;
					const msg = err instanceof Error ? err.message : String(err);
					if (/Unauthorized|token/i.test(msg)) {
						// Invalid token → stop silently; /telegram to re-login.
						pollRunning = false;
						break;
					}
					if (/Conflict|terminated by other getUpdates/i.test(msg)) {
						// Defensive: if the API ever terminates our poll (409),
						// treat it like a takeover — strict single-device.
						// fully disconnect (delete session thread, stay off until
						// /telegram is run again).
						stopPolling();
						void handleKicked();
						return;
					}
					await sleep(1000, signal);
				}
			}
		};
		void loop();
	}

	// -----------------------------------------------------------------------
	// Bridge: pi events → Telegram (verbose: thinking + tools + answer)
	// -----------------------------------------------------------------------

	interface AssistantContent {
		thinking: string;
		text: string;
	}

	function extractAssistantContent(content: unknown): AssistantContent {
		if (typeof content === "string") return { thinking: "", text: content };
		if (!Array.isArray(content)) return { thinking: "", text: "" };
		let thinking = "";
		let text = "";
		for (const part of content) {
			if (!part || typeof part !== "object") continue;
			const p = part as { type?: string; thinking?: unknown; reasoning?: unknown; text?: unknown };
			if (p.type === "thinking" && typeof p.thinking === "string") {
				thinking += (thinking ? "\n\n" : "") + p.thinking;
			} else if (p.type === "reasoning" && typeof p.reasoning === "string") {
				thinking += (thinking ? "\n\n" : "") + p.reasoning;
			} else if (p.type === "text" && typeof p.text === "string") {
				text += (text ? "\n" : "") + p.text;
			}
		}
		return { thinking, text };
	}

	function lastAssistantContent(): AssistantContent | undefined {
		const entries = sessionCtx?.sessionManager.getEntries() ?? [];
		for (let i = entries.length - 1; i >= 0; i--) {
			const e = entries[i];
			if (e.type === "message" && e.message?.role === "assistant") {
				const content = extractAssistantContent(e.message.content);
				if (content.thinking.trim() || content.text.trim()) return content;
			}
		}
		return undefined;
	}

	// -----------------------------------------------------------------------
	// Tool activity feed (upstream-style: one rich details tree per tool in a
	// single message, edited in place as tools run).
	// -----------------------------------------------------------------------

	interface ToolActivity {
		name: string;
		status: "running" | "success" | "error";
		args: string; // input shown in the first bash code block
		result?: string; // result/error text (second bash code block)
	}

	let tools = new Map<string, ToolActivity>();
	let toolOrder: string[] = [];
	let toolMsgId: number | undefined;
	let toolMsgFormat: "rich" | "html" | undefined;
	let toolPublishTimer: NodeJS.Timeout | undefined;
	let toolPublishing = false; // guards the send race

	/** Input text for the first bash code block: the raw command for bash,
	 *  key: value lines for everything else. */
	function toolArgsJson(args: unknown): string {
		if (args && typeof args === "object") {
			const record = args as Record<string, unknown>;
			if (typeof record.command === "string" && record.command.trim()) {
				return record.command.trim().slice(0, 2000);
			}
			const lines = Object.entries(record)
				.filter(([, v]) => v !== undefined)
				.map(([k, v]) => `${k}: ${typeof v === "string" ? v : JSON.stringify(v)}`);
			return lines.join("\n").slice(0, 2000);
		}
		return String(args ?? "").slice(0, 2000);
	}

	function toolResultText(result: unknown): string {
		const r = result as { content?: Array<{ type?: string; text?: unknown }>; isError?: boolean } | undefined;
		const text = (r?.content ?? [])
			.filter((c): c is { type: string; text: string } => c?.type === "text" && typeof c.text === "string")
			.map((c) => c.text)
			.join("\n");
		return text.slice(0, 3000);
	}

	/** Native rich blocks: closed details per tool. Title = "name: status",
	 *  content = two ```bash code blocks (input, then result). */
	function toolActivityBlocks(): Array<Record<string, unknown>> {
		return toolOrder.map((name) => {
			const tool = tools.get(name)!;
			const blocks: Array<Record<string, unknown>> = [
				{ type: "pre", text: tool.args, language: "bash" },
			];
			if (tool.result !== undefined) {
				blocks.push({ type: "pre", text: tool.result, language: "bash" });
			}
			return { type: "details", summary: `${tool.name}: ${tool.status}`, blocks };
		});
	}

	/** HTML fallback: "name: status" title + the two bash code blocks. */
	function toolActivityHtml(): string {
		return toolOrder
			.map((name) => {
				const tool = tools.get(name)!;
				const parts = [`<b>${escapeHtml(tool.name)}: ${escapeHtml(tool.status)}</b>`];
				parts.push(`<pre>${escapeHtml(tool.args)}</pre>`);
				if (tool.result !== undefined) parts.push(`<pre>${escapeHtml(tool.result)}</pre>`);
				return parts.join("\n");
			})
			.join("\n\n");
	}

	/** Create the tool message, or edit it in place. Falls back to HTML on rich rejection. */
	async function publishToolActivity(): Promise<void> {
		if (toolPublishing) return;
		toolPublishing = true;
		try {
			await doPublishToolActivity();
		} finally {
			toolPublishing = false;
		}
	}

	async function doPublishToolActivity(): Promise<void> {
		toolPublishTimer = undefined;
		const t = target();
		if (!t || t.threadId === undefined || toolOrder.length === 0) return;
		if (toolActivityHtml().length > 30000) return; // keep the message bounded

		if (toolMsgId === undefined) {
			try {
				const sent = await getClient().sendRichMessageBlocks(t.chatId, toolActivityBlocks(), { threadId: t.threadId, disableNotification: true });
				toolMsgId = sent.message_id;
				toolMsgFormat = "rich";
			} catch {
				try {
					const sent = await getClient().sendMessage(t.chatId, toolActivityHtml(), { threadId: t.threadId, parseMode: "HTML", disableNotification: true });
					toolMsgId = sent.message_id;
					toolMsgFormat = "html";
				} catch {
					// Ignore.
				}
			}
			return;
		}
		try {
			if (toolMsgFormat === "rich") {
				await getClient().editMessageTextBlocks(t.chatId, toolMsgId, toolActivityBlocks());
			} else {
				await getClient().editMessageTextHtml(t.chatId, toolMsgId, toolActivityHtml());
			}
		} catch {
			// Edit failed (e.g. message too old) → start a fresh message.
			toolMsgId = undefined;
			void doPublishToolActivity();
		}
	}

	function scheduleToolPublish(): void {
		if (toolPublishTimer) clearTimeout(toolPublishTimer);
		toolPublishTimer = setTimeout(() => void publishToolActivity(), 150);
	}

	function resetToolActivity(): void {
		tools.clear();
		toolOrder = [];
		toolMsgId = undefined;
		toolMsgFormat = undefined;
		if (toolPublishTimer) {
			clearTimeout(toolPublishTimer);
			toolPublishTimer = undefined;
		}
	}

	// Realtime streaming state: thinking is live-updated in one message via
	// editMessageText; the answer streams as an animated Rich Draft.
	let draftId = 0;
	let lastDraftSent = 0;
	let lastDraftLen = 0;
	let reasoningBuffer = "";
	let reasoningChars = 0;
	let reasoningFrames = 0;
	let lastReasoningChars = 0;
	let lastReasoningPublishMs = 0;
	let reasoningMsgId: number | undefined;
	let reasoningBlocked = false;
	let reasoningPublishing = false; // guards the send race (see message_update)
	let prevThinkingLen = 0;

	pi.on("agent_start", () => {
		startTyping();
		updateStatus();
		draftId = (draftId % 2_000_000_000) + 1;
		lastDraftSent = 0;
		lastDraftLen = 0;
		reasoningBuffer = "";
		reasoningChars = 0;
		reasoningFrames = 0;
		lastReasoningChars = 0;
		lastReasoningPublishMs = 0;
		reasoningMsgId = undefined;
		reasoningBlocked = false;
		reasoningPublishing = false;
		prevThinkingLen = 0;
		resetToolActivity();
	});

	pi.on("agent_end", () => {
		stopTyping();
		// Final thinking frame: a short thinking phase may never satisfy the
		// throttle (1.2s / 160 chars), leaving the collapse stuck at the first
		// token. Force one last publish with the complete rolling window.
		if (reasoningFrames > 0 && reasoningChars > 0 && !reasoningBlocked) {
			const t = target();
			if (t?.threadId) void publishThinking(t);
		}
	});

	pi.on("message_update", (event) => {
		const t = target();
		if (!t?.threadId) return;
		// The streaming partial carries both thinking and answer text.
		const partialContent =
			(event as { assistantMessageEvent?: { partial?: { content?: unknown } } }).assistantMessageEvent?.partial?.content ??
			(event.message as { content?: unknown } | undefined)?.content;
		const { thinking, text } = extractAssistantContent(partialContent);
		const now = Date.now();

		// Thinking: upstream-style streaming — rolling window of the latest
		// chars, one expandable collapse message edited in place.
		if (thinking.trim() && thinking.length > prevThinkingLen) {
			reasoningChars += thinking.length - prevThinkingLen;
			reasoningBuffer = `${reasoningBuffer}${thinking.slice(prevThinkingLen)}`.slice(-REASONING_BUFFER_MAX_CHARS);
			prevThinkingLen = thinking.length;
			if (
				reasoningFrames < REASONING_MESSAGE_MAX_FRAMES &&
				(reasoningFrames === 0 ||
					(now - lastReasoningPublishMs >= REASONING_MIN_INTERVAL_MS &&
						reasoningChars - lastReasoningChars >= REASONING_MIN_DELTA_CHARS)) &&
				!aborted &&
				!reasoningBlocked &&
				!reasoningPublishing
			) {
				void publishThinking(t);
			}
		}

		// Answer: animated Rich Draft preview (realtime-ish).
		if (!text.trim()) return;
		if (now - lastDraftSent < 1200 || text.length - lastDraftLen < 20) return;
		lastDraftSent = now;
		lastDraftLen = text.length;
		getClient()
			.sendRichMessageDraft(t.chatId, draftId, text.slice(0, 30000), { threadId: t.threadId })
			.catch(() => {});
	});

	/** Headerless expandable blockquote, like upstream's renderTelegramThinkingActivityHtml.
	 *  Sent via plain HTML (parse_mode HTML), not rich markdown — raw thinking
	 *  often contains characters (||, backticks, <, …) that would break rich
	 *  markdown parsing, so everything is HTML-escaped. */
	function buildThinkingHtml(thinking: string): string {
		// Neutralize auto-link detection like upstream (no clickable URLs).
		const neutralized = thinking.replace(/(https?:\/\/)/gi, "$1\u200b");
		return `<blockquote expandable>${escapeHtml(neutralized)}</blockquote>`;
	}

	/** Rolling window text: "… [N earlier chars omitted]" header above the latest chars. */
	function buildThinkingWindowText(thinking: string): string {
		const retained = thinking.slice(-REASONING_BUFFER_MAX_CHARS);
		const omitted = thinking.length - retained.length;
		return omitted > 0 ? `… [${omitted} earlier chars omitted]\n${retained}` : retained;
	}

	/** Send the thinking collapse once, then edit it in place (upstream-style). */
	async function publishThinking(t: Target): Promise<void> {
		if (reasoningPublishing) return;
		reasoningPublishing = true;
		try {
			await doPublishThinking(t);
		} finally {
			reasoningPublishing = false;
		}
	}

	async function doPublishThinking(t: Target): Promise<void> {
		let retained = reasoningBuffer;
		let body = "";
		do {
			const omitted = reasoningChars - retained.length;
			const text = omitted > 0 ? `… [${omitted} earlier chars omitted]\n${retained}` : retained;
			body = buildThinkingHtml(text);
			if (body.length <= ACTIVITY_MESSAGE_MAX_CHARS) break;
			retained = retained.slice(-Math.max(1, Math.floor(retained.length * 0.75)));
		} while (retained.length > 1);

		if (reasoningMsgId === undefined) {
			try {
				const sent = await getClient().sendMessage(t.chatId, body, { threadId: t.threadId, parseMode: "HTML", disableNotification: true });
				reasoningMsgId = sent.message_id;
			} catch {
				reasoningBlocked = true; // HTML rejected → stop retrying this run.
				return;
			}
		} else {
			try {
				await getClient().editMessageTextHtml(t.chatId, reasoningMsgId, body);
			} catch {
				// Edit failed (e.g. message too old) → restart the message.
				reasoningMsgId = undefined;
			}
		}
		reasoningFrames += 1;
		lastReasoningChars = reasoningChars;
		lastReasoningPublishMs = Date.now();
	}

	// Realtime tool activity: one details tree per tool, single message, edited
	// in place as tools start and complete (summary = trimmed input label).
	pi.on("tool_execution_start", (event) => {
		if (!target()) return;
		if (!tools.has(event.toolName)) toolOrder.push(event.toolName);
		tools.set(event.toolName, {
			name: event.toolName,
			status: "running",
			args: toolArgsJson(event.args),
		});
		scheduleToolPublish();
	});

	pi.on("tool_execution_end", (event) => {
		if (!target()) return;
		const tool = tools.get(event.toolName);
		if (!tool) return;
		tool.result = toolResultText(event.result);
		tool.status = event.isError ? "error" : "success";
		scheduleToolPublish();
	});

	pi.on("agent_settled", () => {
		stopTyping();
		updateStatus();
		if (aborted) {
			aborted = false;
			return; // /stop already acknowledged; don't push the partial reply.
		}
		const content = lastAssistantContent();
		if (!content) return;

		const thinking = content.thinking.trim();
		const text = content.text.trim();

		// Thinking was streamed live into a message — only send it at the end
		// when no streaming update was observed (e.g. no message_update events).
		if (thinking && reasoningFrames === 0) {
			// Not streamed live → send the rolling-window view once (silent, HTML).
			const t = target();
			if (t?.threadId) {
				getClient()
					.sendMessage(t.chatId, buildThinkingHtml(buildThinkingWindowText(thinking)), { threadId: t.threadId, parseMode: "HTML", disableNotification: true })
					.catch(() => {});
			}
		}
		if (text) {
			sendRich(text).catch(() => {});
		}
	});

	// -----------------------------------------------------------------------
	// Lifecycle: auto connect / disconnect
	// -----------------------------------------------------------------------

	pi.on("session_start", async (_event, ctx) => {
		sessionCtx = ctx;
		aborted = false;
		lastUserMsgId = undefined;
		reminderSent = false;
		if (ctx.mode === "print") return; // Short-lived runs stay passive.
		cfg = await loadConfig();
		state = {};
		offset = await loadOffset();
		client = undefined;
		role = undefined;
		stopChild();
		inboxProcessed = 0;
		updateStatus(); // no thread yet → status hidden
		// No auto-connect: run /telegram to connect.
	});

	pi.on("session_shutdown", async (event) => {
		// Real quit: clean up the session thread. Session replacements
		// (/new, /reload, /resume, /fork) only stop polling; reconnect via /telegram.
		if (event.reason === "quit") {
			await disconnectBridge();
		} else {
			stopPolling();
			stopChild();
		}
		sessionCtx?.ui.setStatus("telegram", undefined);
	});

	// -----------------------------------------------------------------------
	// Tools
	// -----------------------------------------------------------------------

	// -----------------------------------------------------------------------
	// Leader protocol (no 409 conflict exists — concurrent polls are allowed):
	// the bot's bio (short description) is the shared leader marker. The
	// newest writer wins; the previous leader notices within
	// LEADER_CHECK_INTERVAL_MS and steps down (strict single-device). No
	// cross-device file sync needed.
	// -----------------------------------------------------------------------

	async function loadDeviceId(): Promise<string> {
		try {
			const existing = (await readFile(DEVICE_ID_FILE, "utf8")).trim();
			if (existing) return existing;
		} catch {
			// First run on this device.
		}
		const id = randomBytes(16).toString("hex");
		await mkdir(dirname(DEVICE_ID_FILE), { recursive: true });
		await writeFile(DEVICE_ID_FILE, id + "\n", { mode: 0o600 });
		return id;
	}

	function leaderValue(): string {
		return `${LEADER_PREFIX}${deviceId}`;
	}

	/** Full marker value: device id, plus the session thread id once it exists
	 *  (the next leader reads it and deletes the stale thread). */
	function leaderMarker(threadId?: number): string {
		return threadId === undefined ? leaderValue() : `${leaderValue()}:${threadId}`;
	}

	/** Does this marker belong to this device (thread id ignored)? */
	function isOurMarker(marker: string): boolean {
		return marker.startsWith(leaderValue());
	}

	/** Extract the thread id recorded in a leader marker, if any. */
	function markerThreadId(marker: string): number | undefined {
		const rest = marker.startsWith(LEADER_PREFIX) ? marker.slice(LEADER_PREFIX.length) : "";
		const [, thread] = rest.split(":");
		if (thread === undefined || !/^\d+$/.test(thread)) return undefined;
		return Number(thread);
	}

	/** Write our marker, wait, and confirm nobody overwrote it (the Bot API
	 *  has no compare-and-swap — this is the closest thing to an atomic
	 *  acquire: the last writer wins). Fast path when the marker is already
	 *  ours (same-device takeover). */
	async function acquireLeadership(): Promise<boolean> {
		const current = await getClient().getMyShortDescription().catch(() => undefined);
		if (current !== undefined && isOurMarker(current)) return true;
		try {
			await getClient().setMyShortDescription(leaderMarker());
		} catch {
			return false;
		}
		await sleep(LEADER_CONFIRM_MS);
		const after = await getClient().getMyShortDescription().catch(() => leaderMarker());
		return after === leaderMarker();
	}

	/** Clear our marker — clean disconnect/quit only, and only while we still
	 *  own it. Never clear a foreign or empty marker: the device holding it is
	 *  the active leader, and a device that never connected (or was already
	 *  kicked) must not be able to wipe it on exit. */
	async function releaseLeadership(): Promise<void> {
		const current = await getClient().getMyShortDescription().catch(() => undefined);
		if (current === undefined || !isOurMarker(current)) return;
		await getClient().setMyShortDescription("").catch(() => {});
	}

	/** Periodic ownership check: another device overwrote the marker → step
	 *  down fully (delete session thread, stay off until /telegram again). */
	async function checkLeadership(): Promise<void> {
		const current = await getClient().getMyShortDescription().catch(() => undefined);
		if (current === undefined || isOurMarker(current)) return;
		stopPolling();
		void handleKicked();
	}

	// -----------------------------------------------------------------------
	// Same-device election: one leader per device, standby children take over
	// when the leader disconnects or dies (pid liveness on the local file).
	// Cross-device exclusivity stays on the bio marker.
	// -----------------------------------------------------------------------

	interface LeaderRecord {
		instanceId: string;
		pid: number;
		updatedAt: number;
	}

	function pidAlive(pid: number): boolean {
		try {
			process.kill(pid, 0);
			return true;
		} catch {
			return false;
		}
	}

	async function readLeader(): Promise<LeaderRecord | undefined> {
		try {
			return JSON.parse(await readFile(LEADER_FILE, "utf8")) as LeaderRecord;
		} catch {
			return undefined;
		}
	}

	async function writeLeader(record: LeaderRecord): Promise<void> {
		await mkdir(dirname(LEADER_FILE), { recursive: true });
		const tmp = `${LEADER_FILE}.tmp`;
		await writeFile(tmp, JSON.stringify(record) + "\n", { mode: 0o600 });
		await rename(tmp, LEADER_FILE);
	}

	async function removeLeader(): Promise<void> {
		await rm(LEADER_FILE, { force: true }).catch(() => {});
	}

	// -----------------------------------------------------------------------
	// Thread routing: every session has its own thread. The leader forwards
	// updates for another live session's thread to that session's inbox; the
	// child drains its inbox and answers in its own thread.
	// -----------------------------------------------------------------------

	async function registerThread(threadId: number, threadName: string): Promise<void> {
		await mkdir(THREADS_DIR, { recursive: true });
		const file = join(THREADS_DIR, `${threadId}.json`);
		const tmp = `${file}.tmp`;
		await writeFile(tmp, JSON.stringify({ instanceId: INSTANCE_ID, pid: process.pid, threadName }), { mode: 0o600 });
		await rename(tmp, file);
	}

	async function unregisterThread(threadId: number): Promise<void> {
		await rm(join(THREADS_DIR, `${threadId}.json`), { force: true }).catch(() => {});
	}

	/** Live instance owning a thread, or undefined when unbound/stale. */
	async function lookupThreadOwner(threadId: number): Promise<string | undefined> {
		try {
			const reg = JSON.parse(await readFile(join(THREADS_DIR, `${threadId}.json`), "utf8")) as { instanceId: string; pid: number };
			if (pidAlive(reg.pid)) return reg.instanceId;
			await unregisterThread(threadId); // stale registration → clean up
			return undefined;
		} catch {
			return undefined;
		}
	}

	/** Forward a raw update to another session's inbox. */
	async function routeToInstance(instanceId: string, update: TgUpdate): Promise<void> {
		await mkdir(INBOX_DIR, { recursive: true });
		await appendFile(join(INBOX_DIR, `${instanceId}.jsonl`), JSON.stringify(update) + "\n");
	}

	/** Drain our routed inbox (messages sent in OUR thread while we're a
	 *  standby child — only the leader polls). */
	let inboxProcessed = 0;
	async function drainInbox(): Promise<void> {
		const inboxFile = join(INBOX_DIR, `${INSTANCE_ID}.jsonl`);
		const content = await readFile(inboxFile, "utf8").catch(() => "");
		const lines = content.split("\n").filter((l) => l.trim().length > 0);
		while (inboxProcessed < lines.length) {
			try {
				await handleUpdate(JSON.parse(lines[inboxProcessed]) as TgUpdate);
			} catch {
				// Malformed line — skip.
			}
			inboxProcessed++;
		}
	}

	/** Is another LIVE session on this device the local leader? */
	async function localLeaderAlive(): Promise<boolean> {
		const rec = await readLeader();
		if (!rec || rec.instanceId === INSTANCE_ID) return false;
		return pidAlive(rec.pid);
	}

	/** Claim the local leader slot (write + confirm — no CAS, last writer
	 *  wins). True when the claim survived the confirm window. */
	async function claimLocalLeader(): Promise<boolean> {
		await writeLeader({ instanceId: INSTANCE_ID, pid: process.pid, updatedAt: Date.now() });
		await sleep(LOCAL_CLAIM_CONFIRM_MS);
		const rec = await readLeader();
		return rec?.instanceId === INSTANCE_ID;
	}

	/** Become the active leader: keep or create this session's thread, record
	 *  it in the bio marker, delete the previous leader's stale thread (crash
	 *  orphan / device switch), then start polling. */
	async function promoteToLeader(oldThreadId?: number): Promise<void> {
		role = "leader";
		stopChild();
		offset = await loadOffset();
		// Keep the thread we already have (child promotion); only create one
		// when connecting fresh.
		let ownThreadId = state.threadId;
		if (ownThreadId === undefined && cfg.allowedUserId !== undefined && cfg.chatId !== undefined) {
			ownThreadId = await createSessionThread();
		}
		if (ownThreadId !== undefined) {
			await getClient().setMyShortDescription(leaderMarker(ownThreadId)).catch(() => {});
		}
		updateStatus();
		startPolling();
		// Clean the previous leader's stale thread, if any.
		if (oldThreadId !== undefined && oldThreadId !== ownThreadId) {
			const t = target();
			if (t?.chatId) {
				await getClient().deleteForumTopic(t.chatId, oldThreadId).catch(() => {});
			}
		}
		if (state.threadId !== undefined) {
			sendPlain("This session took over as the active device.").catch(() => {});
		}
	}

	function startChild(): void {
		if (childTimer) return;
		childTimer = setInterval(() => void childTick().catch(() => {}), CHILD_POLL_INTERVAL_MS);
	}

	function stopChild(): void {
		if (childTimer) {
			clearInterval(childTimer);
			childTimer = undefined;
		}
	}

	/** Child tick: drain our routed inbox, then check for takeover when the
	 *  local leader dies or disconnects. Never fights another device's live
	 *  leader (bio gate). */
	async function childTick(): Promise<void> {
		if (role !== "child") return;
		await drainInbox();
		if (await localLeaderAlive()) return; // leader still alive
		if (!(await claimLocalLeader())) return; // another session claimed first
		const marker = await getClient().getMyShortDescription().catch(() => undefined);
		if (marker === undefined) {
			await removeLeader(); // transient read failure → back off
			return;
		}
		const oldThreadId = markerThreadId(marker);
		if (isOurMarker(marker)) {
			await promoteToLeader(oldThreadId); // marker is already ours (leader crashed)
			return;
		}
		if (marker === "" && (await acquireLeadership())) {
			await promoteToLeader(oldThreadId); // leader released cleanly
			return;
		}
		// Another device is the active leader → this device was kicked (strict
		// single-device: the device that wrote last wins). The child must fully
		// disconnect too — delete its thread and stay off until /telegram is
		// run again — not linger as a standby that keeps answering.
		await removeLeader();
		void handleKicked();
	}

	// -----------------------------------------------------------------------
	// Connect / disconnect helpers
	// -----------------------------------------------------------------------

	/** Connect: run the same-device election, then acquire the cross-device
	 *  bio marker, then become leader — or become a standby child when
	 *  another session on this device is the leader. */
	async function connectBridge(ctx: ExtensionContext): Promise<"leader" | "child" | "off"> {
		cfg = await loadConfig();
		state = {};
		offset = await loadOffset();
		sessionCtx = ctx;
		client = undefined;
		if (!cfg.botToken) return "off";
		deviceId = await loadDeviceId();
		if (await localLeaderAlive()) {
			role = "child";
			inboxProcessed = 0;
			// Every session gets its own thread; messages there are routed to
			// our inbox and answered here.
			if (cfg.allowedUserId !== undefined && cfg.chatId !== undefined) {
				await createSessionThread();
			}
			updateStatus();
			startChild();
			return "child";
		}
		if (!(await claimLocalLeader())) {
			role = "child";
			inboxProcessed = 0;
			if (cfg.allowedUserId !== undefined && cfg.chatId !== undefined) {
				await createSessionThread();
			}
			updateStatus();
			startChild();
			return "child";
		}
		// Capture the previous leader's marker before overwriting it, so the
		// stale thread it recorded can be deleted after we take over.
		const oldMarker = await getClient().getMyShortDescription().catch(() => "");
		if (!(await acquireLeadership())) {
			await removeLeader(); // another device is the active leader
			role = undefined;
			updateStatus();
			return "off";
		}
		await promoteToLeader(markerThreadId(oldMarker));
		return "leader";
	}

	/** Disconnect: stop polling, release the local leader slot and the bio
	 *  marker, delete this session's thread (best-effort). Children delete
	 *  their own thread too and stop draining. When this instance was never
	 *  connected (or already kicked) there is nothing to release — closing
	 *  pi on a device that isn't the active leader must not touch shared
	 *  state (bio marker / leader.json / threads). */
	async function disconnectBridge(): Promise<void> {
		if (role === undefined) return; // not connected → nothing to disconnect
		if (role === "child") {
			stopChild();
			const t = target();
			if (t?.threadId) {
				await Promise.race([
					getClient().deleteForumTopic(t.chatId, t.threadId),
					sleep(2500),
				]).catch(() => {});
				await unregisterThread(t.threadId).catch(() => {});
			}
			role = undefined;
			state = {};
			updateStatus();
			return;
		}
		stopPolling();
		await removeLeader();
		await releaseLeadership();
		const t = target();
		if (t?.threadId) {
			await Promise.race([
				getClient().deleteForumTopic(t.chatId, t.threadId),
				sleep(2500),
			]).catch(() => {});
			await unregisterThread(t.threadId).catch(() => {});
		}
		role = undefined;
		state = {};
		updateStatus();
	}

	/** Strict single-device kick: another device owns the bio marker. Notify,
	 *  delete this session's thread, and disconnect for good — no follower
	 *  mode, no auto-reconnect. */
	async function handleKicked(): Promise<void> {
		stopChild();
		await removeLeader();
		const t = target();
		if (t?.threadId !== undefined) {
			await sendPlain(
				"Another device connected — this device was disconnected. This session's thread was deleted. Run /telegram to reconnect here.",
			);
			await Promise.race([
				getClient().deleteForumTopic(t.chatId, t.threadId),
				sleep(2500),
			]).catch(() => {});
			await unregisterThread(t.threadId).catch(() => {});
		}
		lastUserMsgId = undefined;
		role = undefined;
		state = {};
		updateStatus();
	}

	// -----------------------------------------------------------------------
	// /telegram command: login / connect / disconnect / logout
	// -----------------------------------------------------------------------

	pi.registerCommand("telegram", {
		description: "Telegram bridge: login, connect/disconnect, logout",
		handler: async (_args, ctx) => {
			sessionCtx = ctx;
			// NOTE: state (this instance's thread) must NOT be reset here — the
			// connected-state actions (Disconnect/Logout) need state.threadId to
			// find and delete the session thread.
			cfg = await loadConfig();

			if (!cfg.botToken) {
				// Login: token input → validate → save → connect immediately.
				const input = await ctx.ui.input(
					"Telegram bot token",
					"123456:ABC… (from @BotFather → /newbot)",
				);
				if (!input?.trim()) {
					ctx.ui.notify("Cancelled — token unchanged.", "warning");
					return;
				}
				const token = input.trim();
				try {
					const me = await new TgClient(token).getMe();
					await persistCfg({ botToken: token, allowedUserId: undefined, chatId: undefined });
					state = {};
					offset = {};
					await saveOffset(offset).catch(() => {});
					client = undefined;
					botUsername = `@${me.username ?? ""}`;
					const outcome = await connectBridge(ctx);
					ctx.ui.notify(
						outcome === "leader"
							? `Connected as @${me.username ?? me.id}. Open the bot DM and send /start (Threaded Mode must be enabled in BotFather).`
							: outcome === "child"
								? "Standby — another session on this device is the leader; this session takes over automatically when it disconnects."
								: "Another device is the active leader — bridge not connected here.",
						outcome === "off" ? "warning" : "info",
					);
				} catch (err) {
					ctx.ui.notify(`Token invalid: ${err instanceof Error ? err.message : String(err)}`, "error");
				}
				return;
			}

			if (role === undefined) {
				// Token saved but not connected → connect directly, no confirmation.
				const outcome = await connectBridge(ctx);
				ctx.ui.notify(
					outcome === "leader"
						? `Connected${botUsername ? ` as ${botUsername}` : ""}${cfg.allowedUserId !== undefined ? "" : " — waiting for /start pairing"}.`
						: outcome === "child"
							? "Standby — another session on this device is the leader; this session takes over automatically when it disconnects."
							: "Another device is the active leader — bridge not connected here.",
					outcome === "off" ? "warning" : "info",
				);
				return;
			}

			// Already connected → Disconnect / Logout / Cancel.
			const choice = await ctx.ui.select("Telegram bridge", ["Disconnect", "Logout", "Cancel"]);
			if (choice === "Disconnect") {
				await disconnectBridge();
				ctx.ui.notify("Disconnected. Run /telegram to connect again.", "info");
			} else if (choice === "Logout") {
				await disconnectBridge();
				client = undefined;
				botUsername = "";
				await persistCfg({ botToken: "", allowedUserId: undefined, chatId: undefined });
				offset = {};
				await saveOffset(offset).catch(() => {});
				ctx.ui.notify("Logged out. Run /telegram to log in again.", "info");
			}
			// Cancel → nothing.
		},
	});
}
