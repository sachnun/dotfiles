#!/usr/bin/env node
// pi-chrome CLI — drives the pi-chrome bridge (the companion Chrome extension) from bash.
// The bridge is started automatically by the pi-chrome Pi extension
// (~/.pi/agent/extensions/chrome/index.ts) when Pi opens. This CLI is the model-facing
// surface of the `chrome` skill: it maps commands to bridge actions via POST /command.
"use strict";

const { resolve, join, dirname } = require("node:path");
const { writeFile, mkdir } = require("node:fs/promises");

const BRIDGE_URL = process.env.PI_CHROME_BRIDGE_URL || "http://127.0.0.1:17318";
const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_TEXT_CHARS = 30_000;

// The bundled Chrome companion extension lives next to the pi-chrome extension:
// ~/.pi/agent/extensions/chrome/connector
const CONNECTOR_PATH = resolve(__dirname, "..", "..", "connector");

// ---------------------------------------------------------------------------
// Bridge client
// ---------------------------------------------------------------------------

async function send(action, params, timeoutMs) {
  let response;
  try {
    response = await fetch(`${BRIDGE_URL}/command`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action, params: params || {}, timeoutMs: timeoutMs || DEFAULT_TIMEOUT_MS }),
      signal: AbortSignal.timeout((timeoutMs || DEFAULT_TIMEOUT_MS) + 3_000),
    });
  } catch (error) {
    throw new Error(
      `Cannot reach the pi-chrome bridge at ${BRIDGE_URL} (${error.message}). ` +
        "Start pi (the bridge runs automatically), then retry.",
    );
  }
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || !payload.ok) throw new Error(payload.error || `bridge HTTP ${response.status}`);
  return payload.result;
}

async function bridgeStatus() {
  const response = await fetch(`${BRIDGE_URL}/status`, { cache: "no-store", signal: AbortSignal.timeout(3_000) });
  if (!response.ok) throw new Error(`bridge /status HTTP ${response.status}`);
  return response.json();
}

// Fast fail for everything except diagnostics: if the Chrome extension is not polling,
// commands would otherwise hang until timeout. Re-checks once after 1.5 s to cover the brief
// window right after Pi starts (the extension polls within ~1 s).
async function ensureConnected() {
  let status;
  try {
    status = await bridgeStatus();
  } catch {
    return; // bridge down: let the command produce its own clearer error
  }
  if (status.connected) return;
  await new Promise((resolveWait) => setTimeout(resolveWait, 1_500));
  try {
    status = await bridgeStatus();
  } catch {
    return;
  }
  if (!status.connected) {
    throw new Error(
      "Chrome is not connected (the Pi extension is not polling). " +
        "Open Chrome and make sure 'Pi' is enabled at chrome://extensions, then retry. " +
        "Run `chrome.ts status` for details.",
    );
  }
}

// ---------------------------------------------------------------------------
// Output formatting
// ---------------------------------------------------------------------------

function truncateText(text, maxChars = MAX_TEXT_CHARS) {
  const value = String(text ?? "");
  if (value.length <= maxChars) return value;
  return `${value.slice(0, maxChars)}\n\n[truncated ${value.length - maxChars} characters]`;
}

