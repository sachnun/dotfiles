import { tool } from "@opencode-ai/plugin"
import { spawn, type ChildProcess } from "node:child_process"

interface ProcessInfo {
  id: string
  command: string
  proc: ChildProcess
  stdout: string[]
  stderr: string[]
  status: "running" | "stopped"
  startedAt: Date
}

const processes = new Map<string, ProcessInfo>()
let nextId = 1
const MAX_BUFFER = 1000

export const start = tool({
  description:
    "Start a shell command in the background and return a process ID. " +
    "IMPORTANT: call bg_list first to check if already running. " +
    "Use bg_logs to see output, bg_send to send stdin input, bg_stop to kill.",
  args: {
    command: tool.schema.string().describe("Shell command to run (e.g. 'npm run dev')"),
    cwd: tool.schema.string().optional().describe("Working directory"),
  },
  async execute({ command, cwd }, { directory }) {
    const id = `bg-${nextId++}`
    const proc = spawn("bash", ["-c", command], {
      cwd: cwd || directory,
      stdio: ["pipe", "pipe", "pipe"],
    })

    const info: ProcessInfo = {
      id, command, proc,
      stdout: [], stderr: [],
      status: "running",
      startedAt: new Date(),
    }

    proc.stdout?.on("data", (data: Uint8Array) => {
      for (const l of new TextDecoder().decode(data).split("\n").filter(Boolean)) info.stdout.push(l)
      if (info.stdout.length > MAX_BUFFER) info.stdout.splice(0, info.stdout.length - MAX_BUFFER)
    })

    proc.stderr?.on("data", (data: Uint8Array) => {
      for (const l of new TextDecoder().decode(data).split("\n").filter(Boolean)) info.stderr.push(l)
      if (info.stderr.length > MAX_BUFFER) info.stderr.splice(0, info.stderr.length - MAX_BUFFER)
    })

    proc.on("exit", () => { info.status = "stopped" })

    processes.set(id, info)
    return JSON.stringify({ process_id: id, status: "running", command })
  },
})

export const logs = tool({
  description: "Get stdout/stderr output from a background process.",
  args: {
    process_id: tool.schema.string().describe("Process ID from bg_start"),
    stream: tool.schema.enum(["stdout", "stderr", "both"]).optional().default("both"),
    tail: tool.schema.number().optional().describe("Most recent N lines (default: all)"),
  },
  async execute({ process_id, stream, tail }) {
    const info = processes.get(process_id)
    if (!info) return `Error: process "${process_id}" not found`

    const out: string[] = []
    if (stream === "stdout" || stream === "both") {
      const lines = tail ? info.stdout.slice(-tail) : info.stdout
      if (stream === "both") out.push("--- stdout ---")
      out.push(...lines)
    }
    if (stream === "stderr" || stream === "both") {
      const lines = tail ? info.stderr.slice(-tail) : info.stderr
      if (stream === "both") out.push("--- stderr ---")
      out.push(...lines)
    }
    return out.length ? out.join("\n") : `[process ${process_id}: no output yet]`
  },
})

export const send = tool({
  description: "Send input (stdin) to a running background process. Appends newline.",
  args: {
    process_id: tool.schema.string().describe("Process ID from bg_start"),
    input: tool.schema.string().describe("Text to send to stdin"),
  },
  async execute({ process_id, input }) {
    const info = processes.get(process_id)
    if (!info) return `Error: process "${process_id}" not found`
    if (info.status !== "running") return `Error: process "${process_id}" is not running`
    info.proc.stdin?.write(input + "\n")
    return `Sent input to process ${process_id}`
  },
})

export const stop = tool({
  description: "Stop/kill a background process.",
  args: {
    process_id: tool.schema.string().describe("Process ID from bg_start"),
    signal: tool.schema.string().optional().default("SIGTERM").describe("Signal (SIGTERM, SIGKILL, etc)"),
  },
  async execute({ process_id, signal }) {
    const info = processes.get(process_id)
    if (!info) return `Error: process "${process_id}" not found`
    if (info.status !== "running") return `Process ${process_id} is already stopped`
    try { (info.proc.kill as (s: string) => boolean)(signal) } catch {}
    return `Sent ${signal} to process ${process_id}`
  },
})

export const list = tool({
  description: "List all background processes. Call this before bg_start to avoid duplicates.",
  args: {},
  async execute() {
    if (!processes.size) return "No background processes."
    return JSON.stringify(
      Array.from(processes.values()).map(p => ({
        process_id: p.id,
        command: p.command,
        status: p.status,
        started_at: p.startedAt.toISOString(),
        uptime_seconds: Math.floor((Date.now() - p.startedAt.getTime()) / 1000),
      })),
      null, 2
    )
  },
})
