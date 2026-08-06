/**
 * Minimal Telegram Bot API client — zero dependencies, fetch-based.
 * Only the methods this bridge needs. Threaded Mode aware (message_thread_id).
 */

export interface TgUser {
	id: number;
	first_name?: string;
	username?: string;
}

export interface TgChat {
	id: number;
	type: string;
}

export interface TgPhotoSize {
	file_id: string;
	width: number;
	height: number;
	file_size?: number;
}

export interface TgDocument {
	file_id: string;
	file_name?: string;
	mime_type?: string;
}

export interface TgMessage {
	message_id: number;
	from?: TgUser;
	chat: TgChat;
	message_thread_id?: number;
	text?: string;
	caption?: string;
	photo?: TgPhotoSize[];
	document?: TgDocument;
}

export interface TgCallbackQuery {
	id: string;
	from: TgUser;
	message?: TgMessage;
	data?: string;
}

export interface TgUpdate {
	update_id: number;
	message?: TgMessage;
	callback_query?: TgCallbackQuery;
}

export interface TgFileInfo {
	file_id: string;
	file_path?: string;
}

export interface TgMessageResult extends TgMessage {
	message_id: number;
}

export interface TgForumTopic {
	message_thread_id: number;
	name: string;
}

interface TgResponse<T> {
	ok: boolean;
	result?: T;
	description?: string;
}

export interface SendMessageOptions {
	threadId?: number;
	parseMode?: "HTML";
	replyTo?: number;
	replyMarkup?: unknown;
	disableNotification?: boolean;
}

export class TgClient {
	constructor(private readonly token: string) {}