function compactLine(value, max = 140) {
  const text = String(value ?? "").replace(/\s+/g, " ").trim();
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function rectText(rect) {
  if (!rect) return "?";
  return `${rect.x},${rect.y} ${rect.width}x${rect.height}`;
}

function formatSnapshot(snapshot) {
  if (!snapshot || typeof snapshot !== "object") return JSON.stringify(snapshot, null, 2);
  if (snapshot.mode === "full") return truncateText(JSON.stringify(snapshot, null, 2));
  const lines = [];
  lines.push(`# Chrome snapshot${snapshot.mode ? ` (${snapshot.mode})` : ""}`);
  lines.push(`${snapshot.title || "(untitled)"}`);
  if (snapshot.url) lines.push(`${snapshot.url}`);
  if (snapshot.viewport) {
    lines.push(`viewport=${snapshot.viewport.width}x${snapshot.viewport.height} scroll=${snapshot.viewport.scrollX || 0},${snapshot.viewport.scrollY || 0}`);
  }
  if (snapshot.summary?.modal) lines.push(`modal: ${snapshot.summary.modal.uid} ${compactLine(snapshot.summary.modal.label)}`);
  if (snapshot.summary?.focused) {
    lines.push(`focused: ${snapshot.summary.focused.uid} ${snapshot.summary.focused.role || ""} ${compactLine(snapshot.summary.focused.label)}`);
  }
  if (Array.isArray(snapshot.summary?.hints) && snapshot.summary.hints.length) {
    lines.push("\n## Hints");
    for (const hint of snapshot.summary.hints.slice(0, 6)) lines.push(`- ${hint}`);
  }
  if (snapshot.diff && !snapshot.diff.firstSnapshot) {
    const changed = [
      ...(snapshot.diff.changes || []).map((c) => (c.kind === "textChanged" ? "text changed" : `${c.kind}: ${compactLine(c.before, 50)} → ${compactLine(c.after, 50)}`)),
      ...(snapshot.diff.added || []).slice(0, 4).map((e) => `added ${e.uid} ${e.role || ""} ${compactLine(e.label)}`),
      ...(snapshot.diff.updated || []).slice(0, 4).map((u) => `updated ${u.uid} ${compactLine(u.after?.label || u.before?.label)}`),
    ];
    if (changed.length) {
      lines.push("\n## Changed since last snapshot");
      for (const item of changed.slice(0, 10)) lines.push(`- ${item}`);
    }
  }
  if (Array.isArray(snapshot.matches) && snapshot.matches.length) {
    lines.push(`\n## Matches for "${snapshot.query}"`);
    for (const match of snapshot.matches.slice(0, 12)) {
      if (match.kind === "text") lines.push(`- ${match.uid} text ${compactLine(match.text)} @ ${rectText(match.rect)}`);
      else if (match.kind === "region") {
        lines.push(`- ${match.uid} region ${compactLine(match.label)} headings=${(match.headings || []).map((h) => compactLine(h, 50)).join(" | ")}`);
      } else {
        lines.push(`- ${match.uid} ${match.role || match.tag || "element"}${match.disabled ? " disabled" : ""} ${compactLine(match.label || match.selector)} @ ${rectText(match.rect)}`);
      }
    }
  }
  if ((snapshot.mode === "forms" || snapshot.forms?.fields?.length) && snapshot.mode !== "pageMap") {
    const fields = snapshot.forms?.fields || [];
    const submits = snapshot.forms?.submits || [];
    if (fields.length || submits.length) lines.push("\n## Forms");
    for (const field of fields.slice(0, snapshot.mode === "forms" ? 40 : 12)) {
      const value = field.value !== undefined && field.value !== "" ? ` = "${compactLine(field.value, 60)}"` : "";
      lines.push(`- ${field.uid} ${field.type ? `${field.type} ` : ""}${compactLine(field.label || field.placeholder || field.selector)}${value}`);
    }
    for (const submit of submits.slice(0, snapshot.mode === "forms" ? 20 : 6)) {
      lines.push(`- submit ${submit.uid} ${compactLine(submit.label || submit.selector)}`);
    }
  }
  if (Array.isArray(snapshot.elements) && snapshot.elements.length) {
    lines.push("\n## Elements");
    for (const el of snapshot.elements.slice(0, 40)) {
      lines.push(`- ${el.uid} ${el.role || el.tag || "element"}${el.disabled ? " disabled" : ""} ${compactLine(el.label || el.selector)} @ ${rectText(el.rect)}`);
    }
  }
  lines.push("\nTip: use snapshot --mode interactive|forms|pageMap|text|changes|full, --query, or inspect --uid <uid> to zoom in.");
  return lines.join("\n");
}

function formatInspect(inspect) {
  if (!inspect || typeof inspect !== "object") return JSON.stringify(inspect, null, 2);
  const lines = [];
  lines.push(`# Inspect ${inspect.uid || inspect.selector || "?"}`);
  if (inspect.tag || inspect.role) lines.push(`${inspect.tag || ""}${inspect.role ? ` role=${inspect.role}` : ""}`);
  if (inspect.label) lines.push(`${compactLine(inspect.label, 200)}`);
  if (inspect.rect) lines.push(`@ ${rectText(inspect.rect)}`);
  if (inspect.clickSuggestion || inspect.suggestedClick) {
    const c = inspect.clickSuggestion || inspect.suggestedClick;
    lines.push(`suggested click target: ${c.uid || c.selector || `${c.x},${c.y}`}`);
  }
  if (Array.isArray(inspect.nearby) && inspect.nearby.length) {
    lines.push("\n## Nearby");
    for (const n of inspect.nearby.slice(0, 12)) lines.push(`- ${n.uid} ${n.role || n.tag} ${compactLine(n.label || n.selector)}`);
  }
  if (Array.isArray(inspect.ancestors) && inspect.ancestors.length) {
    lines.push("\n## Ancestors");
    for (const a of inspect.ancestors.slice(0, 6)) lines.push(`- ${a.uid} ${a.role || a.tag} ${compactLine(a.label || a.selector, 120)}`);
  }
  return lines.join("\n");
}

function summarizeActionResult(result) {
  if (!result || typeof result !== "object") return undefined;
  const r = result;
  const parts = [];
  // pageMutated is a coarse heuristic (hash over body text + input values + node count);
  // a false value is NOT proof nothing happened.
  if (r.pageMutated === false) parts.push("no coarse DOM change detected (may still have taken effect — verify with --include-snapshot)");
  if (r.defaultPrevented === true) parts.push("defaultPrevented=true");
  if (r.elementVisible === false) parts.push("element NOT visible");
  if (r.occludedBy) parts.push(`occluded by <${r.occludedBy.tag || "?"}${r.occludedBy.id ? "#" + r.occludedBy.id : ""}>`);
  if (r.valueMatches === false) parts.push("input value did not stick");
  if (r.autoplayHint) parts.push("autoplay-gated affordance");
  return parts.length ? parts.join("; ") : undefined;
}

function formatActionResult(raw, text) {
  if (!raw || typeof raw !== "object" || !raw.snapshot) return text;
  return `${text}\n\n${formatSnapshot(raw.snapshot)}`;
}

function pretty(value) {
  if (value === undefined) return "undefined";
  if (typeof value === "string") return value;
  return JSON.stringify(value, null, 2);
}

// ---------------------------------------------------------------------------
// Argument parsing: --kebab-case values, --no-x booleans, --json raw passthrough
// ---------------------------------------------------------------------------

function toCamel(flag) {
  return flag.replace(/-([a-z])/g, (_, ch) => ch.toUpperCase());
}

function coerce(value) {
  if (/^-?\d+(\.\d+)?$/.test(value)) return Number(value);
  if (value === "true") return true;
  if (value === "false") return false;
  if (value === "null") return null;
  return value;
}

function parseArgs(argv) {
  const params = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--json") {
      const raw = argv[++i];
      if (raw === undefined) throw new Error("--json requires an object argument");
      Object.assign(params, JSON.parse(raw));
    } else if (arg.startsWith("--no-")) {
      params[toCamel(arg.slice(5))] = false;
    } else if (arg.startsWith("--")) {
      const key = toCamel(arg.slice(2));
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith("--")) {
        params[key] = coerce(next);
        i++;
      } else {
        params[key] = true;
      }
    }
  }
  return params;
}

