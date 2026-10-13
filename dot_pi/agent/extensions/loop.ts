import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const THINKING_WINDOW = 80;
const MAX_WINDOW = 4000;
const STRIDE = 50;
const PARA_MIN_LEN = 40;
const FINGERPRINT_LEN = 60;
const SEMANTIC_THRESHOLD = 3;

const MESSAGE = "Thinking Loop";
const TRIM_MARKER = "Thinking loop trimmed";

type SemanticState = { counts: Map<string, number>; scanned: number; inFence: boolean };

function newSemanticState(): SemanticState {
  return { counts: new Map(), scanned: 0, inFence: false };
}

export default function (pi: ExtensionAPI) {
  let lastLen = 0;
  let lastIndex: number | null = null;
  let sem = newSemanticState();
  let stopped = false;

  function stop(ctx: ExtensionContext) {
    if (stopped) return;
    stopped = true;
    ctx.ui.notify(MESSAGE, "warning");
    ctx.abort();
  }

  function resetStream() {
    lastLen = 0;
    lastIndex = null;
    sem = newSemanticState();
  }

  function isLooping(thinking: string): boolean {
    return (
      detectRepeatingSuffix(thinking, THINKING_WINDOW) ||
      detectSemanticLoop(thinking, newSemanticState())
    );
  }

  pi.on("agent_start", () => {
    resetStream();
    stopped = false;
  });

  pi.on("turn_start", resetStream);

  pi.on("message_update", (event, ctx) => {
    if (event.message.role !== "assistant") return;
    const contentIndex =
      "contentIndex" in event.assistantMessageEvent
        ? event.assistantMessageEvent.contentIndex
        : null;
    const thinking = extractThinkingAt(event.message, contentIndex);
    if (!thinking) return;

    if (contentIndex !== lastIndex) {
      lastIndex = contentIndex;
      lastLen = 0;
      sem = newSemanticState();
    }
    if (thinking.length < lastLen) {
      lastLen = 0;
      sem = newSemanticState();
    }
    if (thinking.length < lastLen + STRIDE) return;

    lastLen = thinking.length;
    if (detectRepeatingSuffix(thinking, THINKING_WINDOW) || detectSemanticLoop(thinking, sem))
      stop(ctx);
  });

  pi.on("message_end", (event, ctx) => {
    if (event.message.role !== "assistant") return;
    const index = findLastThinkingIndex(event.message);
    const thinking = index === null ? null : extractThinkingAt(event.message, index);
    resetStream();
    if (!thinking) return;
    if (!isLooping(thinking)) return;
    stop(ctx);
    return { message: sanitizeThinkingAt(event.message, index, TRIM_MARKER) };
  });
}

function extractThinkingAt(message: any, index: number | null): string | null {
  if (index === null || !Array.isArray(message?.content)) return null;
  const block = message.content[index];
  return block?.type === "thinking" && typeof block.thinking === "string" ? block.thinking : null;
}

function findLastThinkingIndex(message: any): number | null {
  if (!Array.isArray(message?.content)) return null;
  for (let i = message.content.length - 1; i >= 0; i--)
    if (message.content[i]?.type === "thinking") return i;
  return null;
}

function sanitizeThinkingAt(message: any, index: number | null, marker: string): any {
  if (index === null || !Array.isArray(message?.content) || message.content[index]?.type !== "thinking")
    return message;
  return {
    ...message,
    content: message.content.map((block: any, i: number) =>
      i === index ? { type: "text", text: marker } : block
    ),
  };
}

function detectSemanticLoop(text: string, state: SemanticState): boolean {
  const delim = /\r?\n[ \t]*\r?\n(?:[ \t]*\r?\n)*/g;
  delim.lastIndex = state.scanned;
  let pos = state.scanned;
  let inFence = state.inFence;
  for (;;) {
    const m = delim.exec(text);
    const end = m ? m.index : text.length;
    const para = text.slice(pos, end);
    const fenceMarks = (para.match(/```/g) ?? []).length;
    if (!inFence && fenceMarks === 0) {
      const trimmed = para.trim();
      if (trimmed.length >= PARA_MIN_LEN) {
        const fingerprintText = trimmed.replace(/^\d+([.)])\s+/, "#$1 ");
        const key = fingerprintText.slice(0, FINGERPRINT_LEN);
        const count = (state.counts.get(key) ?? 0) + 1;
        if (count >= SEMANTIC_THRESHOLD) return true;
        if (m) state.counts.set(key, count);
      }
    }
    if (!m) return false;
    if (fenceMarks % 2 === 1) inFence = !inFence;
    pos = delim.lastIndex;
    state.scanned = pos;
    state.inFence = inFence;
  }
}

function zArray(s: string): Int32Array {
  const n = s.length;
  const z = new Int32Array(n);
  if (n === 0) return z;
  z[0] = n;
  for (let i = 1, l = 0, r = 0; i < n; i++) {
    if (i < r) z[i] = Math.min(r - i, z[i - l]);
    while (i + z[i] < n && s.charCodeAt(z[i]) === s.charCodeAt(i + z[i])) z[i]++;
    if (i + z[i] > r) {
      l = i;
      r = i + z[i];
    }
  }
  return z;
}

function detectRepeatingSuffix(text: string, minWindow: number): boolean {
  const n = text.length;
  const maxW = Math.min(MAX_WINDOW, Math.floor(n / 2));
  if (minWindow <= 0 || maxW < minWindow) return false;
  const tail = text.slice(Math.max(0, n - 2 * maxW));
  const z = zArray(tail.split("").reverse().join(""));
  for (let w = minWindow; w <= maxW; w++) {
    if (z[w] >= w) return true;
  }
  return false;
}
