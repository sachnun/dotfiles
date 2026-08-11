import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { isToolCallEventType, isBashToolResult } from "@earendil-works/pi-coding-agent";

const FIND_TIMEOUT_SECONDS = 5;

const TIMEOUT_MESSAGE = `find command timed out after ${FIND_TIMEOUT_SECONDS}s. Use \`fd\` (file discovery) or \`rg\` (content search) instead — much faster:
- fd -e ts                    # files by extension (find . -name '*.ts')
- fd -t d                     # directories (find . -type d)
- fd --max-depth 2 -e ts      # with depth limit
- rg "pattern" path            # search file contents (instead of find + grep)
- rg -l "pattern"             # only print matching file names`;

interface Token {
	text: string;
	quoted: boolean;
	meta: boolean;
	start: number;
}

// pi runs commands via `bash -c`, so quoted/escaped metacharacters are part of
// a token; unquoted `|`, `;`, `&`, `<`, `>`, `(`, `)` end the command
// invocation.
function tokenize(command: string): Token[] {
	const tokens: Token[] = [];
	let i = 0;
	while (i < command.length) {
		const c = command[i];
		if (/\s/.test(c)) {
			i++;
			continue;
		}
		const start = i;
		if ("|;&<>()".includes(c)) {
			tokens.push({ text: c, quoted: false, meta: true, start });
			i++;
			continue;
		}
		let text = "";
		let quoted = false;
		while (i < command.length) {
			const ch = command[i];
			if (ch === "'" || ch === '"') {
				quoted = true;
				i++;
				while (i < command.length && command[i] !== ch) {
					text += command[i];
					i++;
				}
				if (i < command.length) i++; // closing quote
				continue;
			}
			if (ch === "\\") {
				if (i + 1 < command.length) {
					text += command[i + 1];
					i += 2;
					continue;
				}
				i++;
				continue;
			}
			if (/\s/.test(ch) || "|;&<>()".includes(ch)) break;
			text += ch;
			i++;
		}
		tokens.push({ text, quoted, meta: false, start });
	}
	return tokens;
}

const FIND_WRAPPERS = new Set(["sudo", "xargs", "time", "command", "env", "nohup", "doas", "nice"]);

// Index of the first token that actually invokes `find` as a command (start of
// a command, after a separator, or after a known command wrapper). Avoids false
// positives like `rg find .` or `echo find`.
function findCommandIndex(tokens: Token[]): number {
	for (let i = 0; i < tokens.length; i++) {
		const t = tokens[i];
		if (t.meta || t.quoted || t.text !== "find") continue;
		const prev = tokens[i - 1];
		if (!prev || prev.meta || FIND_WRAPPERS.has(prev.text)) return i;
	}
	return -1;
}

const GREP_FLAGS = new Set(["l", "c", "n", "H", "h", "i", "w", "E", "F", "x", "s", "v", "q"]);

interface FindRewrite {
	paths: string[];
	follow: boolean;
	glob?: string;
	maxDepth?: string;
	type?: "f" | "d";
	grep?: { flags: string[]; pattern: string };
}

interface ExecParse {
	flags: string[];
	pattern: string;
	next: number;
}

// Parse the tokens of a `find` invocation (starting after the `find` token).
// Returns null when any predicate has no fd/rg equivalent (e.g. -mtime, -size,
// -perm, -newer, -delete, -print0, -o, !, -iname, -exec with non-grep).
function parseFindArgs(tokens: Token[], start: number): FindRewrite | null {
	const out: FindRewrite = { paths: [], follow: false };
	let i = start;
	let seenPredicate = false;
	let grepSeen = false;
	while (i < tokens.length) {
		const t = tokens[i];
		if (t.meta) break; // end of this command invocation
		if (t.text === "!") return null;
		if (!t.text.startsWith("-")) {
			if (seenPredicate) return null;
			out.paths.push(t.text);
			i++;
			continue;
		}
		seenPredicate = true;
		switch (t.text) {
			case "-L":
				out.follow = true;
				i++;
				break;
			case "-P":
			case "-H":
			case "-print":
				i++;
				break;
			case "-type": {
				const v = tokens[i + 1];
				if (!v || v.meta || (v.text !== "f" && v.text !== "d") || out.type !== undefined) return null;
				out.type = v.text;
				i += 2;
				break;
			}
			case "-maxdepth": {
				const v = tokens[i + 1];
				if (!v || v.meta || !/^\d+$/.test(v.text)) return null;
				out.maxDepth = v.text;
				i += 2;
				break;
			}
			case "-name": {
				const v = tokens[i + 1];
				if (!v || v.meta || out.glob !== undefined) return null;
				out.glob = v.text;
				i += 2;
				break;
			}
			case "-exec": {
				if (grepSeen) return null;
				const exec = parseGrepExec(tokens, i + 1);
				if (!exec) return null;
				// rg cannot express -maxdepth, and grep on directories is meaningless.
				if (out.maxDepth !== undefined || out.type === "d") return null;
				out.grep = exec;
				grepSeen = true;
				i = exec.next;
				break;
			}
			default:
				return null;
		}
	}
	return out;
}

