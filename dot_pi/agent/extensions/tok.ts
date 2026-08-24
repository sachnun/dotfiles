import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const INTERVAL_MS = 200;

export default function (pi: ExtensionAPI) {
	let timer: ReturnType<typeof setInterval> | undefined;
	let pending = 0;

	pi.on("message_update", (event) => {
		const ev = event.assistantMessageEvent as { type?: string; delta?: unknown };
		if (typeof ev?.delta === "string") pending += ev.delta.length / 4;
	});

	pi.on("session_start", async (_event, ctx) => {
		clearInterval(timer);
		pending = 0;
		timer = setInterval(() => {
			if (ctx.isIdle()) {
				pending = 0;
				ctx.ui.setWorkingMessage();
				return;
			}
			if (pending > 0) {
				ctx.ui.setWorkingMessage(`${Math.round((pending / INTERVAL_MS) * 1000)} tok/s`);
				pending = 0;
			}
		}, INTERVAL_MS);
	});

	pi.on("session_shutdown", async () => {
		clearInterval(timer);
		timer = undefined;
		pending = 0;
	});
}
