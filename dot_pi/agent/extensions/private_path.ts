/**
 * Path Border - moves pi's built-in footer path into the editor's top border.
 *
 * The top border shows the footer's pwd line (`~`, git branch, session name) in dim;
 * the footer is the built-in FooterComponent rendered without its pwd line.
 * Usage: pi --extension ./path.ts
 */

import { isAbsolute, relative, resolve, sep } from "node:path";
import {
	CustomEditor,
	FooterComponent,
	type ExtensionAPI,
	type KeybindingsManager,
	type Theme,
} from "@earendil-works/pi-coding-agent";
import type { EditorTheme, TUI } from "@earendil-works/pi-tui";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

const MARGIN = 2; // ekor ── setelah label

/** Same formatting as pi's built-in footer (formatCwdForFooter). */
function fmtCwd(cwd: string, home?: string): string {
	if (!home) return cwd;
	const rel = relative(resolve(home), resolve(cwd));
	return rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel)
		? rel === ""
			? "~"
			: `~${sep}${rel}`
		: cwd;
}

/** Keep the right end of `text` up to `max` visible columns (plain text only). */
function keepRight(text: string, max: number): string {
	return [...truncateToWidth([...text].reverse().join(""), max, "")].reverse().join("");
}

function borderLine(
	width: number,
	label: string,
	border: (s: string) => string,
	color: (s: string) => string,
): string {
	if (width <= 0 || !label) return border("─".repeat(width));
	const avail = width - MARGIN;
	let padded = ` ${label} `;
	if (visibleWidth(padded) > avail) padded = ` ${keepRight(label, avail - 2)} `;
	return (
		border("─".repeat(Math.max(0, width - visibleWidth(padded) - MARGIN))) +
		color(padded) +
		border("─".repeat(MARGIN))
	);
}

class PathEditor extends CustomEditor {
	constructor(
		tui: TUI,
		theme: EditorTheme,
		keybindings: KeybindingsManager,
		private label: () => string,
		private fullTheme: Theme,
	) {
		super(tui, theme, keybindings, { paddingX: 0 });
		// Pin the border color to dim and ignore pi's thinking-level color ramp
		// (pi assigns this.borderColor on every thinking level / bash mode change).
		Object.defineProperty(this, "borderColor", {
			get: () => (s: string) => fullTheme.fg("dim", s),
			set: () => {},
			configurable: true,
		});
	}

	render(width: number): string[] {
		const lines = super.render(width);
		if (lines.length < 1) return lines;
		const border = (s: string) => this.borderColor(s);
		// Only the top border is replaced; the bottom border and any
		// autocomplete dropdown lines below it are left untouched.
		lines[0] = borderLine(width, this.label(), border, (s) => this.fullTheme.fg("dim", s));
		return lines;
	}
}

export default function (pi: ExtensionAPI) {
	pi.on("session_start", (_event, ctx) => {
		const home = process.env.HOME || process.env.USERPROFILE;
		const shared = { branch: null as string | null };

		ctx.ui.setFooter((tui, _theme, footerData) => {
			// The initial branch resolve does NOT fire onBranchChange, so read it once here.
			shared.branch = footerData.getGitBranch();
			const unsub = footerData.onBranchChange(() => {
				shared.branch = footerData.getGitBranch();
				tui.requestRender();
			});
			// Built-in footer with a fabricated session, minus its pwd line.
			// `state` is a live getter so model/thinking level are read fresh on every render.
			const session = {
				get state() {
					return { model: ctx.model, thinkingLevel: ctx.thinkingLevel };
				},
				sessionManager: ctx.sessionManager,
				getContextUsage: () => ctx.getContextUsage(),
				modelRuntime: { isUsingSubscription: () => false },
			} as unknown as ConstructorParameters<typeof FooterComponent>[0];
			const footer = new FooterComponent(session, footerData);
			return {
				dispose: unsub,
				invalidate: () => footer.invalidate(),
				render: (width: number) => footer.render(width).slice(1),
			};
		});

		const label = () => {
			let p = fmtCwd(ctx.cwd, home);
			if (shared.branch) p += ` (${shared.branch})`;
			const name = ctx.sessionManager.getSessionName();
			if (name) p += ` • ${name}`;
			return p;
		};

		ctx.ui.setEditorComponent((tui, theme, keybindings) => new PathEditor(tui, theme, keybindings, label, ctx.ui.theme));
	});
}
