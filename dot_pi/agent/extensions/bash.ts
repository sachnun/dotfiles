/**
 * bash tool guard.
 *
 * Policy, from most to least strict:
 *
 *  1. Syntax gate   - reject redirection/heredocs, command substitution,
 *                     subshells, backgrounding and unterminated quotes.
 *  2. Hard blocks   - things that must never run: sudo, eval/exec wrappers,
 *                     nested shells, xargs, tee, sed -i, remote command
 *                     runners (npx/bunx/npm exec/...) and shell control flow.
 *  3. Fast tools    - steer grep/find/fd/tree to `rg` and solo `cat` to the
 *                     read tool. `ls` stays allowed (needed for metadata).
 *  4. Confirmation  - any command that writes or destroys state (rm, dd,
 *                     chmod, mount, git write subcommands, ...) asks first.
 *
 * Everything else is free to run.
 */
import { posix } from 'node:path'
import type { ExtensionAPI } from '@mariozechner/pi-coding-agent'

// ------------------------------------------------------------------ types ---
type Tokens = string[]

type RuleContext = {
  /** Whether the whole command contains a pipe (`|`). */
  sawPipe: boolean
}

type Rule = {
  /**
   * Prefix to match against the normalized command tokens, e.g. `'rm'` or
   * `['git', 'commit']`. When omitted, the rule only uses `when`.
   */
  match?: string | readonly string[]
  /** Block/confirmation message; may be a function of the matched tokens. */
  reason: string | ((matched: Tokens) => string)
  /** Optional extra condition on top of `match`. */
  when?: (tokens: Tokens, ctx: RuleContext) => boolean
}

// --------------------------------------------------- fast tool suggestions ---
/** Search tools callers should use `rg` instead of. `ls` is intentionally left out. */
const FAST_TOOL_HINTS: Record<string, string> = {
  grep: 'Use `rg "<pattern>" ["<path>"]` (or `rg --glob "<glob>" "<pattern>"`) instead.',
  find: 'Use `rg --files ["<path>"]` or `rg --glob "<glob>" "<pattern>"` instead.',
  fd: 'Use `rg --files ["<path>"]` instead.',
  tree: 'Use `rg --files` to list files instead.',
}

// --------------------------------------------------------- hard blocks ---
const SHELL_KEYWORDS = ['if', 'then', 'fi', 'for', 'while', 'until', 'do', 'done', 'case', 'esac', 'function', 'select']
const RUNNER_BINARIES = ['npx', 'bunx', 'pnpx', 'uvx']
const RUNNER_SUBCOMMANDS: Record<string, readonly string[]> = {
  npm: ['exec', 'create', 'init'],
  yarn: ['dlx', 'create'],
  pnpm: ['dlx', 'create'],
  bun: ['x', 'create'],
  uv: ['tool'],
}
const RUNNER_REASON = 'Command runners can execute untrusted remote code and are blocked.'
const GIT_VALUE_FLAGS = ['--config-env', '--exec-path', '--git-dir', '--work-tree', '--namespace', '--super-prefix']

// ------------------------- general write signals (flag-based) ----------------
// Instead of per-language rules, detect the *general* flag shapes that write
// files or run inline code. Adding a tool = adding one name to a list below.
//
//   in-place  - -i / -iEXT / --in-place[=EXT] on tools that edit files in place
//   output    - -o / --output[=FILE] writing a file (search tools' -o is read-only)
//   code-exec - -e / -c / -r running an inline program on interpreters
const INPLACE_TOOLS = ['sed', 'perl', 'ruby', 'awk', 'gawk']
const CODE_EXEC_TOOLS = ['node', 'python3', 'python', 'perl', 'ruby', 'php', 'bun', 'deno']
const SEARCH_READ_TOOLS = ['rg', 'ack', 'ag']
const WRITE_SIGNAL_REASONS = {
  'in-place': 'This edits files in place (-i / --in-place). Use the edit tool, or confirm to run it.',
  output: 'This writes to a file via -o / --output. Confirm to allow it.',
  'code-exec': 'This runs an inline program via -e / -c / -r. Confirm to allow it.',
} as const