// background/foreground normalization: default = background (Chrome stays hidden).
function normalizeBackground(params) {
  const { background, foreground, ...rest } = params;
  const effective = background !== undefined ? !background : foreground !== undefined ? foreground : false;
  return { ...rest, foreground: effective };
}

// ---------------------------------------------------------------------------
// Command formatters — one presentation per command, colocated with its COMMANDS
// entry. Commands without a `format` fall back to `pretty` (JSON).
// Signature: format(result, params, command) -> string | Promise<string>
// ---------------------------------------------------------------------------

function formatTabList(result) {
  const tabs = result || [];
  return tabs.length
    ? tabs.map((t) => `${t.id}\t${t.active ? "*" : " "}\t${t.group?.title ? `[${t.group.title}] ` : ""}${t.title || "(untitled)"}\t${t.url}`).join("\n")
    : "No tabs.";
}

function formatAction(result, params, command) {
  const summary = summarizeActionResult(params.includeSnapshot ? result?.result : result);
  const base =
    command === "click" ? `Clicked ${params.uid || params.selector || `${params.x},${params.y}`}` :
    command === "type" ? `Typed ${String(params.text || "").length} character(s)${params.uid || params.selector ? ` into ${params.uid || params.selector}` : ""}.` :
    command === "fill" ? `Filled ${String(params.text || "").length} character(s) into ${params.uid || params.selector}.` :
    `Pressed ${params.key}.`;
  return formatActionResult(result, `${base}${summary ? ` (${summary})` : ""}`);
}

