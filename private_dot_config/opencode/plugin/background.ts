import { tool, type Plugin } from "@opencode-ai/plugin"
import { spawn } from "node:child_process"

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
const MAX_BUFFER_LINES = 1000

export default (async () => {
  return {
    tool: {
      bg_start: tool({
        description:
          "Start a shell command in the background and return a process ID. " +
          "IMPORTANT: call bg_list first to check if the process is already running. " +
          "Use bg_logs to see output, bg_send to send stdin input, bg_stop to kill.",
        args: {
          command: tool.schema
            .string()
            .describe("Shell command to run in the background (e.g. 'npm run dev')"),
          cwd: tool.schema
            .string()
            .optional()
            .describe("Working directory (defaults to project root)"),
        },
        async execute({ command, cwd }, { directory }) {
          const id = `bg-${nextId++}`
          const proc = spawn("bash", ["-c", command], {
            cwd: cwd || directory,
            stdio: ["pipe", "pipe", "pipe"],
          })

          const info: ProcessInfo = {
            id,
            command,
            proc,
            stdout: [],
            stderr: [],
            status: "running",
            startedAt: new Date(),
          }

          proc.stdout?.on("data", (data: Uint8Array) => {
            const text = new TextDecoder().decode(data)
            const lines = text.split("\n")
            for (const line of lines) {
              if (line) info.stdout.push(line)
            }
            if (info.stdout.length > MAX_BUFFER_LINES) {
              info.stdout.splice(0, info.stdout.length - MAX_BUFFER_LINES)
            }
          })

          proc.stderr?.on("data", (data: Uint8Array) => {
            const text = new TextDecoder().decode(data)
            const lines = text.split("\n")
            for (const line of lines) {
              if (line) info.stderr.push(line)
            }
            if (info.stderr.length > MAX_BUFFER_LINES) {
              info.stderr.splice(0, info.stderr.length - MAX_BUFFER_LINES)
            }
          })

          proc.on("exit", () => {
            info.status = "stopped"
          })

          processes.set(id, info)

          return {
            output: JSON.stringify({ process_id: id, status: "running", command }),
          }
        },
      }),

      bg_logs: tool({
        description:
          "Get stdout/stderr output from a background process started with bg_start.",
        args: {
          process_id: tool.schema
            .string()
            .describe("Process ID returned by bg_start"),
          stream: tool.schema
            .enum(["stdout", "stderr", "both"])
            .optional()
            .default("both")
            .describe("Which output stream to read"),
          tail: tool.schema
            .number()
            .optional()
            .describe("Number of most recent lines to return (default: all lines)"),
        },
        async execute({ process_id, stream, tail }) {
          const info = processes.get(process_id)
          if (!info) {
            return { output: `Error: process "${process_id}" not found` }
          }

          const output: string[] = []

          if (stream === "stdout" || stream === "both") {
            const lines = tail ? info.stdout.slice(-tail) : info.stdout
            if (stream === "both") output.push("--- stdout ---")
            output.push(...lines)
          }

          if (stream === "stderr" || stream === "both") {
            const lines = tail ? info.stderr.slice(-tail) : info.stderr
            if (stream === "both") output.push("--- stderr ---")
            output.push(...lines)
          }

          const text = output.join("\n")
          return text
            ? { output: text }
            : { output: `[process ${process_id}: no output yet]` }
        },
      }),

      bg_send: tool({
        description:
          "Send input (stdin) to a running background process. Appends a newline automatically.",
        args: {
          process_id: tool.schema
            .string()
            .describe("Process ID returned by bg_start"),
          input: tool.schema
            .string()
            .describe("Text to send to the process's stdin"),
        },
        async execute({ process_id, input }) {
          const info = processes.get(process_id)
          if (!info) {
            return { output: `Error: process "${process_id}" not found` }
          }
          if (info.status !== "running") {
            return { output: `Error: process "${process_id}" is not running` }
          }

          info.proc.stdin?.write(input + "\n")
          return { output: `Sent input to process ${process_id}` }
        },
      }),

      bg_stop: tool({
        description:
          "Stop/kill a background process with the given signal.",
        args: {
          process_id: tool.schema
            .string()
            .describe("Process ID returned by bg_start"),
          signal: tool.schema
            .string()
            .optional()
            .default("SIGTERM")
            .describe(
              "Signal to send (default: SIGTERM, use SIGKILL to force kill)"
            ),
        },
        async execute({ process_id, signal }) {
          const info = processes.get(process_id)
          if (!info) {
            return { output: `Error: process "${process_id}" not found` }
          }
          if (info.status !== "running") {
            return { output: `Process ${process_id} is already stopped` }
          }

          try {
            ; (info.proc.kill as (s: string) => boolean)(signal)
          } catch {
            // process may already be dead
          }
          return { output: `Sent ${signal} to process ${process_id}` }
        },
      }),

      bg_list: tool({
        description:
          "List all background processes and their current status. " +
          "Call this before bg_start to avoid duplicate processes.",
        args: {},
        async execute() {
          const list = Array.from(processes.values()).map((p) => ({
            process_id: p.id,
            command: p.command,
            status: p.status,
            started_at: p.startedAt.toISOString(),
            uptime_seconds: Math.floor(
              (Date.now() - p.startedAt.getTime()) / 1000
            ),
          }))

          if (list.length === 0) {
            return { output: "No background processes." }
          }

          return { output: JSON.stringify(list, null, 2) }
        },
      }),
    },
  }
}) satisfies Plugin