	private async call<T>(method: string, params: Record<string, unknown> = {}, signal?: AbortSignal): Promise<T> {
		const res = await fetch(`https://api.telegram.org/bot${this.token}/${method}`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(params),
			signal,
		});
		const json = (await res.json().catch(() => ({}))) as TgResponse<T>;
		if (!json.ok || json.result === undefined) {
			throw new Error(`Telegram ${method}: ${json.description ?? `HTTP ${res.status}`}`);
		}
		return json.result;
	}

	private async callForm<T>(method: string, form: FormData, signal?: AbortSignal): Promise<T> {
		const res = await fetch(`https://api.telegram.org/bot${this.token}/${method}`, {
			method: "POST",
			body: form,
			signal,
		});
		const json = (await res.json().catch(() => ({}))) as TgResponse<T>;
		if (!json.ok || json.result === undefined) {
			throw new Error(`Telegram ${method}: ${json.description ?? `HTTP ${res.status}`}`);
		}
		return json.result;
	}

	getMe(signal?: AbortSignal): Promise<TgUser> {
		return this.call<TgUser>("getMe", {}, signal);
	}

	getUpdates(offset: number, timeout: number, signal?: AbortSignal): Promise<TgUpdate[]> {
		return this.call<TgUpdate[]>(
			"getUpdates",
			{ offset, timeout, allowed_updates: ["message", "callback_query"] },
			signal,
		);
	}

	sendMessage(chatId: number, text: string, options: SendMessageOptions = {}, signal?: AbortSignal): Promise<TgMessageResult> {
		const params: Record<string, unknown> = { chat_id: chatId, text };
		if (options.threadId) params.message_thread_id = options.threadId;
		if (options.parseMode) params.parse_mode = options.parseMode;
		if (options.replyTo) params.reply_to_message_id = options.replyTo;
		if (options.replyMarkup) params.reply_markup = options.replyMarkup;
		if (options.disableNotification) params.disable_notification = true;
		return this.call<TgMessageResult>("sendMessage", params, signal);
	}

	sendChatAction(chatId: number, threadId: number | undefined, action: string, signal?: AbortSignal): Promise<boolean> {
		const params: Record<string, unknown> = { chat_id: chatId, action };
		if (threadId) params.message_thread_id = threadId;
		return this.call<boolean>("sendChatAction", params, signal);
	}

	deleteMessage(chatId: number, messageId: number, signal?: AbortSignal): Promise<boolean> {
		return this.call<boolean>("deleteMessage", { chat_id: chatId, message_id: messageId }, signal);
	}

	/** Create a forum topic (thread) — supported in private chats with forum topic mode. */
	createForumTopic(chatId: number, name: string, signal?: AbortSignal): Promise<TgForumTopic> {
		return this.call<TgForumTopic>("createForumTopic", { chat_id: chatId, name }, signal);
	}

	/** Delete an entire forum topic (thread) with all its messages. Threaded Mode only. */
	deleteForumTopic(chatId: number, threadId: number, signal?: AbortSignal): Promise<boolean> {
		return this.call<boolean>("deleteForumTopic", { chat_id: chatId, message_thread_id: threadId }, signal);
	}

	/** Send a rich message (Rich Markdown / GFM-style formatting). Up to 32768 chars. */
	sendRichMessage(
		chatId: number,
		markdown: string,
		options: { threadId?: number; replyTo?: number; replyMarkup?: unknown; skipEntityDetection?: boolean; disableNotification?: boolean } = {},
		signal?: AbortSignal,
	): Promise<TgMessageResult> {
		const rich: Record<string, unknown> = { markdown };
		if (options.skipEntityDetection) rich.skip_entity_detection = true;
		const params: Record<string, unknown> = { chat_id: chatId, rich_message: rich };
		if (options.threadId) params.message_thread_id = options.threadId;
		if (options.replyTo) params.reply_parameters = { message_id: options.replyTo };
		if (options.replyMarkup) params.reply_markup = options.replyMarkup;
		if (options.disableNotification) params.disable_notification = true;
		return this.call<TgMessageResult>("sendRichMessage", params, signal);
	}

	/** Edit an existing rich message in place (used to live-update the thinking block). */
	editMessageText(
		chatId: number,
		messageId: number,
		markdown: string,
		options: { skipEntityDetection?: boolean } = {},
		signal?: AbortSignal,
	): Promise<boolean | TgMessageResult> {
		const rich: Record<string, unknown> = { markdown };
		if (options.skipEntityDetection) rich.skip_entity_detection = true;
		return this.call<boolean | TgMessageResult>("editMessageText", {
			chat_id: chatId,
			message_id: messageId,
			rich_message: rich,
		}, signal);
	}

	/** Send a rich message built from native blocks (used for the tool activity feed). */
	sendRichMessageBlocks(
		chatId: number,
		blocks: Array<Record<string, unknown>>,
		options: { threadId?: number; disableNotification?: boolean } = {},
		signal?: AbortSignal,
	): Promise<TgMessageResult> {
		const params: Record<string, unknown> = {
			chat_id: chatId,
			rich_message: { blocks, skip_entity_detection: true },
		};
		if (options.threadId) params.message_thread_id = options.threadId;
		if (options.disableNotification) params.disable_notification = true;
		return this.call<TgMessageResult>("sendRichMessage", params, signal);
	}

	/** Edit a rich message built from native blocks (tool activity feed updates). */
	editMessageTextBlocks(
		chatId: number,
		messageId: number,
		blocks: Array<Record<string, unknown>>,
		signal?: AbortSignal,
	): Promise<boolean | TgMessageResult> {
		return this.call<boolean | TgMessageResult>("editMessageText", {
			chat_id: chatId,
			message_id: messageId,
			rich_message: { blocks, skip_entity_detection: true },
		}, signal);
	}

	/** Edit a message's HTML text (fallback path for the tool activity feed). */
	editMessageTextHtml(chatId: number, messageId: number, html: string, signal?: AbortSignal): Promise<boolean | TgMessageResult> {
		return this.call<boolean | TgMessageResult>("editMessageText", {
			chat_id: chatId,
			message_id: messageId,
			text: html,
			parse_mode: "HTML",
		}, signal);
	}

	/** Stream a partial rich message (ephemeral ~30s preview; same draft_id animates in place). */
	sendRichMessageDraft(
		chatId: number,
		draftId: number,
		markdown: string,
		options: { threadId?: number } = {},
		signal?: AbortSignal,
	): Promise<boolean> {
		const params: Record<string, unknown> = { chat_id: chatId, draft_id: draftId, rich_message: { markdown } };
		if (options.threadId) params.message_thread_id = options.threadId;
		return this.call<boolean>("sendRichMessageDraft", params, signal);
	}

	answerCallbackQuery(id: string, text?: string, signal?: AbortSignal): Promise<boolean> {
		const params: Record<string, unknown> = { callback_query_id: id };
		if (text) params.text = text;
		return this.call<boolean>("answerCallbackQuery", params, signal);
	}

	setMyCommands(commands: Array<{ command: string; description: string }>, signal?: AbortSignal): Promise<boolean> {
		return this.call<boolean>("setMyCommands", { commands }, signal);
	}

	getFile(fileId: string, signal?: AbortSignal): Promise<TgFileInfo> {
		return this.call<TgFileInfo>("getFile", { file_id: fileId }, signal);
	}

	async downloadFile(filePath: string, signal?: AbortSignal): Promise<Uint8Array> {
		const res = await fetch(`https://api.telegram.org/file/bot${this.token}/${filePath}`, { signal });
		if (!res.ok) throw new Error(`Telegram download ${filePath}: HTTP ${res.status}`);
		return new Uint8Array(await res.arrayBuffer());
	}

}

export function escapeHtml(text: string): string {
	return text
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;");
}

/** Split long text into Telegram-safe chunks (max 4000 chars after parsing). */
export function splitMessage(text: string, max = 4000): string[] {
	const chunks: string[] = [];
	let rest = text;
	while (rest.length > max) {
		let cut = rest.lastIndexOf("\n", max);
		if (cut <= 0) cut = max;
		chunks.push(rest.slice(0, cut));
		rest = rest.slice(cut).replace(/^\n/, "");
	}
	if (rest) chunks.push(rest);
	return chunks;
}

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
	return new Promise((resolve) => {
		const timer = setTimeout(resolve, ms);
		signal?.addEventListener("abort", () => {
			clearTimeout(timer);
			resolve();
		}, { once: true });
	});
}

/** Sanitize an uploaded filename for local disk use. */
export function sanitizeFilename(name: string): string {
	const base = name.split(/[\\/]/).pop() ?? "file";
	return base.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 120) || "file";
}