function writeSignal(tokens: Tokens): keyof typeof WRITE_SIGNAL_REASONS | undefined {
  const tool = tokens[0]
  for (let i = 1; i < tokens.length; i += 1) {
    const a = tokens[i]
    // in-place edits
    if (a === '--in-place' || a.startsWith('--in-place=')) return 'in-place'
    if (INPLACE_TOOLS.includes(tool)) {
      if (tool === 'awk' || tool === 'gawk') {
        // gawk: -i <file> is "include"; only -i inplace is the in-place extension
        if (a === '-i') {
          if (tokens[i + 1]?.startsWith('inplace')) return 'in-place'
        } else if (a.startsWith('-i') && a.slice(2).startsWith('inplace')) {
          return 'in-place'
        }
      } else if (a === '-i' || (/^-[A-Za-z]*i/.test(a) && a.length > 2)) {
        return 'in-place'
      }
    }
    // output-file flags
    if (!SEARCH_READ_TOOLS.includes(tool)) {
      if (a === '-o' || a === '--output' || a.startsWith('--output=')) return 'output'
      if (a === '-O' && tool === 'wget') return 'output'
    }
    // inline code execution
    if (CODE_EXEC_TOOLS.includes(tool) && (a === '-e' || a === '-c' || a === '-r')) return 'code-exec'
    if (tool === 'deno' && a === 'eval') return 'code-exec'
  }
  return undefined
}

const isSoloCat = (_tokens: Tokens, ctx: RuleContext): boolean => !ctx.sawPipe
const isRunner = (tokens: Tokens): boolean => {
  if (RUNNER_BINARIES.includes(tokens[0])) return true
  const subcommands = RUNNER_SUBCOMMANDS[tokens[0]]
  if (!subcommands) return false
  for (let i = 1; i < tokens.length; i += 1) {
    const t = tokens[i]
    if (t === '--') return false
    if (!t.startsWith('-')) return subcommands.includes(t)
  }
  return false
}
const isKeyword = (tokens: Tokens): boolean => SHELL_KEYWORDS.includes(tokens[0])

const HARD_BLOCKED: Rule[] = [
  { match: 'sudo', reason: 'The `sudo` command is blocked.' },
  { match: 'eval', reason: 'The `eval` wrapper is blocked.' },
  { match: 'exec', reason: 'The `exec` wrapper is blocked.' },
  { match: ['bash'], reason: 'Nested shells are blocked; run a single command directly.' },
  { match: ['sh'], reason: 'Nested shells are blocked; run a single command directly.' },
  { match: ['zsh'], reason: 'Nested shells are blocked; run a single command directly.' },
  { match: 'xargs', reason: 'The `xargs` command is blocked.' },
  { match: 'tee', reason: 'Use the write tool instead of `tee`.' },
  { match: 'cat', when: isSoloCat, reason: 'Reading a file with `cat` is blocked. Use the read tool, or pipe it (e.g. `cat file | jq`).' },
  { when: isKeyword, reason: (m) => `Shell control-flow \`${m[0]}\` is blocked.` },
  { when: isRunner, reason: RUNNER_REASON },
  ...Object.entries(FAST_TOOL_HINTS).map(
    ([tool, hint]): Rule => ({ match: tool, reason: `The \`${tool}\` command is blocked. ${hint}` }),
  ),
]

// ------------------------------------------------- confirmation rules ------
const isGitConfigWrite = (tokens: Tokens): boolean => {
  const args = tokens.slice(2)
  if (args.some((t) => ['--add', '--unset', '--unset-all', '--remove-section', '--rename-section', '--replace-all'].includes(t))) return true
  return args.filter((t) => !t.startsWith('-')).length >= 2
}

const GIT_WRITE_SUBCOMMANDS = [
  'add', 'am', 'apply', 'archive', 'bisect', 'bundle', 'checkout', 'checkout-index',
  'cherry-pick', 'clean', 'clone', 'commit', 'commit-tree', 'gc',
  'hash-object', 'init', 'maintenance', 'merge', 'mv', 'notes', 'prune', 'pull',
  'push', 'read-tree', 'rebase', 'replace', 'rerere', 'reset', 'restore', 'revert',
  'rm', 'sparse-checkout', 'stash', 'submodule', 'switch', 'symbolic-ref',
  'update-index', 'update-ref', 'worktree', 'write-tree',
]
const SYSTEM_WRITE_COMMANDS = ['rm', 'mv', 'dd', 'chmod', 'chown', 'mkfs', 'mkswap', 'fdisk', 'mount', 'umount', 'shutdown', 'reboot', 'poweroff']

