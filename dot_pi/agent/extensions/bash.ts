import { posix } from 'node:path'
import type { ExtensionAPI } from '@mariozechner/pi-coding-agent'

type PatternPart = string | string[]
type Pattern = PatternPart[]
type ForbiddenRule = {
  pattern: Pattern
  reason: string | ((matchTokens: string[]) => string)
}
type SegmentResult = {
  segments?: string[]
  reason?: string
}

const searchCommands = ['fd', 'find', 'grep', 'ls', 'tree']
const shellCommands = ['bash', 'sh', 'zsh']
const wrapperCommands = ['eval', 'exec', 'nohup', 'timeout', 'time', 'watch', 'stdbuf']
const commandRunnerCommands = ['bunx', 'npx', 'pnpx', 'uvx']
const commandRunnerSubcommands: string[][] = [
  ['pnpm', 'dlx'],
  ['yarn', 'dlx'],
  ['npm', 'exec'],
  ['bun', 'x'],
  ['uv', 'tool', 'run'],
  ['npm', 'create'],
  ['npm', 'init'],
  ['yarn', 'create'],
  ['pnpm', 'create'],
  ['bun', 'create'],
]
const commandRunnerPositionalSkipRules: Record<string, { token: string; consumesNextToken: boolean }[]> = {
  npm: [
    { token: 'workspace', consumesNextToken: true },
    { token: 'workspaces', consumesNextToken: false },
  ],
  yarn: [
    { token: 'workspace', consumesNextToken: true },
    { token: 'workspaces', consumesNextToken: false },
    { token: 'foreach', consumesNextToken: false },
  ],
}
const commandRunnerFlagRules: Record<string, { booleanFlags: string[]; valueFlags: string[] }> = {
  npm: {
    booleanFlags: ['--silent', '--quiet', '-s'],
    valueFlags: ['--prefix', '--cache', '--registry', '--userconfig', '--workspace'],
  },
  yarn: {
    booleanFlags: ['--silent'],
    valueFlags: ['--cwd'],
  },
  pnpm: {
    booleanFlags: ['--silent'],
    valueFlags: ['--filter'],
  },
  uv: {
    booleanFlags: ['--verbose', '-v'],
    valueFlags: ['--index-url'],
  },
}
const readCommands = ['cat']
const writeCommands = ['tee']
const shellControlKeywords = ['if', 'then', 'fi', 'for', 'while', 'until', 'do', 'done', 'case', 'esac', 'function', 'select']
const gitFlagsWithValues = ['-c', '-C']
const gitLongFlagsWithValues = ['--config-env', '--exec-path', '--git-dir', '--work-tree', '--namespace', '--super-prefix']
const gitWriteCommands = [
  'add',
  'am',
  'apply',
  'archive',
  'bisect',
  'branch',
  'bundle',
  'checkout',
  'checkout-index',
  'cherry-pick',
  'clean',
  'clone',
  'commit',
  'commit-tree',
  'config',
  'fetch',
  'gc',
  'grep',
  'hash-object',
  'init',
  'maintenance',
  'merge',
  'mv',
  'notes',
  'prune',
  'pull',
  'push',
  'read-tree',
  'rebase',
  'remote',
  'replace',
  'rerere',
  'reset',
  'restore',
  'revert',
  'rm',
  'sparse-checkout',
  'stash',
  'submodule',
  'switch',
  'symbolic-ref',
  'tag',
  'update-index',
  'update-ref',
  'worktree',
  'write-tree',
]
const forbiddenRules: ForbiddenRule[] = [
  {
    pattern: ['sudo'],
    reason: 'The `sudo` command is blocked in the `bash` tool.',
  },
  {
    pattern: [wrapperCommands],
    reason: (matchTokens) => `The \`${matchTokens[0]}\` wrapper command is blocked in the \`bash\` tool.`,
  },
  {
    pattern: ['git', gitWriteCommands],
    reason: (matchTokens) => `The \`git ${matchTokens[1]}\` command is blocked in the \`bash\` tool.`,
  },
  {
    pattern: [commandRunnerCommands],
    reason: (matchTokens) => `The command runner \`${matchTokens[0]}\` is blocked in the \`bash\` tool because it can execute untrusted remote tools.`,
  },
  {
    pattern: ['nl'],
    reason: 'The `nl` command is blocked in the `bash` tool.',
  },
  {
    pattern: ['xargs'],
    reason: 'The `xargs` command is blocked in the `bash` tool.',
  },
  {
    pattern: [readCommands],
    reason: (matchTokens) => `The \`${matchTokens[0]}\` file-reading command is blocked in the \`bash\` tool. Use the read tool instead.`,
  },
  {
    pattern: [writeCommands],
    reason: (matchTokens) => `The \`${matchTokens[0]}\` file-writing command is blocked in the \`bash\` tool.`,
  },
  {
    pattern: [searchCommands],
    reason: (matchTokens) =>
      `The \`${matchTokens[0]}\` search/listing command is blocked in the \`bash\` tool. Use \`rg '<text-pattern>'\` (or \`rg --glob '<path-glob>' '<text-pattern>'\`) for search, and \`rg --files\` (or \`rg --files --glob '<path-glob>'\`) for listing.`,
  },
  {
    pattern: [shellCommands],
    reason: (matchTokens) => `The nested shell command \`${matchTokens[0]}\` is blocked in the \`bash\` tool.`,
  },
]
const blockedTools = [
  {
    toolName: 'grep',
    reason: "The `grep` tool is blocked. Use `rg '<text-pattern>'` or `rg --glob '<path-glob>' '<text-pattern>'` instead.",
  },
  {
    toolName: 'find',
    reason: "The `find` tool is blocked. Use `rg --files` or `rg --files --glob '<path-glob>'` instead.",
  },
  {
    toolName: 'ls',
    reason: "The `ls` tool is blocked. Use `rg --files` or `rg --files --glob '<path-glob>'` instead.",
  },
]