async function formatSaveMhtml(result, params) {
  const mhtml = String(result?.mhtml || "");
  if (!mhtml) throw new Error("save-mhtml returned no data");
  const base64 = mhtml.replace(/^data:[^;]+;base64,/, "");
  const outputPath = params.out ? resolve(process.cwd(), params.out) : join(process.cwd(), ".pi", "chrome-snapshots", `${new Date().toISOString().replace(/[:.]/g, "-")}.mhtml`);
  await mkdir(dirname(outputPath), { recursive: true });
  const buf = Buffer.from(base64, "base64");
  await writeFile(outputPath, buf);
  return `Saved MHTML (${Math.round(buf.length / 1024)} KB) to ${outputPath}`;
}

function formatCookies(result) {
  return Array.isArray(result) && result.length
    ? result.map((c) => `${c.name}\t${c.domain}${c.path}\t${c.httpOnly ? "httpOnly " : ""}${c.secure ? "secure" : ""}`.trimEnd()).join("\n")
    : "No cookies.";
}

// ---------------------------------------------------------------------------
// Commands — every command is one entry: help text, bridge action, defaults,
// and (optionally) its formatter. Commands without an action are handled locally
// (status, tab, batch, help).
// ---------------------------------------------------------------------------

const COMMANDS = {
  status: { help: "pi-chrome status — bridge + extension connection state" },
  tabs: { help: "pi-chrome tabs — list tabs", action: "tab.list", format: formatTabList },
  tab: { help: "pi-chrome tab --action new|activate|close|group|ungroup [--url ...] [--target-id ...]", action: "tab" },
  snapshot: { help: "pi-chrome snapshot [--mode auto] [--query ...] [--max-elements N] [--target-id ...]", action: "page.snapshot", defaults: { maxElements: 80 }, format: formatSnapshot },
  inspect: { help: "pi-chrome inspect --uid <uid> | --selector <css>", action: "page.inspect", format: formatInspect },
  navigate: { help: "pi-chrome navigate --url <url> [--target-id ...] [--init-script ...]", action: "page.navigate", format: (_r, p) => `Navigated to ${p.url}${p.initScript ? " (with initScript)" : ""}` },
  evaluate: { help: "pi-chrome evaluate --expression <js>", action: "page.evaluate", defaults: { awaitPromise: true } },
  click: { help: "pi-chrome click --uid <uid> | --selector <css> | --x N --y N [--include-snapshot]", action: "page.click", format: formatAction },
  type: { help: "pi-chrome type --text ... [--uid ...] [--press-enter]", action: "page.type", format: formatAction },
  fill: { help: "pi-chrome fill --text ... --uid <uid> | --selector <css> [--submit]", action: "page.fill", format: formatAction },
  key: { help: "pi-chrome key --key Enter|Tab|Escape|... [--modifiers ...]", action: "page.key", format: formatAction },
  hover: { help: "pi-chrome hover --uid <uid> | --selector <css> | --x N --y N", action: "page.hover", format: (_r, p) => `Hovered ${p.uid || p.selector || `${p.x},${p.y}`}` },
  scroll: { help: "pi-chrome scroll [--delta-y N] [--delta-x N] [--uid ...]", action: "page.scroll", format: (_r, p) => `Scrolled dy=${p.deltaY ?? 0} dx=${p.deltaX ?? 0}` },
  waitfor: { help: "pi-chrome waitfor --kind selector|expression --value ... [--timeout-ms N]", action: "page.waitFor", format: (_r, p) => `Observed ${p.kind}: ${p.value}` },
  console: { help: "pi-chrome console [--clear]", action: "page.console.list" },
  network: { help: "pi-chrome network [--clear] [--include-preserved-requests]", action: "page.network.list" },
  "network-get": { help: "pi-chrome network-get --request-id <id>", action: "page.network.get" },
  upload: { help: "pi-chrome upload --paths <file1,file2> --uid <uid> | --selector <css>", action: "page.upload", format: (_r, p) => `Uploaded ${Array.isArray(p.paths) ? p.paths.length : 0} file(s) to ${p.uid || p.selector}` },
  download: { help: "pi-chrome download --url <url> [--filename <save-as-name>] [--save-as]", action: "browser.download", format: (r) => `Download started (id ${r?.downloadId ?? ""})`.trim() },
  "save-mhtml": { help: "pi-chrome save-mhtml [--out path.mhtml] [--target-id ...]", action: "browser.saveMhtml", timeout: 60_000, format: formatSaveMhtml },
  cookies: { help: "pi-chrome cookies [--url <url>]", action: "browser.cookies", format: formatCookies },
  batch: { help: "pi-chrome batch --commands '[{\"command\":\"tabs\"},...]' — run many commands in one call (or pipe JSONL on stdin); per-command timeoutMs honored" },
  help: { help: "pi-chrome help — this list" },
};

