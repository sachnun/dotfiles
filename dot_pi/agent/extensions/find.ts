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

interface Word {
  value: string;
  subs: readonly string[];
}

interface Token {
  kind: 'word' | 'op';
  value: string;
  subs: readonly string[];
}

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

function isRedirectionOp(value: string): boolean {
  return value.startsWith('<') || value.startsWith('>') || /^\d+[<>]/.test(value);
}

function redirArity(op: string): number {
  return op.includes('&') ? 0 : 1;
}

function isWhitespace(c: string): boolean {
  return c === ' ' || c === '\t' || c === '\n' || c === '\r';
}

function isWordChar(c: string): boolean {
  return (
    !isWhitespace(c) &&
    c !== '|' &&
    c !== '&' &&
    c !== ';' &&
    c !== '(' &&
    c !== ')' &&
    c !== '<' &&
    c !== '>'
  );
}

function scanQuoted(src: string, start: number, quote: string, escapes: boolean): number {
  let i = start + 1;
  while (i < src.length) {
    const c = src[i];
    if (escapes && c === '\\') {
      i += 2;
      continue;
    }
    if (c === quote) return i + 1;
    i++;
  }
  throw new Error('unterminated quote');
}

function scanBacktick(src: string, start: number): number {
  let i = start + 1;
  while (i < src.length) {
    const c = src[i];
    if (c === '\\') {
      i += 2;
      continue;
    }
    if (c === '`') return i + 1;
    i++;
  }
  throw new Error('unterminated backtick');
}

function scanBraces(src: string, start: number): number {
  let i = start;
  let depth = 1;
  while (i < src.length) {
    const c = src[i];
    if (c === '\\') {
      i += 2;
      continue;
    }
    if (c === "'") {
      i = scanQuoted(src, i, "'", false);
      continue;
    }
    if (c === '"') {
      i = scanQuoted(src, i, '"', true);
      continue;
    }
    if (c === '`') {
      i = scanBacktick(src, i);
      continue;
    }
    if (c === '$' && src[i + 1] === '{') {
      depth++;
      i += 2;
      continue;
    }
    if (c === '}') {
      depth--;
      i++;
      if (depth === 0) return i;
      continue;
    }
    i++;
  }
  throw new Error('unterminated parameter expansion');
}

function scanArithmetic(src: string, start: number): number {
  let i = start + 2;
  let depth = 1;
  while (i < src.length) {
    const c = src[i];
    if (c === '\\') {
      i += 2;
      continue;
    }
    if (c === "'") {
      i = scanQuoted(src, i, "'", false);
      continue;
    }
    if (c === '"') {
      i = scanQuoted(src, i, '"', true);
      continue;
    }
    if (c === '`') {
      i = scanBacktick(src, i);
      continue;
    }
    if (c === '$' && src[i + 1] === '(' && src[i + 2] === '(') {
      depth++;
      i += 3;
      continue;
    }
    if (c === ')' && src[i + 1] === ')') {
      depth--;
      i += 2;
      if (depth === 0) return i;
      continue;
    }
    i++;
  }
  throw new Error('unterminated arithmetic expansion');
}

function scanCommandSubstitution(src: string, start: number): number {
  let i = start + 2;
  let depth = 1;
  while (i < src.length) {
    const c = src[i];
    if (c === '\\') {
      i += 2;
      continue;
    }
    if (c === "'") {
      i = scanQuoted(src, i, "'", false);
      continue;
    }
    if (c === '"') {
      i = scanQuoted(src, i, '"', true);
      continue;
    }
    if (c === '`') {
      i = scanBacktick(src, i);
      continue;
    }
    if (c === '$' && src[i + 1] === '(') {
      if (src[i + 2] === '(') {
        i = scanArithmetic(src, i);
        continue;
      }
      depth++;
      i += 2;
      continue;
    }
    if (c === '$' && src[i + 1] === '{') {
      i = scanBraces(src, i);
      continue;
    }
    if (c === ')') {
      depth--;
      i++;
      if (depth === 0) return i;
      continue;
    }
    i++;
  }
  throw new Error('unterminated command substitution');
}