function getBashCommand(input: unknown): string | undefined {
  if (!input || typeof input !== 'object') return undefined
  const command = (input as { command?: unknown }).command
  if (typeof command !== 'string') return undefined
  const trimmedCommand = command.trim()
  if (!trimmedCommand) return undefined
  return trimmedCommand
}

function isShellExpansionStart(command: string, index: number, inDoubleQuotes: boolean): boolean {
  if (command[index] !== '$') return false
  const nextCharacter = command[index + 1]
  if (!nextCharacter) return false
  if (nextCharacter === '(' || nextCharacter === '{' || nextCharacter === "'") {
    return true
  }
  if (!inDoubleQuotes && nextCharacter === '"') return true
  if (/[A-Za-z_]/.test(nextCharacter)) return true
  if (/[0-9]/.test(nextCharacter)) return true
  if ('@*#?$!-'.includes(nextCharacter)) return true
  return false
}

function splitCommand(command: string): SegmentResult {
  const segments: string[] = []
  let current = ''
  let inSingleQuotes = false
  let inDoubleQuotes = false
  let isEscaped = false
  for (let index = 0; index < command.length; index += 1) {
    const character = command[index]
    if (isEscaped) {
      current += character
      isEscaped = false
      continue
    }
    if (character === '\\' && !inSingleQuotes) {
      current += character
      isEscaped = true
      continue
    }
    if (character === "'" && !inDoubleQuotes) {
      current += character
      inSingleQuotes = !inSingleQuotes
      continue
    }
    if (character === '"' && !inSingleQuotes) {
      current += character
      inDoubleQuotes = !inDoubleQuotes
      continue
    }
    if (!inSingleQuotes && character === '`') {
      return {
        reason: 'Command substitution with backticks is blocked in the `bash` tool.',
      }
    }
    if (!inSingleQuotes && character === '$' && command[index + 1] === '(') {
      return {
        reason: 'Command substitution with `$()` is blocked in the `bash` tool.',
      }
    }
    if (!inSingleQuotes && isShellExpansionStart(command, index, inDoubleQuotes)) {
      return {
        reason: 'Variable expansion and shell interpolation are blocked in the `bash` tool.',
      }
    }
    if (!inSingleQuotes && !inDoubleQuotes && (character === '<' || character === '>')) {
      return {
        reason: 'Redirection, heredocs, and herestrings are blocked in the `bash` tool.',
      }
    }
    if (!inSingleQuotes && !inDoubleQuotes && (character === '(' || character === ')')) {
      return {
        reason: 'Subshell syntax is blocked in the `bash` tool.',
      }
    }
    if (inSingleQuotes || inDoubleQuotes) {
      current += character
      continue
    }
    if (character === '\n' || character === ';') {
      const trimmedSegment = current.trim()
      if (trimmedSegment) segments.push(trimmedSegment)
      current = ''
      continue
    }
    if (character === '|') {
      const trimmedSegment = current.trim()
      if (trimmedSegment) segments.push(trimmedSegment)
      current = ''
      if (command[index + 1] === '|') index += 1
      continue
    }
    if (character === '&') {
      if (command[index + 1] !== '&') {
        return {
          reason: 'Background execution is blocked in the `bash` tool.',
        }
      }
      const trimmedSegment = current.trim()
      if (trimmedSegment) segments.push(trimmedSegment)
      current = ''
      index += 1
      continue
    }
    current += character
  }
  if (inSingleQuotes || inDoubleQuotes) {
    return {
      reason: 'Unterminated quotes are blocked in the `bash` tool.',
    }
  }
  const trimmedSegment = current.trim()
  if (trimmedSegment) segments.push(trimmedSegment)
  return { segments }
}