// Parse `grep [flags] pattern {} \;` (or `{} +`).
function parseGrepExec(tokens: Token[], i: number): ExecParse | null {
	const cmd = tokens[i];
	if (!cmd || cmd.meta || cmd.text !== "grep") return null;
	i++;
	const flags: string[] = [];
	let pattern: string | undefined;
	for (; i < tokens.length; i++) {
		const t = tokens[i];
		if (t.meta) return null; // unterminated -exec
		if (t.text === "{}") {
			i++;
			break;
		}
		if (t.text.startsWith("-")) {
			const m = /^-([a-zA-Z]+)$/.exec(t.text);
			if (!m) return null;
			for (const ch of m[1]) if (!GREP_FLAGS.has(ch)) return null;
			flags.push(...m[1]);
			continue;
		}
		if (pattern !== undefined) return null; // more than one pattern
		pattern = t.text;
	}
	if (pattern === undefined) return null;
	const term = tokens[i];
	if (!term || term.meta || (term.text !== ";" && term.text !== "+")) return null;
	return { flags, pattern, next: i + 1 };
}

// Quote anything that could be reinterpreted by the shell: whitespace, glob
// metacharacters (* ? [), quotes, $, and backslashes must reach rg verbatim.
function shellQuote(s: string): string {
	if (s.length > 0 && !/[^A-Za-z0-9_./{}!@%+=:,~-]/.test(s)) return s;
	return `'${s.replace(/'/g, `'\\''`)}'`;
}

// fd is pi's bundled find replacement (auto-installed and on PATH); rg handles
// the -exec grep case, which is its strength.
function buildReplacement(parsed: FindRewrite): string {
	const parts: string[] = [];
	if (parsed.grep) {
		parts.push("rg");
		if (parsed.grep.flags.length) parts.push(`-${parsed.grep.flags.join("")}`);
		parts.push(shellQuote(parsed.grep.pattern));
		parts.push("--hidden", "--no-ignore");
		if (parsed.follow) parts.push("--follow");
		if (parsed.glob !== undefined) parts.push("-g", shellQuote(parsed.glob));
	} else {
		parts.push("fd");
		// find lists everything, including hidden and gitignored paths.
		parts.push("-H", "--no-ignore");
		if (parsed.follow) parts.push("-L");
		if (parsed.maxDepth !== undefined) parts.push("--max-depth", parsed.maxDepth);
		if (parsed.type !== undefined) parts.push("-t", parsed.type);
		if (parsed.glob !== undefined) {
			parts.push("-g", shellQuote(parsed.glob));
		} else if (parsed.paths.length > 0) {
			// A bare path would be misread as a pattern by fd; emit a match-all
			// pattern so every path is treated as a search root.
			parts.push(".");
		}
	}
	for (const p of parsed.paths) {
		// With the match-all pattern emitted above, a lone "." path is redundant.
		if (parsed.glob === undefined && p === "." && parsed.paths.length === 1) continue;
		parts.push(shellQuote(p));
	}
	return parts.join(" ");
}

// Rewrite the first `find` invocation in `command` to `rg`. Returns null when
// the invocation uses predicates rg cannot express.
function rewriteFind(command: string): string | null {
	if (command.includes("$(") || command.includes("`")) return null;
	const tokens = tokenize(command);
	const idx = findCommandIndex(tokens);
	if (idx === -1) return null;
	const parsed = parseFindArgs(tokens, idx + 1);
	if (!parsed) return null;

	let end = command.length;
	for (let k = idx + 1; k < tokens.length; k++) {
		if (tokens[k].meta) {
			end = tokens[k].start;
			break;
		}
	}
	const prefix = command.slice(0, tokens[idx].start);
	let suffix = command.slice(end);
	// The original whitespace before a metacharacter (e.g. `| xargs`) was not
	// part of the find span, so re-add a separator for `|`, `&`, `<`, `>`.
	const built = buildReplacement(parsed);
	if (suffix && /^[|&<>]/.test(suffix) && !/\s$/.test(built)) suffix = ` ${suffix}`;
	return prefix + built + suffix;
}

// Rewrite every safe `find` invocation. Returns the final command and whether
// any `find` invocation remains (unsafe ones are left for the watchdog).
function replaceAllFinds(command: string): { command: string; anyRemaining: boolean } {
	let current = command;
	for (let n = 0; n < 5; n++) {
		const rewritten = rewriteFind(current);
		if (rewritten === null) break;
		current = rewritten;
	}
	return { command: current, anyRemaining: findCommandIndex(tokenize(current)) !== -1 };
}

export default function (pi: ExtensionAPI) {
	// toolCallIds of bash calls that still use `find` and were capped with a timeout.
	const tracked = new Set<string>();

	pi.on("tool_call", (event) => {
		if (!isToolCallEventType("bash", event)) return;
		if (findCommandIndex(tokenize(event.input.command)) === -1) return;

		const rewritten = replaceAllFinds(event.input.command);
		if (rewritten.command !== event.input.command) {
			event.input.command = rewritten.command;
		}
		if (!rewritten.anyRemaining) return; // fully converted to rg

		// Unsupported `find` usage remains: cap at 5s so a stuck find fails fast.
		event.input.timeout = Math.min(event.input.timeout ?? FIND_TIMEOUT_SECONDS, FIND_TIMEOUT_SECONDS);
		tracked.add(event.toolCallId);
	});

	pi.on("tool_result", (event, ctx) => {
		if (!tracked.has(event.toolCallId)) return;
		tracked.delete(event.toolCallId);
		if (!isBashToolResult(event)) return;
		if (!event.isError) return;

		const text = event.content.map((c) => (c.type === "text" ? c.text : "")).join("\n");
		if (!text.includes("timed out")) return;

		ctx.ui.notify("find timed out — use fd or rg instead", "error");
		return {
			isError: true,
			content: [{ type: "text", text: TIMEOUT_MESSAGE }],
		};
	});
}
