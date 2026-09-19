/**
 * tps — live token throughput in the working label.
 *
 * Counts stream deltas (text/thinking/toolcall) and replaces the streaming
 * "Working" label with a smoothed "XX tok/s" rate. When the agent goes idle
 * the default "Working" label is restored.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const TICK_MS = 200;
const WINDOW_MS = 1000;
const CHARS_PER_TOKEN = 4;

export default function (pi: ExtensionAPI) {
	let timer: ReturnType<typeof setInterval> | undefined;
	let pending = 0;
	let last: string | undefined;
	const samples: Array<{ at: number; tokens: number }> = [];

	pi.on("message_update", (event) => {
		const { delta } = event.assistantMessageEvent as { delta?: unknown };
		if (typeof delta === "string") pending += delta.length / CHARS_PER_TOKEN;
	});

	pi.on("session_start", (_event, ctx) => {
		clearInterval(timer);
		samples.length = 0;
		pending = 0;
		last = undefined;

		timer = setInterval(() => {
			if (ctx.isIdle()) {
				samples.length = 0;
				pending = 0;
				if (last !== undefined) {
					ctx.ui.setWorkingMessage();
					last = undefined;
				}
				return;
			}

			const now = performance.now();
			samples.push({ at: now, tokens: pending });
			pending = 0;
			while (samples.length > 2 && now - samples[0].at > WINDOW_MS) samples.shift();

			let total = 0;
			for (const sample of samples) total += sample.tokens;
			const span = now - samples[0].at;
			const rate = span > 0 ? (total / span) * 1000 : 0;
			const text = rate > 0 ? `${Math.round(rate)} tok/s` : undefined;

			if (text === last) return;
			ctx.ui.setWorkingMessage(text);
			last = text;
		}, TICK_MS);
	});

	pi.on("session_shutdown", () => {
		clearInterval(timer);
		timer = undefined;
		samples.length = 0;
		pending = 0;
		last = undefined;
	});
}
