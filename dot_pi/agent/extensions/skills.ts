import * as fs from "node:fs";
import * as path from "node:path";
import { homedir } from "node:os";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { convertToLlm, serializeConversation } from "@earendil-works/pi-coding-agent";
import { uuidv7 } from "@earendil-works/pi-ai";

const SKILLS_DIR = path.join(homedir(), ".pi", "agent", "skills");
const REVIEW_INTERVAL_TURNS = 3;

const REVIEW_PROMPT = `You detect reusable procedures worth saving as Pi skills.
Reply with JSON only, no markdown fences:
{"save":false}
or
{"save":true,"name":"<name>","description":"<short when-to-use>","body":"<minimal markdown; for CLI, command examples>"}

name: prefer one clean, general lowercase word (e.g. "git", "pnpm", "typescript").
Use a hyphen only when one word cannot express it.
Save only if the procedure is non-obvious and not already common model knowledge.
Skip standard commands, common tool usage, and widely documented workflows.
Keep every field minimal to save tokens.`;

function validateName(name: string): string | null {
  if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(name)) {
    return "name must be lowercase letters, numbers, and single hyphens";
  }
  if (name.length > 64) return "name must be 64 chars or fewer";
  return null;
}

const INVISIBLE_CHARS = new Set([
  "\u200b",
  "\u200c",
  "\u200d",
  "\u2060",
  "\ufeff",
  "\u202a",
  "\u202b",
  "\u202c",
  "\u202d",
  "\u202e",
]);

function scanContent(text: string): string | null {
  for (const ch of text) {
    if (INVISIBLE_CHARS.has(ch)) return "blocked: invisible unicode character";
  }
  if (/sk-(ant-)?[A-Za-z0-9]{10,}/.test(text)) return "blocked: looks like an API key";
  if (/ghp_[A-Za-z0-9]{10,}/.test(text)) return "blocked: GitHub token";
  if (/-----BEGIN (?:RSA )?PRIVATE KEY-----/.test(text)) return "blocked: private key";
  if (/password\s*[=:]\s*\S{6,}/i.test(text)) return "blocked: password assignment";
  return null;
}

type SaveResult = { ok: boolean; error?: string; path?: string };

function writeSkill(name: string, description: string, body: string): SaveResult {
  const nameError = validateName(name);
  if (nameError) return { ok: false, error: nameError };
  description = description.trim();
  if (!description) return { ok: false, error: "description is required" };
  if (description.length > 1024) return { ok: false, error: "description must be 1024 chars or fewer" };
  const bodyText = body.trim() || description;
  for (const t of [description, bodyText]) {
    const scan = scanContent(t);
    if (scan) return { ok: false, error: scan };
  }

  const dir = path.join(SKILLS_DIR, name);
  if (fs.existsSync(dir)) return { ok: false, error: `skill '${name}' already exists` };

  const content = `---\nname: ${name}\ndescription: ${description}\n---\n\n${bodyText}\n`;
  fs.mkdirSync(dir, { recursive: true });
  const tmp = path.join(dir, ".SKILL.md.tmp");
  const target = path.join(dir, "SKILL.md");
  try {
    fs.writeFileSync(tmp, content, "utf-8");
    fs.renameSync(tmp, target);
  } catch (err) {
    try {
      fs.rmSync(tmp, { force: true });
    } catch {}
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
  return { ok: true, path: target };
}

function parseJson(text: string): Record<string, unknown> | null {
  const cleaned = text.replace(/```(?:json)?/g, "").trim();
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) return null;
  try {
    return JSON.parse(cleaned.slice(start, end + 1));
  } catch {
    return null;
  }
}

export default function (pi: ExtensionAPI) {
  let userTurns = 0;
  let reviewInProgress = false;

  pi.on("message_end", (event) => {
    if (event.message.role === "user") userTurns++;
  });

  pi.on("turn_end", async (_event, ctx) => {
    if (reviewInProgress) return;
    if (userTurns < REVIEW_INTERVAL_TURNS) return;
    userTurns = 0;
    reviewInProgress = true;
    try {
      await runReview(ctx);
    } catch {
      // Best effort: never block the session.
    } finally {
      reviewInProgress = false;
    }
  });
}

async function runReview(ctx: ExtensionContext): Promise<void> {
  const model = ctx.model;
  if (!model) return;

  const entries = ctx.sessionManager.getBranch();
  if (entries.length < 4) return;

  let conversation: string;
  try {
    conversation = serializeConversation(convertToLlm(entries));
  } catch {
    return;
  }

  const messages = [
    {
      role: "user" as const,
      content: [
        {
          type: "text" as const,
          text: `${REVIEW_PROMPT}\n\n<conversation>\n${conversation}\n</conversation>`,
        },
      ],
      timestamp: Date.now(),
    },
  ];

  const response = await ctx.modelRegistry.complete(
    model,
    { messages },
    { maxTokens: 512, signal: ctx.signal, cacheRetention: "none", sessionId: uuidv7() },
  );

  const text = response.content
    .filter((c): c is { type: "text"; text: string } => c.type === "text")
    .map((c) => c.text)
    .join("\n");

  const parsed = parseJson(text);
  if (!parsed || parsed.save !== true) return;
  if (typeof parsed.name !== "string" || typeof parsed.description !== "string") return;

  const r = writeSkill(
    parsed.name,
    parsed.description,
    typeof parsed.body === "string" ? parsed.body : "",
  );
  if (ctx.hasUI) {
    if (r.ok) ctx.ui.notify(`Saved skill '${parsed.name}'`, "info");
    else ctx.ui.notify(`Skill save failed: ${r.error}`, "warning");
  }
}
