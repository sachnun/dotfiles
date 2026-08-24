import { execFileSync } from "node:child_process";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { isToolCallEventType } from "@earendil-works/pi-coding-agent";

const FD = (() => {
	try {
		execFileSync("which", ["fd"], { stdio: "ignore" });
		return "fd";
	} catch {
		return "fdfind";
	}
})();

const q = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

function tokens(cmd: string): [string, number][] {
	const out: [string, number][] = [];
	let buf = "";
	let start = 0;
	let quote = "";
	for (let i = 0; i < cmd.length; i++) {
		const c = cmd[i];
		if (!buf) start = i;
		if (quote) {
			if (c === quote) quote = "";
			else buf += c;
			continue;
		}
		if (c === "'" || c === '"') {
			quote = c;
			continue;
		}
		if (c === "\\" && i + 1 < cmd.length) {
			buf += cmd[++i];
			continue;
		}
		if (/\s/.test(c) || "|;&<>()".includes(c)) {
			if (buf) out.push([buf, start]);
			buf = "";
			if ("|;&<>()".includes(c)) out.push([c, i]);
			continue;
		}
		buf += c;
	}
	if (buf) out.push([buf, start]);
	return out;
}

interface R {
	fd: string[];
	rg?: string[];
	glob?: string;
	paths: string[];
}

function parse(ts: [string, number][], i: number): R | null {
	const r: R = { fd: [], paths: [] };
	let rgBad = false;
	for (; i < ts.length; i++) {
		const t = ts[i][0];
		if (t === "!") return null;
		if ("|;&<>()".includes(t)) return r;
		if (!t.startsWith("-")) {
			r.paths.push(t);
			continue;
		}
		switch (t) {
			case "-name": {
				const g = ts[++i]?.[0];
				if (g === undefined || r.glob !== undefined) return null;
				r.glob = g;
				break;
			}
			case "-type": {
				const v = ts[++i]?.[0];
				if (v !== "f" && v !== "d") return null;
				if (v === "d") rgBad = true;
				r.fd.push("-t", v);
				break;
			}
			case "-maxdepth": {
				const n = ts[++i]?.[0];
				if (!/^\d+$/.test(n ?? "")) return null;
				rgBad = true;
				r.fd.push("--max-depth", n);
				break;
			}
			case "-exec": {
				if (rgBad || ts[i + 1]?.[0] !== "grep") return null;
				const flags: string[] = [];
				let pat: string | undefined;
				let k = i + 2;
				for (; k < ts.length; k++) {
					const x = ts[k][0];
					if (x === "{}") break;
					if (/^-[a-zA-Z]+$/.test(x)) {
						flags.push(x);
						continue;
					}
					if (pat !== undefined) return null;
					pat = x;
				}
				if (pat === undefined || ![";", "+"].includes(ts[k + 1]?.[0] ?? "")) return null;
				r.rg = [...flags, q(pat), "--hidden", "--no-ignore"];
				i = k + 1;
				break;
			}
			default:
				return null;
		}
	}
	return r;
}

function build(r: R): string {
	const parts: string[] = [];
	if (r.rg) {
		parts.push("rg", ...r.rg);
		if (r.glob !== undefined) parts.push("-g", q(r.glob));
	} else {
		parts.push(FD, "-H", "--no-ignore", ...r.fd);
		if (r.glob !== undefined) parts.push("-g", q(r.glob));
		else if (r.paths.length > 0) parts.push(".");
	}
	for (const p of r.paths) {
		if (r.glob === undefined && p === "." && r.paths.length === 1) continue;
		parts.push(q(p));
	}
	return parts.join(" ");
}

function findIdx(ts: [string, number][]): number {
	for (let i = 0; i < ts.length; i++) {
		if (ts[i][0] === "find" && (i === 0 || "|;&<>()".includes(ts[i - 1][0]))) return i;
	}
	return -1;
}

function rewrite(cmd: string): string | null {
	if (cmd.includes("$(") || cmd.includes("`")) return null;
	const ts = tokens(cmd);
	const fi = findIdx(ts);
	if (fi === -1) return null;
	const r = parse(ts, fi + 1);
	if (!r) return null;
	let end = cmd.length;
	for (let i = fi + 1; i < ts.length; i++) {
		if ("|;&<>()".includes(ts[i][0]) && cmd[ts[i][1]] !== "\\") {
			end = ts[i][1];
			break;
		}
	}
	let suffix = cmd.slice(end);
	const built = build(r);
	if (suffix && /^[|&<>]/.test(suffix) && !/\s$/.test(built)) suffix = ` ${suffix}`;
	return cmd.slice(0, ts[fi][1]) + built + suffix;
}

function replaceAll(cmd: string): string {
	let out = cmd;
	for (let n = 0; n < 5; n++) {
		const r = rewrite(out);
		if (r === null) break;
		out = r;
	}
	return out;
}

export default function (pi: ExtensionAPI) {
	pi.on("tool_call", (event) => {
		if (!isToolCallEventType("bash", event)) return;
		const r = replaceAll(event.input.command);
		if (r !== event.input.command) event.input.command = r;
	});
}
