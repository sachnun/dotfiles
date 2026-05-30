import { tool } from "@opencode-ai/plugin"
import { spawn } from "node:child_process"
import { readFileSync, existsSync, mkdirSync } from "node:fs"
import { join } from "node:path"

const TMP = "/tmp/opencode/bg"
const jobs = new Map()
let nextId = 1

function log(id, name) { return join(TMP, `${id}.${name}.log`) }

export const start = tool({
  description: "Start a shell command in the background. Returns process_id for use with bg_logs/bg_stop/bg_list/bg_send.",
  args: {
    command: tool.schema.string().describe("Shell command to run"),
    cwd: tool.schema.string().optional().describe("Working directory"),
  },
  async execute({ command, cwd }, { directory }) {
    if (!existsSync(TMP)) mkdirSync(TMP, { recursive: true })
    const id = `bg-${nextId++}`
    const proc = spawn("bash", ["-c", `{ ${command}; } >${log(id, "out")} 2>${log(id, "err")}`], {
      cwd: cwd || directory,
      stdio: ["pipe", "ignore", "ignore"],
    })
    jobs.set(id, { proc, status: "running" })
    proc.on("exit", (code) => { const j = jobs.get(id); if (j) j.status = code === 0 ? "completed" : "failed" })
    return JSON.stringify({ process_id: id, status: "running", command })
  },
})

export const logs = tool({
  description: "Get stdout/stderr output from a background process.",
  args: {
    process_id: tool.schema.string(),
    stream: tool.schema.enum(["stdout", "stderr", "both"]).optional(),
    tail: tool.schema.number().optional(),
  },
  async execute({ process_id, stream = "both", tail = 0 }) {
    const job = jobs.get(process_id)
    if (!job) return `Error: process "${process_id}" not found`
    const out = []
    for (const name of stream === "stdout" ? ["out"] : stream === "stderr" ? ["err"] : ["out", "err"]) {
      const f = log(process_id, name)
      if (existsSync(f)) {
        const lines = readFileSync(f, "utf-8").replace(/\n$/, "").split("\n").filter(Boolean)
        out.push(...(tail ? lines.slice(-tail) : lines))
      }
    }
    return out.length ? out.join("\n") : `[process ${process_id}: no output yet]`
  },
})

export const send = tool({
  description: "Send input (stdin) to a running background process.",
  args: {
    process_id: tool.schema.string(),
    input: tool.schema.string(),
  },
  async execute({ process_id, input }) {
    const job = jobs.get(process_id)
    if (!job) return `Error: process "${process_id}" not found`
    if (job.status !== "running") return `Error: process "${process_id}" is not running`
    job.proc.stdin.write(input + "\n")
    return `Sent input to process ${process_id}`
  },
})

export const stop = tool({
  description: "Stop/kill a background process.",
  args: {
    process_id: tool.schema.string(),
    signal: tool.schema.string().optional(),
  },
  async execute({ process_id, signal = "SIGTERM" }) {
    const job = jobs.get(process_id)
    if (!job) return `Error: process "${process_id}" not found`
    if (job.status !== "running") return `Process ${process_id} is already stopped`
    try { job.proc.kill(signal) } catch {}
    job.status = "stopped"
    return `Sent ${signal} to process ${process_id}`
  },
})

export const list = tool({
  description: "List all background processes.",
  args: {},
  async execute() {
    if (!jobs.size) return "No background processes."
    return JSON.stringify(Array.from(jobs.entries()).map(([id, j]) => ({ process_id: id, status: j.status })))
  },
})
