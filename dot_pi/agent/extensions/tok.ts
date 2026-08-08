/**
 * pi-token-speed — live token throughput indicator.
 *
 * Counts token deltas from the assistant stream (text, thinking, toolcall)
 * and shows a smoothed "XX tok/s" rate in place of the "Working ..." loader
 * message while the agent is streaming. Restores the default message
 * when the agent is idle.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const INTERVAL_MS = 200;
const WINDOW_MS = 1000; // sliding window used to smooth the rate

export default function (pi: ExtensionAPI) {
	let timer: ReturnType<typeof setInterval> | undefined;
	let pendingTokens = 0; // tokens streamed since the last tick
	let lastText: string | undefined; // last rendered message, to skip redundant renders
	const samples: Array<{ t: number; tokens: number }> = [];

	// Real-time token counting straight from the stream deltas.
	pi.on("message_update", (event) => {
		const ev = event.assistantMessageEvent as { type?: string; delta?: unknown };
		if (typeof ev?.delta === "string" && ev.delta.length > 0) {
			pendingTokens += ev.delta.length / 4; // ~4 chars per token
		}
	});

	pi.on("session_start", async (_event, ctx) => {
		clearInterval(timer);
		samples.length = 0;
		pendingTokens = 0;

		timer = setInterval(() => {
			// Restore the default message when the agent is idle.
			if (ctx.isIdle()) {
				samples.length = 0;
				pendingTokens = 0;
				if (lastText !== undefined) {
					ctx.ui.setWorkingMessage();
					lastText = undefined;
				}
				return;
			}

			const now = performance.now();
			samples.push({ t: now, tokens: pendingTokens });
			pendingTokens = 0;
			while (samples.length > 2 && now - samples[0].t > WINDOW_MS) samples.shift();

			let total = 0;
			for (const s of samples) total += s.tokens;
			const span = now - samples[0].t;
			const rate = span > 0 ? (total / span) * 1000 : 0;

			// Render only when the value actually changed; keeps the window building.
			const text = rate > 0 ? `${Math.round(rate)} tok/s` : undefined;
			if (text !== lastText) {
				ctx.ui.setWorkingMessage(text);
				lastText = text;
			}
		}, INTERVAL_MS);
	});

	pi.on("session_shutdown", async () => {
		clearInterval(timer);
		timer = undefined;
		samples.length = 0;
		pendingTokens = 0;
	});
}