function usage() {
  const lines = ["pi-chrome — control the user's Chrome via the pi-chrome bridge\n", "Usage: pi-chrome <command> [flags] [--json '{...}']\n", "Commands:"];
  for (const [name, def] of Object.entries(COMMANDS)) lines.push(`  ${def.help}`);
  lines.push(
    "\nCommon flags:",
    "  --target-id / --url-includes / --title-includes  pick a specific existing tab",
    "  --background / --foreground                     background (default) vs watch Chrome",
    "  --timeout-ms N                                  command timeout",
    "  --json '{...}'                                  raw params passthrough",
    "\nAlways snapshot before clicking; pass --include-snapshot on click/type/fill/key to verify in one call.",
  );
  return lines.join("\n");
}

async function statusCommand() {
  let status;
  try {
    status = await bridgeStatus();
  } catch (error) {
    return `✗ pi-chrome bridge unreachable at ${BRIDGE_URL}: ${error.message}\n  Start pi — the bridge runs automatically when Pi opens.`;
  }
  const dot = status.connected ? "●" : "○";
  const lines = [`${dot} ${status.connected ? "Chrome connected" : "Chrome not connected"}`, `bridge: ${BRIDGE_URL} (${status.mode})`];
  if (status.connected) lines.push(`extension: ${status.clientName || "unknown"} · last poll ${Math.round((Date.now() - status.lastSeenAt) / 1000)}s ago`);
  else lines.push("fix: open Chrome and make sure the 'Pi' extension is enabled (chrome://extensions)");
  lines.push(`connector: ${CONNECTOR_PATH}`);
  return lines.join("\n");
}

async function runCommand(command, params, timeoutMs) {
  if (command === "status") return statusCommand();
  if (command === "tab") return runTabCommand(params, timeoutMs);
  const def = COMMANDS[command];
  const result = await send(def.action, params, timeoutMs);
  return def.format ? await def.format(result, params, command) : pretty(result);
}

async function runTabCommand(params, timeoutMs) {
  const action = String(params.action || "");
  if (!["new", "activate", "close", "group", "ungroup"].includes(action)) {
    throw new Error("tab requires --action new|activate|close|group|ungroup (list via `tabs`)");
  }
  const { action: _a, ...rest } = params;
  const result = await send(`tab.${action}`, rest, timeoutMs);
  if (action === "new") return `Opened tab ${typeof result === "object" && result ? result.id ?? "" : ""}: ${params.url || ""}`.trim();
  return pretty(result);
}

