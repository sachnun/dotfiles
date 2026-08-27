import { parse } from 'unbash';
import type { Command, Node, ParseError, Script, Word, WordPart } from 'unbash';
import { isToolCallEventType, type ExtensionAPI } from '@earendil-works/pi-coding-agent';

interface BlockableInvocation {
  command: string;
  replacement: string;
}

const SUBSTITUTION_TABLE: Readonly<Record<string, string>> = {
  find: 'fd',
  grep: 'rg',
  egrep: 'rg',
  fgrep: 'rg',
  zgrep: 'rg',
};

const ASSIGNMENT_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*=/;

const EXEC_TERMINATORS: ReadonlySet<string> = new Set([';', '\\;', '+']);

interface PassthroughWrapperSpec {
  kind: 'passthrough';
  flagsWithArg: ReadonlySet<string>;
  allowAssignments: boolean;
}

interface FlagWrapperSpec {
  kind: 'flag';
  flag: string;
}

interface ExecWrapperSpec {
  kind: 'exec';
  keywords: ReadonlySet<string>;
  requiresTerminator: boolean;
}

type WrapperSpec = PassthroughWrapperSpec | FlagWrapperSpec | ExecWrapperSpec;

const WRAPPER_SPECS: Readonly<Record<string, WrapperSpec>> = {
  sudo: {
    kind: 'passthrough',
    flagsWithArg: new Set(['-u', '-g', '-p', '-U', '-r', '-t', '-T', '-C']),
    allowAssignments: false,
  },
  xargs: {
    kind: 'passthrough',
    flagsWithArg: new Set(['-I', '-n', '-P', '-s', '-a', '-d', '-E', '-L', '-l']),
    allowAssignments: false,
  },
  nice: {
    kind: 'passthrough',
    flagsWithArg: new Set(['-n']),
    allowAssignments: false,
  },
  nohup: {
    kind: 'passthrough',
    flagsWithArg: new Set(),
    allowAssignments: false,
  },
  env: {
    kind: 'passthrough',
    flagsWithArg: new Set(['-u', '-C', '-S']),
    allowAssignments: true,
  },
  strace: {
    kind: 'passthrough',
    flagsWithArg: new Set(['-e', '-o', '-p', '-s', '-u', '-a', '-O']),
    allowAssignments: false,
  },
  bash: { kind: 'flag', flag: '-c' },
  sh: { kind: 'flag', flag: '-c' },
  zsh: { kind: 'flag', flag: '-c' },
  find: {
    kind: 'exec',
    keywords: new Set(['-exec', '-ok']),
    requiresTerminator: true,
  },
  fd: {
    kind: 'exec',
    keywords: new Set(['-x', '--exec', '-X', '--exec-batch']),
    requiresTerminator: false,
  },
};

interface Invocation {
  name: string;
  words: readonly Word[];
}

function isGitGrepExemption(name: string, words: readonly Word[]): boolean {
  if (name === 'git-grep') return true;
  return name === 'git' && words[0]?.value === 'grep';
}

function resolvePassthrough(
  spec: { flagsWithArg: ReadonlySet<string>; allowAssignments: boolean },
  words: readonly Word[],
): Invocation | undefined {
  let index = words.length;
  let skipNext = false;
  for (const [i, word] of words.entries()) {
    if (skipNext) {
      skipNext = false;
      continue;
    }
    const value = word.value;
    if (spec.allowAssignments && ASSIGNMENT_PATTERN.test(value)) continue;
    if (value.startsWith('-')) {
      skipNext = !value.includes('=') && spec.flagsWithArg.has(value);
      continue;
    }
    index = i;
    break;
  }

  const nameWord = words[index];
  if (nameWord === undefined) return undefined;
  return { name: nameWord.value, words: words.slice(index + 1) };
}

function resolveFlagWrapperScript(
  spec: { flag: string },
  words: readonly Word[],
): string | undefined {
  const flagIndex = words.findIndex((word) => word.value === spec.flag);
  if (flagIndex === -1) return undefined;
  return words[flagIndex + 1]?.value;
}