function scanParenGroup(src: string, start: number): number {
  let i = start + 1;
  let depth = 1;
  while (i < src.length) {
    const c = src[i];
    if (c === '\\') {
      i += 2;
      continue;
    }
    if (c === "'") {
      i = scanQuoted(src, i, "'", false);
      continue;
    }
    if (c === '"') {
      i = scanQuoted(src, i, '"', true);
      continue;
    }
    if (c === '`') {
      i = scanBacktick(src, i);
      continue;
    }
    if (c === '$' && src[i + 1] === '(') {
      if (src[i + 2] === '(') {
        i = scanArithmetic(src, i);
        continue;
      }
      i = scanCommandSubstitution(src, i);
      continue;
    }
    if (c === '$' && src[i + 1] === '{') {
      i = scanBraces(src, i);
      continue;
    }
    if (c === '(') {
      depth++;
      i++;
      continue;
    }
    if (c === ')') {
      depth--;
      i++;
      if (depth === 0) return i;
      continue;
    }
    i++;
  }
  throw new Error('unterminated group');
}

interface LexResult {
  token: Token;
  next: number;
  heredoc: boolean;
}

function matchRedirection(src: string, start: number): { op: string; next: number } | null {
  let i = start;
  if (/\d/.test(src[i])) {
    while (i < src.length && /\d/.test(src[i])) i++;
    if (src[i] !== '<' && src[i] !== '>') return null;
  }
  const first = src[i];
  if (first !== '<' && first !== '>') return null;
  i++;
  let op = first;
  if (first === '<') {
    if (src[i] === '<') {
      if (src[i + 1] === '<') {
        op = '<<<';
        i += 2;
        return { op, next: i };
      }
      if (src[i + 1] === '-') {
        op = '<<-';
        i += 2;
        return { op, next: i };
      }
      op = '<<';
      i += 1;
      return { op, next: i };
    }
    if (src[i] === '&') {
      op = '<&';
      i += 1;
    } else if (src[i] === '>') {
      op = '<>';
      i += 1;
    }
  } else {
    if (src[i] === '>') {
      op = '>>';
      i += 1;
    } else if (src[i] === '&') {
      op = '>&';
      i += 1;
    } else if (src[i] === '|') {
      op = '>|';
      i += 1;
    }
  }
  let fdPrefix = '';
  let k = start;
  while (k < i && /\d/.test(src[k])) {
    fdPrefix += src[k];
    k++;
  }
  if (op.includes('&')) {
    let j = i;
    while (j < src.length && !isWhitespace(src[j]) && src[j] !== '|' && src[j] !== ';' && src[j] !== '(' && src[j] !== ')' && src[j] !== '<' && src[j] !== '>') {
      j++;
    }
    return { op: fdPrefix + op + src.slice(i, j), next: j };
  }
  return { op: fdPrefix + op, next: i };
}

function skipHeredocBody(
  src: string,
  afterDelimiter: number,
  delimiter: string,
  tabsAllowed: boolean,
): number {
  let i = afterDelimiter;
  while (i < src.length && src[i] !== '\n') i++;
  if (i >= src.length) return src.length;
  i++;
  while (i < src.length) {
    const lineEnd = src.indexOf('\n', i);
    const end = lineEnd === -1 ? src.length : lineEnd;
    let line = src.slice(i, end);
    if (line.endsWith('\r')) line = line.slice(0, -1);
    const stripped = tabsAllowed ? line.replace(/^\t+/, '') : line;
    if (stripped === delimiter) return lineEnd === -1 ? src.length : lineEnd + 1;
    i = end + 1;
  }
  return src.length;
}

