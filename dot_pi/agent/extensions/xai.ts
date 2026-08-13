/**
 * Minimal override of the built-in "xai" provider.
 *
 * Routes it through the Grok CLI chat proxy (free / SuperGrok subscription
 * tier) instead of api.x.ai/v1, while keeping the built-in login/logout,
 * model catalog, and model configs untouched.
 *
 * The client version is auto-detected from the same upstream channel pointer
 * the install script uses (https://x.ai/cli/stable), falling back to the
 * locally installed grok CLI's ~/.grok/version.json and then a hardcoded
 * value. The client identifier is the fixed session label baked into the
 * grok CLI. No env vars required.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const PROXY_BASE_URL = "https://cli-chat-proxy.grok.com/v1";
const CLIENT_IDENTIFIER = "grok-shell";
const UPSTREAM_VERSION_URL = "https://x.ai/cli/stable";
const FALLBACK_VERSION = "1.0.3";
const VERSION_PATTERN = /^\d+\.\d+\.\d+(-[A-Za-z0-9._]+)?$/;

function platformLabel(): string {
	const os =
		process.platform === "darwin"
			? "macos"
			: process.platform === "win32"
				? "windows"
				: process.platform;
	const arch =
		process.arch === "arm64"
			? "aarch64"
			: process.arch === "x64"
				? "x86_64"
				: process.arch;
	return `${os}; ${arch}`;
}

function localGrokVersion(): string | undefined {
	try {
		const home = process.env.GROK_HOME || join(homedir(), ".grok");
		const v = JSON.parse(readFileSync(join(home, "version.json"), "utf8")) as {
			version?: string;
		};
		return typeof v.version === "string" && VERSION_PATTERN.test(v.version)
			? v.version
			: undefined;
	} catch {
		return undefined;
	}
}

async function upstreamGrokVersion(): Promise<string | undefined> {
	try {
		const res = await fetch(UPSTREAM_VERSION_URL, {
			redirect: "manual",
			signal: AbortSignal.timeout(5000),
		});
		if (!res.ok) return undefined;
		const text = (await res.text()).trim();
		return VERSION_PATTERN.test(text) ? text : undefined;
	} catch {
		return undefined;
	}
}

async function detectVersion(): Promise<string> {
	const upstream = await upstreamGrokVersion();
	if (upstream) return upstream;
	const local = localGrokVersion();
	if (local) return local;
	return FALLBACK_VERSION;
}

function textFromContent(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.map((part) => {
			if (typeof part === "string") return part;
			if (!part || typeof part !== "object") return "";
			const item = part as Record<string, unknown>;
			const type = item.type;
			return (type === "text" || type === "input_text" || type === "output_text") &&
				typeof item.text === "string"
				? (item.text as string)
				: "";
		})
		.filter(Boolean)
		.join("\n");
}

/**
 * Fix xAI Responses quirks that stock OpenAI payloads trip on:
 * - `role: "system"` / `role: "developer"` in `input` are rejected; move
 *   leading ones to top-level `instructions`.
 * - Replayed `{ type: "reasoning" }` items in `input` cause 400.
 * - Empty-string content items fail validation.
 * - `prompt_cache_retention`, `seed`, `parallel_tool_calls`, `service_tier`
 *   are OpenAI-only and rejected with 422.
 */
function sanitizeResponses(payload: Record<string, unknown>): Record<string, unknown> {
	const next = { ...payload };

	if (Array.isArray(next.input)) {
		const input = (next.input as unknown[])
			.map((item) => {
				if (!item || typeof item !== "object") return item;
				const obj = item as Record<string, unknown>;
				if (obj.type === "reasoning") return null;
				if (typeof obj.content === "string" && obj.content.length === 0) return null;
				return obj;
			})
			.filter(Boolean) as Record<string, unknown>[];

		const instructionParts: string[] = [];
		while (input.length > 0) {
			const first = input[0];
			const role = first?.role;
			if (role !== "system" && role !== "developer") break;
			const text = textFromContent(first.content).trim();
			if (text) instructionParts.push(text);
			input.shift();
		}
		if (instructionParts.length > 0) {
			const existing =
				typeof next.instructions === "string" && next.instructions ? next.instructions : "";
			next.instructions = [existing, ...instructionParts]
				.filter((part) => part.length > 0)
				.join("\n\n");
		}
		next.input = input;
	}

	delete next.prompt_cache_retention;
	delete next.seed;
	delete next.parallel_tool_calls;
	delete next.service_tier;

	return next;
}

export default async function (pi: ExtensionAPI) {
	const version = await detectVersion();

	pi.registerProvider("xai", {
		baseUrl: PROXY_BASE_URL,
		headers: {
			"User-Agent": `${CLIENT_IDENTIFIER}/${version} (${platformLabel()})`,
			"x-grok-client-identifier": CLIENT_IDENTIFIER,
			"x-grok-client-version": version,
			"x-grok-client-mode": "interactive",
			"X-XAI-Token-Auth": "xai-grok-cli",
			"x-authenticateresponse": "authenticate-response",
		},
	});

	pi.on("before_provider_request", (event, ctx) => {
		if (ctx.model?.provider !== "xai") return;
		const payload = event.payload;
		if (!payload || typeof payload !== "object" || Array.isArray(payload)) return;
		if (!Array.isArray((payload as Record<string, unknown>).input)) return;
		return sanitizeResponses(payload as Record<string, unknown>);
	});
}