function resolveExecWrapper(
  spec: { keywords: ReadonlySet<string>; requiresTerminator: boolean },
  words: readonly Word[],
): Invocation | undefined {
  const keywordIndex = words.findIndex((word) => spec.keywords.has(word.value));
  if (keywordIndex === -1) return undefined;

  const start = keywordIndex + 1;
  let terminatorIndex = words.findIndex(
    (word, index) => index >= start && EXEC_TERMINATORS.has(word.value),
  );
  if (terminatorIndex === -1) {
    if (spec.requiresTerminator) return undefined;
    terminatorIndex = words.length;
  }

  const subWords = words.slice(start, terminatorIndex);
  const nameWord = subWords[0];
  if (nameWord === undefined) return undefined;
  return { name: nameWord.value, words: subWords.slice(1) };
}

function hasParseErrors(script: Script): boolean {
  const errors = (script as Script & { errors?: ParseError[] }).errors;
  return errors !== undefined && errors.length > 0;
}

function walkWordParts(parts: readonly WordPart[] | undefined, found: Map<string, string>): void {
  if (!parts) return;
  for (const part of parts) {
    if (part.type === 'CommandExpansion') {
      const script = part.script;
      if (script === undefined || hasParseErrors(script)) continue;
      for (const statement of script.commands) walk(statement, found);
    } else if (part.type === 'DoubleQuoted') {
      walkWordParts(part.parts, found);
    }
  }
}

function walkWordsForSubstitutions(words: readonly Word[], found: Map<string, string>): void {
  for (const word of words) walkWordParts(word.parts, found);
}

function walkScriptSource(source: string, found: Map<string, string>): void {
  try {
    const script = parse(source);
    if (script.errors && script.errors.length > 0) return;
    for (const statement of script.commands) walk(statement, found);
  } catch {
    // Fail open: this nested script contributes nothing.
  }
}

function handleWrapper(spec: WrapperSpec, words: readonly Word[], found: Map<string, string>): void {
  switch (spec.kind) {
    case 'passthrough': {
      const sub = resolvePassthrough(spec, words);
      if (sub) checkInvocation(sub.name, sub.words, found);
      return;
    }
    case 'flag': {
      const script = resolveFlagWrapperScript(spec, words);
      if (script !== undefined) walkScriptSource(script, found);
      return;
    }
    case 'exec': {
      const sub = resolveExecWrapper(spec, words);
      if (sub) checkInvocation(sub.name, sub.words, found);
      return;
    }
  }
}

function checkInvocation(name: string, words: readonly Word[], found: Map<string, string>): void {
  if (isGitGrepExemption(name, words)) return;

  const replacement = SUBSTITUTION_TABLE[name];
  if (replacement !== undefined) found.set(name, replacement);

  const wrapper = WRAPPER_SPECS[name];
  if (wrapper !== undefined) handleWrapper(wrapper, words, found);

  walkWordsForSubstitutions(words, found);
}

function checkCommand(command: Command, found: Map<string, string>): void {
  const name = command.name?.value;
  if (name === undefined) return;

  checkInvocation(name, command.suffix, found);
}

function walk(node: Node, found: Map<string, string>): void {
  switch (node.type) {
    case 'Statement':
      walk(node.command, found);
      return;
    case 'Pipeline':
    case 'AndOr':
      for (const child of node.commands) walk(child, found);
      return;
    case 'Subshell':
      for (const statement of node.body.commands) walk(statement, found);
      return;
    case 'Command':
      checkCommand(node, found);
      return;
    default:
      return;
  }
}

function findBlockableInvocations(command: string): BlockableInvocation[] {
  try {
    const script = parse(command);
    if (script.errors && script.errors.length > 0) return [];

    const found = new Map<string, string>();
    for (const statement of script.commands) walk(statement, found);
    return [...found.entries()].map(([blockedCommand, replacement]) => ({
      command: blockedCommand,
      replacement,
    }));
  } catch {
    return [];
  }
}

function buildBlockReason(invocations: BlockableInvocation[]): string {
  const parts = invocations.map((i) => `\`${i.command}\` (use \`${i.replacement}\` instead)`);
  return `Blocked: this command uses disallowed command(s): ${parts.join(', ')}.`;
}

export default function (pi: ExtensionAPI): void {
  pi.on('tool_call', (event) => {
    if (!isToolCallEventType('bash', event)) return undefined;

    const invocations = findBlockableInvocations(event.input.command);
    if (invocations.length === 0) return undefined;

    return { block: true, reason: buildBlockReason(invocations) };
  });
}