const CONFIRM_FIRST: Rule[] = [
  { match: ['git', 'config'], when: isGitConfigWrite, reason: 'This modifies git configuration.' },
  ...GIT_WRITE_SUBCOMMANDS.map((sub): Rule => ({ match: ['git', sub], reason: 'This modifies git state (index, working tree, history or remotes).' })),
  ...SYSTEM_WRITE_COMMANDS.map((cmd): Rule => ({ match: cmd, reason: 'This writes to or destroys system/filesystem state.' })),
]

// ------------------------------------------------------------- tokenizer ----
type SplitResult = { segments?: string[]; sawPipe?: boolean; reason?: string }

/** Split a command into segments (`|`, `&&`, `||`, `;`, newline) and validate syntax. */
function splitCommand(command: string): SplitResult {
  const segments: string[] = []
  let current = ''
  let sawPipe = false
  let inSingle = false
  let inDouble = false
  let escaped = false
  for (let i = 0; i < command.length; i += 1) {
    const c = command[i]
    if (escaped) {
      current += c
      escaped = false
      continue
    }
    if (c === '\\' && !inSingle) {
      current += c
      escaped = true
      continue
    }
    if (c === "'" && !inDouble) {
      current += c
      inSingle = !inSingle
      continue
    }
    if (c === '"' && !inSingle) {
      current += c
      inDouble = !inDouble
      continue
    }
    if (!inSingle && c === '`') return { reason: 'Command substitution with backticks is blocked.' }
    if (!inSingle && c === '$' && command[i + 1] === '(') return { reason: 'Command substitution with `$()` is blocked.' }
    if (!inSingle && !inDouble && (c === '<' || c === '>')) return { reason: 'Redirection, heredocs and herestrings are blocked.' }
    if (!inSingle && !inDouble && (c === '(' || c === ')')) return { reason: 'Subshell syntax is blocked.' }
    if (inSingle || inDouble) {
      current += c
      continue
    }
    if (c === '\n' || c === ';') {
      const seg = current.trim()
      if (seg) segments.push(seg)
      current = ''
      continue
    }
    if (c === '|') {
      sawPipe = true
      const seg = current.trim()
      if (seg) segments.push(seg)
      current = ''
      if (command[i + 1] === '|') i += 1
      continue
    }
    if (c === '&') {
      if (command[i + 1] !== '&') return { reason: 'Background execution is blocked.' }
      const seg = current.trim()
      if (seg) segments.push(seg)
      current = ''
      i += 1
      continue
    }
    current += c
  }
  if (inSingle || inDouble) return { reason: 'Unterminated quotes are blocked.' }
  const last = current.trim()
  if (last) segments.push(last)
  return { segments, sawPipe }
}

/** Shell-like tokenization: split on whitespace, drop quotes and escapes. */
function tokenizeCommand(segment: string): Tokens | undefined {
  const tokens: Tokens = []
  let current = ''
  let inSingle = false
  let inDouble = false
  let escaped = false
  for (let i = 0; i < segment.length; i += 1) {
    const c = segment[i]
    if (escaped) {
      current += c
      escaped = false
      continue
    }
    if (c === '\\' && !inSingle) {
      escaped = true
      continue
    }
    if (c === "'" && !inDouble) {
      inSingle = !inSingle
      continue
    }
    if (c === '"' && !inSingle) {
      inDouble = !inDouble
      continue
    }
    if (!inSingle && !inDouble && /\s/.test(c)) {
      if (current) tokens.push(current)
      current = ''
      continue
    }
    current += c
  }
  if (inSingle || inDouble || escaped) return undefined
  if (current) tokens.push(current)
  return tokens
}

/** Strip `VAR=x ...` assignments, then `env`/`command` prefixes, then find the executable. */
function commandTokens(tokens: Tokens): Tokens {
  const stripEnv = (ts: Tokens): Tokens => {
    let i = 0
    while (i < ts.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(ts[i])) i += 1
    return ts.slice(i)
  }
  let rest = stripEnv(tokens)
  for (;;) {
    const first = rest[0]
    if (first !== 'env' && first !== 'command') break
    rest = rest.slice(1)
    while (rest[0]?.startsWith('-') && rest[0] !== '--') rest = rest.slice(1)
    rest = stripEnv(rest)
  }
  if (rest.length === 0) return []
  return [posix.basename(rest[0]), ...rest.slice(1)]
}