function tokenizeCommand(segment: string): string[] | undefined {
  const tokens: string[] = []
  let current = ''
  let inSingleQuotes = false
  let inDoubleQuotes = false
  let isEscaped = false
  for (let index = 0; index < segment.length; index += 1) {
    const character = segment[index]
    if (isEscaped) {
      current += character
      isEscaped = false
      continue
    }
    if (character === '\\' && !inSingleQuotes) {
      isEscaped = true
      continue
    }
    if (character === "'" && !inDoubleQuotes) {
      inSingleQuotes = !inSingleQuotes
      continue
    }
    if (character === '"' && !inSingleQuotes) {
      inDoubleQuotes = !inDoubleQuotes
      continue
    }
    if (!inSingleQuotes && !inDoubleQuotes && /\s/.test(character)) {
      if (current) tokens.push(current)
      current = ''
      continue
    }
    current += character
  }
  if (isEscaped) current += '\\'
  if (inSingleQuotes || inDoubleQuotes) return undefined
  if (current) tokens.push(current)
  return tokens
}

function isEnvironmentAssignment(token: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*=/.test(token)
}

function normalizeExecutableToken(token: string): string {
  if (!token) return token
  if (token === '.' || token === '..') return token
  if (!token.includes('/')) return token
  return posix.basename(token)
}

function getCommandTokens(tokens: string[]): string[] {
  let index = 0
  while (index < tokens.length && isEnvironmentAssignment(tokens[index])) index += 1
  while (index < tokens.length) {
    const normalizedToken = normalizeExecutableToken(tokens[index])
    if (normalizedToken !== 'env' && normalizedToken !== 'command') break
    if (normalizedToken === 'env') {
      index += 1
      while (index < tokens.length && tokens[index].startsWith('-')) index += 1
      while (index < tokens.length && isEnvironmentAssignment(tokens[index])) index += 1
      continue
    }
    index += 1
    while (index < tokens.length && tokens[index].startsWith('-')) index += 1
  }
  if (index >= tokens.length) return []
  return [normalizeExecutableToken(tokens[index]), ...tokens.slice(index + 1)]
}

function isSedInPlace(tokens: string[]): boolean {
  if (tokens.length === 0) return false
  if (tokens[0] !== 'sed') return false
  for (const token of tokens) {
    if (token === '--in-place') return true
    if (token.startsWith('--in-place=')) return true
    if (/^-[A-Za-z0-9]*i/.test(token)) return true
  }
  return false
}

function getGitCommandTokens(tokens: string[]): string[] {
  if (tokens.length === 0) return tokens
  if (tokens[0] !== 'git') return tokens
  let index = 1
  while (index < tokens.length) {
    const token = tokens[index]
    if (!token.startsWith('-') || token === '-') break
    let consumedValue = false
    for (const flag of gitFlagsWithValues) {
      if (token !== flag) continue
      index += 1
      if (index < tokens.length) index += 1
      consumedValue = true
      break
    }
    if (consumedValue) continue
    let consumedInlineValue = false
    for (const flag of gitFlagsWithValues) {
      if (token === flag) continue
      if (!token.startsWith(flag) || token.length === flag.length) continue
      index += 1
      consumedInlineValue = true
      break
    }
    if (consumedInlineValue) continue
    let consumedLongValue = false
    for (const flag of gitLongFlagsWithValues) {
      if (token === flag) {
        index += 1
        if (index < tokens.length) index += 1
        consumedLongValue = true
        break
      }
      if (!token.startsWith(`${flag}=`)) continue
      index += 1
      consumedLongValue = true
      break
    }
    if (consumedLongValue) continue
    index += 1
  }
  if (index >= tokens.length) return ['git']
  return ['git', tokens[index], ...tokens.slice(index + 1)]
}

function getUnsupportedReason(tokens: string[]): string | undefined {
  if (tokens.length === 0) return undefined
  for (const keyword of shellControlKeywords) {
    if (tokens[0] !== keyword) continue
    return `The shell control-flow keyword \`${tokens[0]}\` is blocked in the \`bash\` tool.`
  }
  return undefined
}

function getSubcommandScanEndIndex(tokens: string[]): number {
  for (let index = 0; index < tokens.length; index += 1) {
    if (tokens[index] !== '--') continue
    return index
  }
  return tokens.length
}

function matchesPatternPart(token: string, part: PatternPart): boolean {
  if (typeof part === 'string') return token === part
  for (const value of part) {
    if (token === value) return true
  }
  return false
}

