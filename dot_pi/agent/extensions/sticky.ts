/**
 * pi-sticky-input — Single-file extension.
 *
 * Keeps chat input, status widgets, editor content, and footer controls anchored
 * while session history updates in a bounded viewport above them.
 *
 * Drop this file into ~/.pi/agent/extensions/ (as sticky.ts) for auto-discovery,
 * then run /reload inside pi.
 *
 * Defaults: alternate screen on, mouse scroll on, keyboard scroll on.
 */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Component, TUI } from "@earendil-works/pi-tui";
import { CURSOR_MARKER, matchesKey, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

// ---------------------------------------------------------------------------
// Hardcoded config
// ---------------------------------------------------------------------------

const EXTENSION_ID = "pi-sticky-input";

const CONFIG = {
  enabled: true,
  splitFooterRenderer: true,
  alternateScreen: true,
  alternateScroll: false,
  mouseScroll: true,
  mouseWheelScrollRows: 3,
  keyboardScroll: true,
  keyboardScrollRows: 10,
  minimumHistoryRows: 3,
  historyViewportLineLimit: 200,
};

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// ---------------------------------------------------------------------------
// Terminal session (alternate screen, mouse/keyboard input)
// ---------------------------------------------------------------------------

type StickyTerminalDiagnostic = (event: string, fields: Record<string, unknown>) => void;

interface StickyTerminalSessionOptions {
  alternateScreen: boolean;
  alternateScroll: boolean;
  mouseScroll: boolean;
  diagnostic?: StickyTerminalDiagnostic;
}

type MouseWheelDirection = "up" | "down";

interface ActiveTerminalModes {
  tui: TUI;
  alternateScreen: boolean;
  alternateScroll: boolean;
  mouseScroll: boolean;
}

interface TuiStopPatch { originalStop: TUI["stop"]; }
type TuiWithStopPatch = TUI & { __piStickyInputStopPatch?: TuiStopPatch };

const ENTER_ALTERNATE_SCREEN = "\x1b[?1049h\x1b[H\x1b[2J";
const EXIT_ALTERNATE_SCREEN = "\x1b[?1049l";
const ENABLE_SGR_MOUSE = "\x1b[?1000h\x1b[?1006h";
const DISABLE_SGR_MOUSE = "\x1b[?1006l\x1b[?1000l";
const SGR_MOUSE_RE = /\x1b\[<(\d+);(\d+);(\d+)([mM])/g;
const X10_MOUSE_RE = /\x1b\[M([\s\S])([\s\S])([\s\S])/g;
const PAGE_UP_ANY_MOD_RE = /^\x1b\[5(?:;[2-8])?~$/;
const PAGE_DOWN_ANY_MOD_RE = /^\x1b\[6(?:;[2-8])?~$/;
const MOUSE_MOD_MASK = 4 | 8 | 16;
const WHEEL_UP_BTN = 64;
const WHEEL_DOWN_BTN = 65;

let activeTerminalModes: ActiveTerminalModes | undefined;

function getTerminalWrite(tui: TUI): ((data: string) => void) | undefined {
  const write = tui.terminal?.write;
  return typeof write === "function" ? write.bind(tui.terminal) : undefined;
}

function requireTerminalWrite(tui: TUI, diagnostic?: StickyTerminalDiagnostic): ((data: string) => void) | undefined {
  const write = getTerminalWrite(tui);
  if (!write) diagnostic?.("terminal_modes_skipped", { reason: "missing-terminal-write" });
  return write;
}

function applyTerminalModes(
  tui: TUI, event: string, diagnostic: StickyTerminalDiagnostic | undefined,
  modes: Omit<ActiveTerminalModes, "tui">,
): void {
  activeTerminalModes = { tui, ...modes };
  diagnostic?.(event, { alternateScreen: modes.alternateScreen, alternateScroll: modes.alternateScroll, mouseScroll: modes.mouseScroll });
  tui.requestRender(true);
}

function getEffectiveModes(opts: StickyTerminalSessionOptions): Omit<ActiveTerminalModes, "tui"> {
  return {
    alternateScreen: opts.alternateScreen,
    alternateScroll: opts.alternateScreen && opts.alternateScroll && !opts.mouseScroll,
    mouseScroll: opts.mouseScroll,
  };
}

function sameActiveModes(tui: TUI, opts: StickyTerminalSessionOptions): boolean {
  const m = getEffectiveModes(opts);
  return (
    activeTerminalModes?.tui === tui &&
    activeTerminalModes.alternateScreen === m.alternateScreen &&
    activeTerminalModes.alternateScroll === m.alternateScroll &&
    activeTerminalModes.mouseScroll === m.mouseScroll
  );
}

function installStopPatch(tui: TUI): void {
  const pt = tui as TuiWithStopPatch;
  if (pt.__piStickyInputStopPatch || typeof pt.stop !== "function") return;
  const originalStop = pt.stop;
  pt.__piStickyInputStopPatch = { originalStop };
  pt.stop = function piStickyInputStopPatch(this: TUI): void {
    try { originalStop.call(this); } finally { deactivateStickyTerminalSession(); }
  };
}

function restoreStopPatch(tui: TUI): void {
  const pt = tui as TuiWithStopPatch;
  const patch = pt.__piStickyInputStopPatch;
  if (!patch) return;
  pt.stop = patch.originalStop;
  delete pt.__piStickyInputStopPatch;
}

function activateStickyTerminalSession(tui: TUI, options: StickyTerminalSessionOptions): void {
  if (sameActiveModes(tui, options)) return;
  const eff = getEffectiveModes(options);
  const am = activeTerminalModes;
  if (am?.tui === tui && am.alternateScreen && eff.alternateScreen) {
    const write = requireTerminalWrite(tui, options.diagnostic);
    if (!write) return;
    // Only mouse transitions matter for alternate-screen updates
    let seq = "";
    if (am.mouseScroll && !eff.mouseScroll) seq += DISABLE_SGR_MOUSE;
    if (!am.mouseScroll && eff.mouseScroll) seq += ENABLE_SGR_MOUSE;
    if (seq.length > 0) write(seq);
    applyTerminalModes(tui, "terminal_modes_updated", options.diagnostic, eff);
    return;
  }
  deactivateStickyTerminalSession();
  const write = requireTerminalWrite(tui, options.diagnostic);
  if (!write) return;
  let seq = "";
  if (eff.alternateScreen) seq += ENTER_ALTERNATE_SCREEN;
  if (eff.mouseScroll) seq += ENABLE_SGR_MOUSE;
  if (seq.length > 0) write(seq);
  installStopPatch(tui);
  applyTerminalModes(tui, "terminal_modes_activated", options.diagnostic, eff);
}

function deactivateStickyTerminalSession(diagnostic?: StickyTerminalDiagnostic): void {
  if (!activeTerminalModes) return;
  const { tui, alternateScreen, mouseScroll } = activeTerminalModes;
  activeTerminalModes = undefined;
  restoreStopPatch(tui);
  const write = getTerminalWrite(tui);
  if (!write) { diagnostic?.("terminal_modes_deactivate_skipped", { reason: "missing-terminal-write" }); return; }
  let seq = "";
  if (mouseScroll) seq += DISABLE_SGR_MOUSE;
  if (alternateScreen) seq += EXIT_ALTERNATE_SCREEN;
  if (seq.length > 0) write(seq);
  diagnostic?.("terminal_modes_deactivated", { alternateScreen, mouseScroll });
}

function getActiveStickyTerminalTui(): TUI | undefined { return activeTerminalModes?.tui; }

function hasVisibleOverlay(tui: unknown): boolean {
  if (!isRecord(tui)) return false;
  const ho = (tui as Record<string, unknown>).hasOverlay;
  if (typeof ho === "function") return ho.call(tui) === true;
  return Array.isArray((tui as { overlayStack?: unknown }).overlayStack) && ((tui as { overlayStack?: unknown[] }).overlayStack!).length > 0;
}

function isEditorLikeFocus(component: unknown): boolean {
  if (!isRecord(component)) return false;
  const ctorName = isRecord(component.constructor) && typeof component.constructor.name === "string" ? component.constructor.name : undefined;
  if (ctorName === "Editor" || ctorName === "CustomEditor") return true;
  return (
    typeof (component as Record<string, unknown>).getText === "function" &&
    typeof (component as Record<string, unknown>).setText === "function" &&
    typeof (component as Record<string, unknown>).handleInput === "function" &&
    "onSubmit" in component
  );
}

function shouldHandleStickyTerminalInput(tui: unknown): boolean {
  if (hasVisibleOverlay(tui)) return false;
  if (!isRecord(tui)) return true;
  const fc = (tui as Record<string, unknown>).focusedComponent;
  if (fc === undefined || fc === null) return true;
  return isEditorLikeFocus(fc);
}

function getMouseWheelDirection(rawButton: number): MouseWheelDirection | undefined {
  const btn = rawButton & ~MOUSE_MOD_MASK;
  if (btn === WHEEL_UP_BTN) return "up";
  if (btn === WHEEL_DOWN_BTN) return "down";
  return undefined;
}

function getKeyboardScrollRows(data: string, pageRows: number, options?: { allowPlainHomeEnd?: boolean }): number | undefined {
  const rows = Math.max(1, Math.floor(pageRows));
  if (matchesKey(data, "pageUp") || PAGE_UP_ANY_MOD_RE.test(data)) return -rows;
  if (matchesKey(data, "pageDown") || PAGE_DOWN_ANY_MOD_RE.test(data)) return rows;
  if (matchesKey(data, "ctrl+home") || (options?.allowPlainHomeEnd && matchesKey(data, "home"))) return -Number.MAX_SAFE_INTEGER;
  if (matchesKey(data, "ctrl+end") || (options?.allowPlainHomeEnd && matchesKey(data, "end"))) return Number.MAX_SAFE_INTEGER;
  return undefined;
}

function parseMouseWheelInput(data: string): MouseWheelDirection | undefined {
  SGR_MOUSE_RE.lastIndex = 0;
  X10_MOUSE_RE.lastIndex = 0;
  let dir: MouseWheelDirection | undefined;
  for (const m of data.matchAll(SGR_MOUSE_RE)) {
    const btn = Number.parseInt(m[1] ?? "", 10);
    if (Number.isFinite(btn)) dir = getMouseWheelDirection(btn) ?? dir;
  }
  for (const m of data.matchAll(X10_MOUSE_RE)) {
    const byte = m[1]?.charCodeAt(0);
    if (byte !== undefined) dir = getMouseWheelDirection(byte - 32) ?? dir;
  }
  return dir;
}

function isMouseInput(data: string): boolean {
  SGR_MOUSE_RE.lastIndex = 0;
  X10_MOUSE_RE.lastIndex = 0;
  return SGR_MOUSE_RE.test(data) || X10_MOUSE_RE.test(data);
}

// ---------------------------------------------------------------------------
// Split-footer renderer
// ---------------------------------------------------------------------------

type StickySplitFooterDiagnostic = (event: string, fields: Record<string, unknown>) => void;

interface StickySplitFooterRendererOptions {
  enabled: boolean;
  minimumHistoryRows: number;
  historyViewportLineLimit: number;
}

interface StickySplitFooterPatchStatus { installed: boolean; active: boolean; reason: string; }

interface CursorPosition { row: number; col: number; }

interface TuiInternals {
  children: Component[];
  terminal: { write: (data: string) => void; columns: number; rows: number };
  previousLines: string[];
  previousWidth: number;
  previousHeight: number;
  cursorRow: number;
  hardwareCursorRow: number;
  clearOnShrink: boolean;
  maxLinesRendered: number;
  previousViewportTop: number;
  fullRedrawCount: number;
  stopped: boolean;
  overlayStack: unknown[];
  hasOverlay?: () => boolean;
  extractCursorPosition?: (lines: string[], height: number) => CursorPosition | null;
  applyLineResets?: (lines: string[]) => string[];
  positionHardwareCursor?: (cursorPos: CursorPosition | null, totalLines: number) => void;
}

type DoRender = (this: TUI) => void;

interface PatchedProto {
  doRender?: DoRender;
  __piStickyInputOriginalDoRender?: DoRender;
  __piStickyInputPatched?: boolean;
}

interface ChildRange { start: number; end: number; }
interface RenderedChildren { lines: string[]; ranges: ChildRange[]; }

interface SplitLayout {
  lines: string[];
  footerStartLine: number;
  stickyRows: number;
  historyRows: number;
  historyViewportTop: number;
  screenLines: string[];
}

interface ViewportMetadata {
  footerStartLine: number;
  stickyRows: number;
  historyRows: number;
  historyViewportTop: number;
  logicalLineCount: number;
}

interface HistoryViewportState { viewportTop: number; followBottom: boolean; }
interface LineSpan { start: number; endExclusive: number; }

interface StickySplitFooterScrollResult { handled: boolean; changed: boolean; viewportTop?: number; followBottom?: boolean; }
interface UnsupportedLayout { reason: string; fields?: Record<string, unknown>; }

const DEFAULT_SPLIT_OPTIONS: StickySplitFooterRendererOptions = { enabled: false, minimumHistoryRows: 3, historyViewportLineLimit: 200 };
const STICKY_PANE_CHILD_COUNT = 5;
const SIXEL_ROW_MARKER = "\x1b_Gm=0;\x1b\\";
const INLINE_IMAGE_MARKERS = [SIXEL_ROW_MARKER, "\x1b_G", "\x1b]1337;File=", "\x1bP"] as const;
const CURSOR_UP_ROWS_RE = /\x1b\[(\d+)A/g;

let splitOptions: StickySplitFooterRendererOptions = { ...DEFAULT_SPLIT_OPTIONS };
let patchInstalled = false;
let lastPatchReason = "not-installed";

const viewportMetaMap = new WeakMap<object, ViewportMetadata>();
const viewportStateMap = new WeakMap<object, HistoryViewportState>();

function clamp(v: number, lo: number, hi: number): number { return Math.max(lo, Math.min(v, hi)); }
function getInternals(tui: TUI): TuiInternals { return tui as unknown as TuiInternals; }

function hasRequiredInternals(tui: TuiInternals): boolean {
  return (
    Array.isArray(tui.children) && Array.isArray(tui.previousLines) && Array.isArray(tui.overlayStack) &&
    typeof tui.extractCursorPosition === "function" && typeof tui.applyLineResets === "function" &&
    typeof tui.positionHardwareCursor === "function" && typeof tui.terminal?.write === "function" &&
    typeof tui.terminal.columns === "number" && typeof tui.terminal.rows === "number"
  );
}

function getVisibleOverlayState(tui: TuiInternals): boolean {
  if (typeof tui.hasOverlay === "function") return tui.hasOverlay();
  return Array.isArray(tui.overlayStack) && tui.overlayStack.length > 0;
}

function getUnsupportedTerminalReason(tui: TuiInternals): UnsupportedLayout | undefined {
  const w = tui.terminal.columns;
  const h = tui.terminal.rows;
  if (!Number.isFinite(w) || !Number.isFinite(h)) return { reason: "invalid-terminal-dimensions", fields: { width: w, height: h } };
  if (w < 20 || h < 8) return { reason: "terminal-too-small", fields: { width: w, height: h } };
  if (process.env.TERM === "dumb") return { reason: "dumb-terminal" };
  if (process.env.PI_STICKY_INPUT_DISABLE_SPLIT_FOOTER === "1") return { reason: "disabled-by-environment" };
  return undefined;
}

function findStickyPaneStart(tui: TuiInternals): number {
  return tui.children.length >= STICKY_PANE_CHILD_COUNT ? tui.children.length - STICKY_PANE_CHILD_COUNT : -1;
}

function isPlainContainer(c: Component): c is Component & { children: Component[] } {
  return c.constructor?.name === "Container" && Array.isArray((c as { children?: unknown }).children);
}

function renderComponent(c: Component, width: number): string[] {
  if (!isPlainContainer(c)) return c.render(width);
  const lines: string[] = [];
  for (const child of c.children) lines.push(...renderComponent(child, width));
  return lines;
}

function renderChildren(tui: TuiInternals, width: number): RenderedChildren {
  const ranges: ChildRange[] = [];
  const lines: string[] = [];
  for (const child of tui.children) {
    const start = lines.length;
    lines.push(...renderComponent(child, width));
    ranges.push({ start, end: lines.length });
  }
  return { lines, ranges };
}

function getRetainedHistoryBounds(historyLineCount: number, historyRows: number) {
  const maxVpTop = Math.max(0, historyLineCount - historyRows);
  const minVpTop = splitOptions.historyViewportLineLimit < DEFAULT_SPLIT_OPTIONS.historyViewportLineLimit
    ? Math.max(0, historyLineCount - splitOptions.historyViewportLineLimit - historyRows)
    : 0;
  return { minimumViewportTop: minVpTop, maximumViewportTop: maxVpTop };
}

function getHistoryViewportTop(tui: object, historyLineCount: number, historyRows: number) {
  const { minimumViewportTop, maximumViewportTop } = getRetainedHistoryBounds(historyLineCount, historyRows);
  const state = viewportStateMap.get(tui);
  if (!state || state.followBottom) {
    const ns = { viewportTop: maximumViewportTop, followBottom: true };
    viewportStateMap.set(tui, ns);
    return ns;
  }
  const vpT = clamp(state.viewportTop, minimumViewportTop, maximumViewportTop);
  const fb = vpT >= maximumViewportTop;
  const ns = { viewportTop: vpT, followBottom: fb };
  viewportStateMap.set(tui, ns);
  return ns;
}

function isInlineImageLine(line: string): boolean { return INLINE_IMAGE_MARKERS.some((m) => line.includes(m)); }

function getInlineImageMoveUpRows(line: string): number {
  if (!isInlineImageLine(line)) return 0;
  let rows = 0;
  for (const m of line.matchAll(CURSOR_UP_ROWS_RE)) rows = Math.max(rows, Number.parseInt(m[1] ?? "0", 10));
  return rows;
}

function countPrecedingBlankSpacerRows(lines: readonly string[], row: number, limit: number): number {
  let spacerRows = 0;
  while (spacerRows < limit) {
    const cr = row - spacerRows - 1;
    if (cr < 0 || (lines[cr] ?? "") !== "") break;
    spacerRows += 1;
  }
  return spacerRows;
}

function getInlineImageSpanEndingAt(lines: readonly string[], row: number): LineSpan | undefined {
  const line = lines[row] ?? "";
  if (!isInlineImageLine(line)) return undefined;
  const spacerRows = countPrecedingBlankSpacerRows(lines, row, getInlineImageMoveUpRows(line));
  return { start: row - spacerRows, endExclusive: row + 1 };
}

function collectInlineImageSpans(lines: readonly string[]): LineSpan[] {
  const spans: LineSpan[] = [];
  for (let r = 0; r < lines.length; r++) {
    const span = getInlineImageSpanEndingAt(lines, r);
    if (span) spans.push(span);
  }
  return spans;
}

function findContainingLineSpan(spans: readonly LineSpan[], row: number): LineSpan | undefined {
  return spans.find((s) => s.start <= row && row < s.endExclusive);
}

function lineSpanContentMatches(prev: readonly string[], prevSpan: LineSpan, next: readonly string[], nextSpan: LineSpan): boolean {
  const pr = prevSpan.endExclusive - prevSpan.start;
  const nr = nextSpan.endExclusive - nextSpan.start;
  if (pr !== nr) return false;
  for (let o = 0; o < pr; o++) {
    if ((prev[prevSpan.start + o] ?? "") !== (next[nextSpan.start + o] ?? "")) return false;
  }
  return true;
}

function alignViewportTopToInlineImages(
  historyLines: readonly string[], viewportTop: number, historyRows: number,
): { viewportTop: number; unsupportedSpan?: LineSpan } {
  const maxVp = Math.max(0, historyLines.length - historyRows);
  let vp = clamp(viewportTop, 0, maxVp);
  const spans = collectInlineImageSpans(historyLines);
  for (let it = 0; it <= spans.length; it++) {
    const vpBottom = vp + historyRows;
    const oversizedSpan = spans.find((s) => s.endExclusive - s.start > historyRows && s.start < vpBottom && vp < s.endExclusive);
    if (oversizedSpan) return { viewportTop: vp, unsupportedSpan: oversizedSpan };
    const leadingSpan = spans.find((s) => s.start < vp && vp < s.endExclusive);
    if (leadingSpan) { vp = leadingSpan.start; continue; }
    const trailingSpan = spans.find((s) => s.start < vpBottom && vpBottom < s.endExclusive);
    if (trailingSpan) { vp = clamp(trailingSpan.endExclusive - historyRows, 0, maxVp); continue; }
    break;
  }
  return { viewportTop: vp };
}

function createScreenLines(
  tui: object, historyLines: readonly string[], stickyLines: readonly string[], historyRows: number,
): { screenLines: string[]; historyViewportTop: number } | UnsupportedLayout {
  const { viewportTop, followBottom } = getHistoryViewportTop(tui, historyLines.length, historyRows);
  const aligned = alignViewportTopToInlineImages(historyLines, viewportTop, historyRows);
  if (aligned.unsupportedSpan) {
    return {
      reason: "history-inline-image-span-too-tall",
      fields: { historyRows, viewportTop, spanStart: aligned.unsupportedSpan.start, spanEndExclusive: aligned.unsupportedSpan.endExclusive, spanRows: aligned.unsupportedSpan.endExclusive - aligned.unsupportedSpan.start },
    };
  }
  const hvpt = aligned.viewportTop;
  const { maximumViewportTop } = getRetainedHistoryBounds(historyLines.length, historyRows);
  viewportStateMap.set(tui, { viewportTop: hvpt, followBottom: followBottom || hvpt >= maximumViewportTop });
  const visible = historyLines.slice(hvpt, hvpt + historyRows);
  const screenLines = [...visible];
  while (screenLines.length < historyRows) screenLines.push("");
  screenLines.push(...stickyLines);
  return { screenLines, historyViewportTop: hvpt };
}

function normalizeVisibleLine(line: string, width: number): string {
  if (isInlineImageLine(line)) return line;
  return visibleWidth(line) > width ? truncateToWidth(line, width, "") : line;
}
function normalizeVisibleLines(lines: readonly string[], width: number): string[] { return lines.map((l) => normalizeVisibleLine(l, width)); }

function buildSplitLayout(tui: TuiInternals, width: number, height: number): SplitLayout | UnsupportedLayout {
  const fi = findStickyPaneStart(tui);
  if (fi < 0) return { reason: "unknown-layout", fields: { childCount: tui.children.length, expectedStickyPaneChildCount: STICKY_PANE_CHILD_COUNT } };
  const rendered = renderChildren(tui, width);
  const fs = rendered.ranges[fi]?.start;
  if (fs === undefined) return { reason: "missing-footer-start-range", fields: { footerStartIndex: fi } };
  const stickyRows = rendered.lines.length - fs;
  if (stickyRows <= 0) return { reason: "empty-sticky-pane", fields: { footerStartIndex: fi, footerStartLine: fs } };
  if (stickyRows >= height) return { reason: "sticky-pane-too-tall", fields: { stickyRows, height } };
  const historyRows = height - stickyRows;
  if (historyRows < splitOptions.minimumHistoryRows)
    return { reason: "history-pane-too-small", fields: { historyRows, stickyRows, height, minimumHistoryRows: splitOptions.minimumHistoryRows } };
  const historyLines = rendered.lines.slice(0, fs);
  const stickyLines = rendered.lines.slice(fs);
  const screen = createScreenLines(tui, historyLines, stickyLines, historyRows);
  if (isUnsupportedLayout(screen)) return screen;
  return { lines: rendered.lines, footerStartLine: fs, stickyRows, historyRows, historyViewportTop: screen.historyViewportTop, screenLines: screen.screenLines };
}

function isUnsupportedLayout(layout: object): layout is UnsupportedLayout {
  return "reason" in layout && typeof (layout as { reason?: unknown }).reason === "string";
}

function extractCursorPosition(lines: string[], height: number): CursorPosition | null {
  const vpTop = Math.max(0, lines.length - height);
  for (let r = lines.length - 1; r >= vpTop; r--) {
    const line = lines[r] ?? "";
    const idx = line.indexOf(CURSOR_MARKER);
    if (idx === -1) continue;
    const col = visibleWidth(line.slice(0, idx));
    lines[r] = line.slice(0, idx) + line.slice(idx + CURSOR_MARKER.length);
    return { row: r, col };
  }
  return null;
}

const BEGIN_SYNC = "\x1b[?2026h";
const END_SYNC = "\x1b[?2026l";
const CLEAR_VIEWPORT = "\x1b[H\x1b[2J";
const CLEAR_LINE = "\x1b[2K";
const CLEAR_TO_END = "\x1b[K";
function moveTo(row: number, col: number): string { return `\x1b[${row};${col}H`; }
function clearToLineEndIfNeeded(line: string, width: number): string {
  if (isInlineImageLine(line)) return "";
  return visibleWidth(line) < width ? CLEAR_TO_END : "";
}

function rememberMetadata(tui: object, layout: SplitLayout): void {
  viewportMetaMap.set(tui, {
    footerStartLine: layout.footerStartLine, stickyRows: layout.stickyRows,
    historyRows: layout.historyRows, historyViewportTop: layout.historyViewportTop,
    logicalLineCount: layout.lines.length,
  });
}

function updateRenderState(tui: TuiInternals, screenLines: string[], width: number, height: number, hwRow?: number): void {
  tui.cursorRow = Math.max(0, screenLines.length - 1);
  if (hwRow !== undefined) tui.hardwareCursorRow = clamp(hwRow, 0, Math.max(0, screenLines.length - 1));
  tui.maxLinesRendered = Math.max(tui.maxLinesRendered, screenLines.length);
  tui.previousViewportTop = 0;
  tui.previousLines = screenLines;
  tui.previousWidth = width;
  tui.previousHeight = height;
}

function collectInlineImageSpanSets(prev: readonly string[], screen: readonly string[]) {
  const ps = collectInlineImageSpans(prev);
  const ns = collectInlineImageSpans(screen);
  return { previousSpans: ps, nextSpans: ns, bothEmpty: ps.length === 0 && ns.length === 0 };
}

function expandRowsForInlineImages(prev: readonly string[], screen: readonly string[], rows: readonly number[]): number[] {
  if (rows.length === 0) return [];
  const { previousSpans, nextSpans, bothEmpty } = collectInlineImageSpanSets(prev, screen);
  if (bothEmpty) return [...rows];
  const expanded = new Set(rows);
  for (const r of rows) {
    for (const spans of [previousSpans, nextSpans]) {
      const span = findContainingLineSpan(spans, r);
      if (!span) continue;
      for (let sr = span.start; sr < span.endExclusive; sr++) expanded.add(sr);
    }
  }
  return [...expanded].sort((a, b) => a - b);
}

function getRowsToRender(prev: readonly string[], screen: readonly string[], force: boolean): number[] {
  if (force) return screen.map((_, i) => i);
  const rows: number[] = [];
  const n = Math.max(prev.length, screen.length);
  for (let r = 0; r < n; r++) { if ((prev[r] ?? "") !== (screen[r] ?? "")) rows.push(r); }
  return expandRowsForInlineImages(prev, screen, rows);
}

function renderBoundedViewport(tui: TuiInternals, layout: SplitLayout, cursorPos: CursorPosition | null, width: number, height: number, clear: boolean): void {
  tui.fullRedrawCount += clear ? 1 : 0;
  const rowsToRender = getRowsToRender(tui.previousLines, layout.screenLines, clear);
  let hwRow = tui.hardwareCursorRow;
  if (rowsToRender.length > 0) {
    let buf = BEGIN_SYNC;
    if (clear) buf += `\x1b[r${CLEAR_VIEWPORT}`;
    for (const sr of rowsToRender) {
      const line = layout.screenLines[sr] ?? "";
      buf += clear
        ? `${moveTo(sr + 1, 1)}${CLEAR_LINE}${line}`
        : `${moveTo(sr + 1, 1)}${line}${clearToLineEndIfNeeded(line, width)}`;
      hwRow = sr;
    }
    buf += END_SYNC;
    tui.terminal.write(buf);
  }
  updateRenderState(tui, layout.screenLines, width, height, hwRow);
  tui.positionHardwareCursor?.(cursorPos, layout.screenLines.length);
  rememberMetadata(tui, layout);
}

function forceOriginalRenderer(tui: TuiInternals, origRender: DoRender, self: TUI, reason: string, fields: Record<string, unknown> = {}): void {
  const leaving = viewportMetaMap.has(self);
  viewportMetaMap.delete(self);
  if (leaving) {
    tui.previousLines = []; tui.previousWidth = -1; tui.previousHeight = -1;
    tui.cursorRow = 0; tui.hardwareCursorRow = 0; tui.previousViewportTop = 0;
  }
  origRender.call(self);
}

function handOffToOriginalRenderer(tui: TuiInternals, origRender: DoRender, self: TUI): void {
  if (viewportMetaMap.has(self)) { forceOriginalRenderer(tui, origRender, self, "sticky-renderer-disabled"); return; }
  origRender.call(self);
}

function shouldForceFullClearForInlineImages(prev: readonly string[], screen: readonly string[]): boolean {
  const { previousSpans, nextSpans, bothEmpty } = collectInlineImageSpanSets(prev, screen);
  if (bothEmpty) return false;
  if (previousSpans.length !== nextSpans.length) return true;
  return previousSpans.some((span, idx) => {
    const ns = nextSpans[idx];
    return !ns || span.start !== ns.start || span.endExclusive !== ns.endExclusive || !lineSpanContentMatches(prev, span, screen, ns);
  });
}

function shouldClearViewport(tui: TuiInternals, width: number, height: number, screen: readonly string[]): boolean {
  return (
    tui.previousLines.length === 0 || tui.previousWidth !== width || tui.previousHeight !== height ||
    !viewportMetaMap.has(tui as unknown as object) || shouldForceFullClearForInlineImages(tui.previousLines, screen)
  );
}

function patchedDoRender(this: TUI): void {
  const tui = getInternals(this);
  const proto = Object.getPrototypeOf(this) as PatchedProto | null;
  const origRender = proto?.__piStickyInputOriginalDoRender;
  if (!origRender) return;
  if (!splitOptions.enabled || tui.stopped) { handOffToOriginalRenderer(tui, origRender, this); return; }
  if (!hasRequiredInternals(tui)) {
    forceOriginalRenderer(tui, origRender, this, "missing-required-tui-internals");
    return;
  }
  const unsupported = getUnsupportedTerminalReason(tui);
  if (unsupported) { forceOriginalRenderer(tui, origRender, this, unsupported.reason, unsupported.fields); return; }
  if (getVisibleOverlayState(tui)) { forceOriginalRenderer(tui, origRender, this, "visible-overlay"); return; }
  const width = tui.terminal.columns;
  const height = tui.terminal.rows;
  const layout = buildSplitLayout(tui, width, height);
  if (isUnsupportedLayout(layout)) { forceOriginalRenderer(tui, origRender, this, layout.reason, layout.fields); return; }
  const cursorPos = extractCursorPosition(layout.screenLines, height);
  const applied = tui.applyLineResets?.(layout.screenLines) ?? layout.screenLines;
  const al: SplitLayout = { ...layout, screenLines: normalizeVisibleLines(applied, width) };
  renderBoundedViewport(tui, al, cursorPos, width, height, shouldClearViewport(tui, width, height, al.screenLines));
}

function configureSplitFooterRenderer(next: StickySplitFooterRendererOptions): void {
  splitOptions = {
    enabled: next.enabled,
    minimumHistoryRows: Math.max(1, Math.floor(next.minimumHistoryRows)),
    historyViewportLineLimit: Math.max(Math.max(1, Math.floor(next.minimumHistoryRows)), Math.floor(next.historyViewportLineLimit)),
  };
}

function resolveRuntimeTuiProto(runtimeTui?: TUI): PatchedProto | undefined {
  if (!runtimeTui || typeof runtimeTui !== "object") return undefined;
  const proto = Object.getPrototypeOf(runtimeTui) as PatchedProto | null;
  if (!proto || typeof proto !== "object") return undefined;
  return proto;
}

function applySplitFooterRendererPatch(nextOptions: StickySplitFooterRendererOptions, runtimeTui?: TUI): StickySplitFooterPatchStatus {
  configureSplitFooterRenderer(nextOptions);
  const proto = resolveRuntimeTuiProto(runtimeTui);
  if (!proto) { lastPatchReason = "awaiting-runtime-tui-instance"; return { installed: patchInstalled, active: patchInstalled && splitOptions.enabled, reason: lastPatchReason }; }
  if (proto.__piStickyInputPatched) {
    if (typeof proto.__piStickyInputOriginalDoRender !== "function") { patchInstalled = false; lastPatchReason = "missing-original-doRender"; return { installed: false, active: false, reason: lastPatchReason }; }
    proto.doRender = patchedDoRender;
    patchInstalled = true; lastPatchReason = "already-installed";
    return { installed: true, active: splitOptions.enabled, reason: lastPatchReason };
  }
  if (typeof proto.doRender !== "function") { patchInstalled = false; lastPatchReason = "missing-runtime-TUI.prototype.doRender"; return { installed: false, active: false, reason: lastPatchReason }; }
  proto.__piStickyInputOriginalDoRender = proto.doRender;
  proto.doRender = patchedDoRender;
  proto.__piStickyInputPatched = true;
  patchInstalled = true; lastPatchReason = "installed";
  return { installed: true, active: splitOptions.enabled, reason: lastPatchReason };
}

function getCurrentViewportTop(tui: object, historyLineCount: number, historyRows: number) {
  const { minimumViewportTop, maximumViewportTop } = getRetainedHistoryBounds(historyLineCount, historyRows);
  const st = viewportStateMap.get(tui);
  const cur = st?.followBottom === false ? st.viewportTop : maximumViewportTop;
  return { currentViewportTop: cur, minimumViewportTop, maximumViewportTop };
}

function updateViewportTop(rtui: TUI, tui: object, _cur: number, vpT: number, maxVpT: number): StickySplitFooterScrollResult {
  const st = viewportStateMap.get(tui);
  const fb = vpT >= maxVpT;
  const changed = vpT !== _cur || st?.followBottom !== fb;
  viewportStateMap.set(tui, { viewportTop: vpT, followBottom: fb });
  if (changed) rtui.requestRender();
  return { handled: true, changed, viewportTop: vpT, followBottom: fb };
}

function scrollSplitFooterViewport(rtui: TUI | undefined, deltaRows: number): StickySplitFooterScrollResult {
  if (!rtui || !Number.isFinite(deltaRows) || deltaRows === 0) return { handled: false, changed: false };
  const tui = rtui as unknown as object;
  const meta = viewportMetaMap.get(tui);
  if (!meta) return { handled: false, changed: false };
  const { currentViewportTop, minimumViewportTop, maximumViewportTop } = getCurrentViewportTop(tui, meta.footerStartLine, meta.historyRows);
  const vpT = clamp(currentViewportTop + Math.trunc(deltaRows), minimumViewportTop, maximumViewportTop);
  return updateViewportTop(rtui, tui, currentViewportTop, vpT, maximumViewportTop);
}

function resetSplitFooterViewport(rtui?: TUI): void {
  if (!rtui) return;
  viewportStateMap.delete(rtui as unknown as object);
  viewportMetaMap.delete(rtui as unknown as object);
}

// ---------------------------------------------------------------------------
// Extension entry point
// ---------------------------------------------------------------------------

const RUNTIME_PATCH_WIDGET_KEY = `${EXTENSION_ID}:runtime-renderer-hook`;

class StickyRendererHookComponent implements Component {
  render(_width: number): string[] { return []; }
  invalidate(): void {}
}
const STICKY_HOOK_COMP = new StickyRendererHookComponent();

function createRendererOpts(): StickySplitFooterRendererOptions {
  return { enabled: CONFIG.enabled && CONFIG.splitFooterRenderer, minimumHistoryRows: CONFIG.minimumHistoryRows, historyViewportLineLimit: CONFIG.historyViewportLineLimit };
}

function createTerminalSessionOpts(): StickyTerminalSessionOptions {
  return { alternateScreen: CONFIG.alternateScreen, alternateScroll: CONFIG.alternateScroll, mouseScroll: CONFIG.mouseScroll };
}

function isEditorTextEmpty(getEditorText: (() => string) | undefined): boolean {
  if (!getEditorText) return true;
  try { return getEditorText().length === 0; } catch { return true; }
}

function scrollAndLog(tui: TUI | undefined, direction: MouseWheelDirection, rows: number, _event: string): void {
  const delta = direction === "up" ? -rows : rows;
  scrollSplitFooterViewport(tui, delta);
}

function handleTerminalInput(data: string, getEditorText?: () => string): { consume?: boolean; data?: string } | undefined {
  const tui = getActiveStickyTerminalTui();
  if (!shouldHandleStickyTerminalInput(tui)) return undefined;
  const editorEmpty = isEditorTextEmpty(getEditorText);

  if (CONFIG.mouseScroll && isMouseInput(data)) {
    const direction = parseMouseWheelInput(data);
    if (direction) scrollAndLog(tui, direction, CONFIG.mouseWheelScrollRows, "terminal_mouse_scroll");
    return { consume: true };
  }
  if (CONFIG.keyboardScroll) {
    const kbs = getKeyboardScrollRows(data, CONFIG.keyboardScrollRows, { allowPlainHomeEnd: editorEmpty });
    if (kbs !== undefined) {
      const result = scrollSplitFooterViewport(tui, kbs);
      if (result.handled) return { consume: true };
    }
  }
  return undefined;
}

async function installSplitFooterRendererHook(ctx: ExtensionContext): Promise<void> {
  if (!ctx.hasUI) return;
  const rendererOpts = createRendererOpts();
  if (!rendererOpts.enabled) {
    configureSplitFooterRenderer(rendererOpts);
    resetSplitFooterViewport(getActiveStickyTerminalTui());
    deactivateStickyTerminalSession();
    ctx.ui.setWidget(RUNTIME_PATCH_WIDGET_KEY, undefined);
    return;
  }
  const patchedTuis = new WeakSet<object>();
  ctx.ui.setWidget(RUNTIME_PATCH_WIDGET_KEY, (tui: TUI) => {
    if (patchedTuis.has(tui as unknown as object)) return STICKY_HOOK_COMP;
    patchedTuis.add(tui as unknown as object);
    applySplitFooterRendererPatch(rendererOpts, tui);
    activateStickyTerminalSession(tui, createTerminalSessionOpts());
    return STICKY_HOOK_COMP;
  }, { placement: "belowEditor" });
}

export default function stickyInputExtension(pi: ExtensionAPI): void {
  if (!CONFIG.enabled) return;

  let unsubscribeTerminalInput: (() => void) | undefined;
  let terminalInputListenerGen = 0;

  function clearTerminalInputListener(): void {
    terminalInputListenerGen += 1;
    unsubscribeTerminalInput?.();
    unsubscribeTerminalInput = undefined;
  }

  async function installTerminalInputListener(ctx: ExtensionContext): Promise<void> {
    clearTerminalInputListener();
    if (!ctx.hasUI) return;
    const gen = terminalInputListenerGen;
    await Promise.resolve();
    if (gen !== terminalInputListenerGen) return;
    unsubscribeTerminalInput = ctx.ui.onTerminalInput((data) => handleTerminalInput(data, () => ctx.ui.getEditorText()));
  }

  pi.on("resources_discover", async (event, ctx) => {
    if (event.reason !== "reload") return;
    await installSplitFooterRendererHook(ctx);
    await installTerminalInputListener(ctx);
  });

  pi.on("session_start", async (_event, ctx) => {
    await installSplitFooterRendererHook(ctx);
    await installTerminalInputListener(ctx);
  });

  pi.on("session_shutdown", (event) => {
    clearTerminalInputListener();
    resetSplitFooterViewport(getActiveStickyTerminalTui());
    if (event.reason === "quit") return;
    deactivateStickyTerminalSession();
  });
}