// ---------------------------------------------------------------------------
// Batch: run many commands in one invocation. Commands are POSTed to the bridge
// concurrently; the bridge queues them and the extension executes them strictly in
// order, so ordering is preserved while saving per-call process startup + roundtrips.
// ---------------------------------------------------------------------------

function readStdin(stream) {
  return new Promise((resolve) => {
    let data = "";
    stream.setEncoding("utf8");
    stream.on("data", (chunk) => (data += chunk));
    stream.on("end", () => resolve(data));
  });
}

async function batchSpecs(commandsJson, stdin) {
  if (commandsJson) {
    const parsed = JSON.parse(commandsJson);
    if (!Array.isArray(parsed)) throw new Error("--commands must be a JSON array of {command, params?, timeoutMs?}");
    return parsed.map((s) => ({ command: String(s.command), params: s.params || {}, timeoutMs: s.timeoutMs }));
  }
  if (stdin.isTTY) throw new Error("batch: no commands given (use --commands '[...]' or pipe JSONL on stdin)");
  const lines = (await readStdin(stdin)).split("\n").map((l) => l.trim()).filter(Boolean);
  if (!lines.length) throw new Error("batch: no commands given (use --commands '[...]' or pipe JSONL on stdin)");
  return lines.map((line) => {
    const s = JSON.parse(line);
    return { command: String(s.command), params: s.params || {}, timeoutMs: s.timeoutMs };
  });
}

async function runBatchItem(spec) {
  const def = COMMANDS[spec.command];
  if (!def) return { command: spec.command, ok: false, error: `Unknown command '${spec.command}'` };
  const params = { ...(def.defaults || {}), ...normalizeBackground(spec.params || {}) };
  if (spec.command === "upload" && typeof params.paths === "string") params.paths = params.paths.split(",").map((p) => p.trim());
  const timeoutMs = spec.timeoutMs || params.timeoutMs || def.timeout || DEFAULT_TIMEOUT_MS;
  try {
    return { command: spec.command, ok: true, result: await runCommand(spec.command, params, timeoutMs) };
  } catch (error) {
    return { command: spec.command, ok: false, error: error.message };
  }
}

function formatBatchResults(results) {
  return results
    .map((r, i) => {
      const head = `[${i + 1}] ${r.command}`;
      if (!r.ok) return `${head}: ERROR: ${r.error}`;
      const text = String(r.result ?? "");
      return text.includes("\n") ? `${head}:\n${text}` : `${head}: ${text}`;
    })
    .join("\n");
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const argv = process.argv.slice(2);
  const command = argv[0];
  if (!command || command === "help" || command === "--help" || command === "-h") {
    process.stdout.write(usage() + "\n");
    return;
  }
  const def = COMMANDS[command];
  if (!def) {
    throw new Error(`Unknown command '${command}'. Run: pi-chrome help`);
  }
  const params = { ...(def.defaults || {}), ...normalizeBackground(parseArgs(argv.slice(1))) };
  if (command === "upload" && typeof params.paths === "string") params.paths = params.paths.split(",").map((p) => p.trim());
  const timeoutMs = params.timeoutMs || def.timeout || DEFAULT_TIMEOUT_MS;
  // Diagnostics still work while disconnected; everything else fails fast.
  if (command !== "status") await ensureConnected();
  if (command === "batch") {
    const specs = await batchSpecs(params.commands, process.stdin);
    const results = await Promise.all(specs.map(runBatchItem));
    process.stdout.write((params.asJson ? JSON.stringify(results, null, 2) : formatBatchResults(results)) + "\n");
    return;
  }
  const result = await runCommand(command, params, timeoutMs);
  process.stdout.write(result + "\n");
}

main().catch((error) => {
  process.stderr.write(`pi-chrome error: ${error.message}\n`);
  process.exit(1);
});