/** First non-flag token after `git` (skips value flags such as `-c` / `-C`). */
function gitSubcommand(tokens: Tokens): string | undefined {
  for (let i = 1; i < tokens.length; i += 1) {
    const t = tokens[i]
    if (!t.startsWith('-') || t === '-') return t
    if (t === '-c' || t === '-C') {
      i += 1
      continue
    }
    if (t.includes('=')) continue
    if (GIT_VALUE_FLAGS.includes(t)) {
      i += 1
      continue
    }
  }
  return undefined
}

/** Normalize tokens for rule matching: collapse `git <subcommand>` onto itself. */
function ruleTokens(tokens: Tokens): Tokens {
  if (tokens[0] === 'git') {
    const sub = gitSubcommand(tokens)
    return sub ? ['git', sub] : tokens
  }
  return tokens
}

function findRule(tokens: Tokens, rules: Rule[], ctx: RuleContext): { rule: Rule; matched: Tokens } | undefined {
  const base = ruleTokens(tokens)
  for (const rule of rules) {
    const parts = rule.match === undefined ? undefined : typeof rule.match === 'string' ? [rule.match] : [...rule.match]
    if (parts) {
      if (parts.length > base.length) continue
      let ok = true
      for (let i = 0; i < parts.length; i += 1) {
        if (base[i] !== parts[i]) {
          ok = false
          break
        }
      }
      if (!ok) continue
    }
    if (rule.when && !rule.when(tokens, ctx)) continue
    return { rule, matched: parts ?? [tokens[0] ?? ''] }
  }
  return undefined
}

function reasonText(rule: Rule, matched: Tokens): string {
  return typeof rule.reason === 'function' ? rule.reason(matched) : rule.reason
}

type ConfirmContext = {
  hasUI: boolean
  mode: string
  ui: { confirm(title: string, message: string): Promise<boolean> }
}

/** Ask the user, or block when interactive confirmation is unavailable. */
async function confirmOrBlock(
  ctx: ConfirmContext,
  title: string,
  body: string,
): Promise<{ block: true; reason: string } | undefined> {
  if (!ctx.hasUI) {
    return {
      block: true,
      reason: `The command \`${title}\` requires interactive confirmation, which is unavailable in ${ctx.mode} mode.`,
    }
  }
  const confirmed = await ctx.ui.confirm(title, body)
  if (!confirmed) return { block: true, reason: `The \`${title}\` command was not confirmed.` }
  return undefined
}

function getBashCommand(input: unknown): string | undefined {
  if (!input || typeof input !== 'object') return undefined
  const command = (input as { command?: unknown }).command
  if (typeof command !== 'string') return undefined
  const trimmedCommand = command.trim()
  return trimmedCommand || undefined
}

// ------------------------------------------------------------ extension -----
export default function shellExtension(pi: ExtensionAPI) {
  pi.on('tool_call', async (event, ctx) => {
    if (event.toolName !== 'bash') return
    const command = getBashCommand(event.input)
    if (!command) return { block: true, reason: 'The `bash` tool was called without a command.' }

    const parsed = splitCommand(command)
    if (parsed.reason) return { block: true, reason: parsed.reason }
    const segments = parsed.segments ?? []
    const ruleCtx: RuleContext = { sawPipe: parsed.sawPipe === true }

    for (const segment of segments) {
      const tokens = tokenizeCommand(segment)
      if (!tokens) return { block: true, reason: 'Unterminated quotes are blocked.' }
      const cmd = commandTokens(tokens)

      const hard = findRule(cmd, HARD_BLOCKED, ruleCtx)
      if (hard) return { block: true, reason: reasonText(hard.rule, hard.matched) }

      const signal = writeSignal(cmd)
      if (signal) {
        const blocked = await confirmOrBlock(ctx, `$ ${cmd.join(' ')}`, WRITE_SIGNAL_REASONS[signal])
        if (blocked) return blocked
      }

      const confirmRule = findRule(cmd, CONFIRM_FIRST, ruleCtx)
      if (confirmRule) {
        const title = `$ ${confirmRule.matched.join(' ')}`
        const blocked = await confirmOrBlock(ctx, title, reasonText(confirmRule.rule, confirmRule.matched))
        if (blocked) return blocked
      }
    }
  })
}