function getCommandRunnerPositionalSkipLength(tokens: string[], tokenIndex: number, scanEndIndex: number): number {
  const skipRules = commandRunnerPositionalSkipRules[tokens[0]]
  if (!skipRules) return 0
  for (const skipRule of skipRules) {
    if (tokens[tokenIndex] !== skipRule.token) continue
    if (!skipRule.consumesNextToken) return 1
    if (tokenIndex + 1 >= scanEndIndex) return 0
    return 2
  }
  return 0
}

function getCommandRunnerFlagSkipLength(tokens: string[], tokenIndex: number, expectedToken: string, scanEndIndex: number): number {
  const token = tokens[tokenIndex]
  if (!token.startsWith('-')) return 0
  if (token === '--') return 0
  if (token.includes('=')) return 1
  const flagRules = commandRunnerFlagRules[tokens[0]]
  if (flagRules?.booleanFlags.includes(token)) return 1
  if (flagRules?.valueFlags.includes(token)) {
    if (tokenIndex + 1 >= scanEndIndex) return 1
    return 2
  }
  if (tokenIndex + 1 >= scanEndIndex) return 1
  const nextToken = tokens[tokenIndex + 1]
  if (nextToken === expectedToken) return 1
  if (nextToken.startsWith('-')) return 1
  return 2
}

function matchesCommandRunnerSubcommand(tokens: string[], subcommandTokens: string[]): boolean {
  if (tokens.length < subcommandTokens.length) return false
  if (tokens[0] !== subcommandTokens[0]) return false
  const scanEndIndex = getSubcommandScanEndIndex(tokens)
  let tokenIndex = 1
  for (let subcommandIndex = 1; subcommandIndex < subcommandTokens.length; subcommandIndex += 1) {
    const expectedToken = subcommandTokens[subcommandIndex]
    let matched = false
    while (tokenIndex < scanEndIndex) {
      const currentToken = tokens[tokenIndex]
      if (currentToken === expectedToken) {
        matched = true
        tokenIndex += 1
        break
      }
      const positionalSkipLength = getCommandRunnerPositionalSkipLength(tokens, tokenIndex, scanEndIndex)
      if (positionalSkipLength > 0) {
        tokenIndex += positionalSkipLength
        continue
      }
      const flagSkipLength = getCommandRunnerFlagSkipLength(tokens, tokenIndex, expectedToken, scanEndIndex)
      if (flagSkipLength > 0) {
        tokenIndex += flagSkipLength
        continue
      }
      return false
    }
    if (!matched) return false
  }
  return true
}

function getForbiddenReason(tokens: string[]): string | undefined {
  const unsupportedReason = getUnsupportedReason(tokens)
  if (unsupportedReason) return unsupportedReason
  const commandTokens = getCommandTokens(tokens)
  if (commandTokens.length === 0) return undefined
  for (const commandRunnerSubcommand of commandRunnerSubcommands) {
    if (!matchesCommandRunnerSubcommand(commandTokens, commandRunnerSubcommand)) continue
    return `The command runner \`${commandRunnerSubcommand.join(' ')}\` is blocked in the \`bash\` tool because it can execute untrusted remote tools.`
  }
  if (isSedInPlace(commandTokens)) {
    return 'The `sed -i` command is blocked in the `bash` tool.'
  }
  const matchTokens = getGitCommandTokens(commandTokens)
  for (const rule of forbiddenRules) {
    if (matchTokens.length < rule.pattern.length) continue
    let matched = true
    for (let index = 0; index < rule.pattern.length; index += 1) {
      if (matchesPatternPart(matchTokens[index], rule.pattern[index])) continue
      matched = false
      break
    }
    if (!matched) continue
    if (typeof rule.reason === 'function') return rule.reason(matchTokens)
    return rule.reason
  }
  return undefined
}

export default function shellExtension(pi: ExtensionAPI) {
  pi.on('tool_call', async (event) => {
    for (const blockedTool of blockedTools) {
      if (event.toolName !== blockedTool.toolName) continue
      return { block: true, reason: blockedTool.reason }
    }
    if (event.toolName !== 'bash') return
    const command = getBashCommand(event.input)
    if (!command)
      return {
        block: true,
        reason: 'The `bash` tool was called without a command.',
      }
    const segmentResult = splitCommand(command)
    if (segmentResult.reason)
      return {
        block: true,
        reason: segmentResult.reason,
      }
    const segments = segmentResult.segments ?? []
    for (const segment of segments) {
      const tokens = tokenizeCommand(segment)
      if (!tokens)
        return {
          block: true,
          reason: 'Unterminated quotes are blocked in the `bash` tool.',
        }
      const reason = getForbiddenReason(tokens)
      if (!reason) continue
      return { block: true, reason }
    }
  })
}