function lexAt(src: string, start: number): LexResult | null {
  let i = start;
  while (i < src.length && (src[i] === ' ' || src[i] === '\t' || src[i] === '\r')) i++;
  if (i >= src.length) return null;
  const c = src[i];

  if (c === '#') {
    while (i < src.length && src[i] !== '\n') i++;
    return { token: { kind: 'op', value: ';', subs: [] }, next: i, heredoc: false };
  }

  if (c === '<' || c === '>') {
    if (src[i + 1] === '(') {
      const end = scanParenGroup(src, i + 1);
      return {
        token: {
          kind: 'word',
          value: src.slice(i, end),
          subs: [src.slice(i + 2, end - 1)],
        },
        next: end,
        heredoc: false,
      };
    }
    const redir = matchRedirection(src, i);
    if (redir !== null) {
      return {
        token: { kind: 'op', value: redir.op, subs: [] },
        next: redir.next,
        heredoc: redir.op === '<<' || redir.op === '<<-' || /^\d+<<$/.test(redir.op),
      };
    }
  }

  if (c === '|' || c === '&' || c === ';' || c === '(' || c === ')' || c === '\n') {
    let op = c;
    if (c === '|' && src[i + 1] === '|') op = '||';
    else if (c === '|' && src[i + 1] === '&') op = '|&';
    else if (c === '&' && src[i + 1] === '&') op = '&&';
    else if (c === ';') {
      if (src[i + 1] === ';' && src[i + 2] === '&') op = ';;&';
      else if (src[i + 1] === ';') op = ';;';
      else if (src[i + 1] === '&') op = ';&';
    }
    return {
      token: { kind: 'op', value: op, subs: [] },
      next: i + op.length,
      heredoc: false,
    };
  }

  if (/\d/.test(c)) {
    let j = i;
    while (j < src.length && /\d/.test(src[j])) j++;
    if (src[j] === '<' || src[j] === '>') {
      const redir = matchRedirection(src, i);
      if (redir !== null) {
        return {
          token: { kind: 'op', value: redir.op, subs: [] },
          next: redir.next,
          heredoc: /^\d+<<$/.test(redir.op),
        };
      }
    }
  }

  const value: string[] = [];
  const subs: string[] = [];
  let q: "'" | '"' | null = null;
  let j = i;
  while (j < src.length) {
    const ch = src[j];
    if (q === "'") {
      if (ch === "'") {
        q = null;
        j++;
        continue;
      }
      value.push(ch);
      j++;
      continue;
    }
    if (q === '"') {
      if (ch === '\\') {
        const next = src[j + 1];
        if (next === '\n') {
          j += 2;
          continue;
        }
        if (next === '"' || next === '\\' || next === '$' || next === '`') {
          value.push(next);
          j += 2;
          continue;
        }
        value.push('\\');
        value.push(next);
        j += 2;
        continue;
      }
      if (ch === '"') {
        q = null;
        j++;
        continue;
      }
      if (ch === '$' && src[j + 1] === '(') {
        if (src[j + 2] === '(') {
          const end = scanArithmetic(src, j);
          value.push(src.slice(j, end));
          j = end;
          continue;
        }
        const end = scanCommandSubstitution(src, j);
        value.push(src.slice(j, end));
        subs.push(src.slice(j + 2, end - 1));
        j = end;
        continue;
      }
      if (ch === '$' && src[j + 1] === '`') {
        j++;
        continue;
      }
      if (ch === '`') {
        const end = scanBacktick(src, j);
        value.push(src.slice(j, end));
        subs.push(src.slice(j + 1, end - 1));
        j = end;
        continue;
      }
      value.push(ch);
      j++;
      continue;
    }
    if (!isWordChar(ch)) break;
    if (ch === '\\') {
      j++;
      if (j >= src.length) throw new Error('trailing backslash');
      if (src[j] === '\n') {
        j++;
        continue;
      }
      value.push(src[j]);
      j++;
      continue;
    }
    if (ch === "'") {
      q = "'";
      j++;
      continue;
    }
    if (ch === '"') {
      q = '"';
      j++;
      continue;
    }
    if (ch === '$') {
      const next = src[j + 1];
      if (next === '(') {
        if (src[j + 2] === '(') {
          const end = scanArithmetic(src, j);
          value.push(src.slice(j, end));
          j = end;
          continue;
        }
        const end = scanCommandSubstitution(src, j);
        value.push(src.slice(j, end));
        subs.push(src.slice(j + 2, end - 1));
        j = end;
        continue;
      }
      if (next === '{') {
        const end = scanBraces(src, j);
        value.push(src.slice(j, end));
        j = end;
        continue;
      }
      if (next === "'") {
        const end = scanQuoted(src, j + 1, "'", true);
        value.push(src.slice(j, end));
        j = end;
        continue;
      }
      if (next === '"') {
        value.push('$');
        j++;
        continue;
      }
      if (next === '`') {
        const end = scanBacktick(src, j + 1);
        value.push(src.slice(j, end));
        subs.push(src.slice(j + 2, end - 1));
        j = end;
        continue;
      }
      value.push('$');
      j++;
      if (j < src.length && /[A-Za-z0-9_]/.test(src[j])) {
        while (j < src.length && /[A-Za-z0-9_]/.test(src[j])) {
          value.push(src[j]);
          j++;
        }
      } else if (/[@*#?!$^-]/.test(src[j])) {
        value.push(src[j]);
        j++;
      }
      continue;
    }
    if (ch === '`') {
      const end = scanBacktick(src, j);
      value.push(src.slice(j, end));
      subs.push(src.slice(j + 1, end - 1));
      j = end;
      continue;
    }
    value.push(ch);
    j++;
  }
  if (q !== null) throw new Error('unterminated quote');
  if (value.length === 0) throw new Error('empty word');
  return {
    token: { kind: 'word', value: value.join(''), subs },
    next: j,
    heredoc: false,
  };
}

function tokenize(source: string): Token[] | null {
  const tokens: Token[] = [];
  let i = 0;
  let pendingHeredoc: { tabsAllowed: boolean } | null = null;
  try {
    while (i < source.length) {
      const result = lexAt(source, i);
      if (result === null) break;
      i = result.next;
      if (pendingHeredoc !== null) {
        if (result.token.kind === 'word') {
          const delimiter = result.token.value;
          const tabsAllowed = pendingHeredoc.tabsAllowed;
          pendingHeredoc = null;
          i = skipHeredocBody(source, i, delimiter, tabsAllowed);
        } else if (result.token.kind === 'op' && isRedirectionOp(result.token.value)) {
          pendingHeredoc = null;
        }
      }
      if (result.heredoc) {
        pendingHeredoc = { tabsAllowed: result.token.value.includes('-') };
      }
      tokens.push(result.token);
    }
  } catch {
    return null;
  }
  return tokens;
}

function findMatchingParen(tokens: readonly Token[], open: number): number {
  let depth = 0;
  for (let i = open; i < tokens.length; i++) {
    const t = tokens[i];
    if (t.kind !== 'op') continue;
    if (t.value === '(') depth++;
    else if (t.value === ')') {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

function collectCommand(tokens: readonly Token[], start: number, found: Map<string, string>): number {
  const n = tokens.length;
  let j = start;
  while (j < n) {
    const t = tokens[j];
    if (t.kind === 'op') {
      if (isRedirectionOp(t.value)) {
        j += redirArity(t.value) + 1;
        continue;
      }
      break;
    }
    if (ASSIGNMENT_PATTERN.test(t.value)) {
      j++;
      continue;
    }
    if (t.value === '!' ) {
      j++;
      continue;
    }
    if (t.value === 'time') {
      j++;
      if (tokens[j]?.kind === 'word' && tokens[j].value === '-p') j++;
      continue;
    }
    break;
  }
  const nameToken = tokens[j];
  if (nameToken === undefined || nameToken.kind !== 'word') return j;
  const name = nameToken.value;
  j++;
  if (tokens[j]?.kind === 'op' && tokens[j].value === '(') return j;
  const words: Word[] = [];
  while (j < n) {
    const t = tokens[j];
    if (t.kind === 'op') {
      if (isRedirectionOp(t.value)) {
        j += redirArity(t.value) + 1;
        continue;
      }
      break;
    }
    words.push({ value: t.value, subs: t.subs });
    j++;
  }
  checkInvocation(name, words, found);
  return j;
}

function processTokens(tokens: readonly Token[], found: Map<string, string>): void {
  let i = 0;
  const n = tokens.length;
  while (i < n) {
    const t = tokens[i];
    if (t.kind === 'op' && t.value === '(') {
      const prev = i > 0 ? tokens[i - 1] : null;
      const prevIsRealCommand =
        prev !== null &&
        prev.kind === 'word' &&
        prev.value !== '!' &&
        prev.value !== 'time' &&
        prev.value !== '-p' &&
        !ASSIGNMENT_PATTERN.test(prev.value);
      const close = findMatchingParen(tokens, i);
      if (close === -1) return;
      if (!prevIsRealCommand) processTokens(tokens.slice(i + 1, close), found);
      i = close + 1;
      continue;
    }
    if (t.kind === 'op') {
      if (isRedirectionOp(t.value)) {
        i += redirArity(t.value) + 1;
        continue;
      }
      i++;
      continue;
    }
    if (t.kind === 'word') {
      i = collectCommand(tokens, i, found);
      continue;
    }
    i++;
  }
}

function walkWordsForSubstitutions(words: readonly Word[], found: Map<string, string>): void {
  for (const word of words) {
    for (const src of word.subs) walkScriptSource(src, found);
  }
}

function walkScriptSource(source: string, found: Map<string, string>): void {
  const tokens = tokenize(source);
  if (tokens === null) return;
  processTokens(tokens, found);
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

function findBlockableInvocations(command: string): BlockableInvocation[] {
  const tokens = tokenize(command);
  if (tokens === null) return [];

  const found = new Map<string, string>();
  processTokens(tokens, found);
  return [...found.entries()].map(([blockedCommand, replacement]) => ({
    command: blockedCommand,
    replacement,
  }));
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