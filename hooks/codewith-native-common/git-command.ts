import { dirname, isAbsolute, join, resolve, sep } from "path";
import { homedir } from "os";

export interface GitCommandInfo {
  action: "commit" | "push";
  targetCwd: string;
  gitDir?: string;
  workTree?: string;
}

// `$( ... )` and backtick substitutions are one operand of the surrounding command:
// their inner `;`, `|` and whitespace are not separators. Tokenizing them atomically is
// what lets the expansion-collapse rule below see `$(cmd)/*` as a single target token.
// If a substitution is left unterminated the command is malformed, so both tokenizers
// re-run with substitution tracking disabled rather than swallow the rest of the input.
function splitShellSegmentsPass(
  command: string,
  atomicSubstitutions: boolean
): { segments: string[]; isolation: boolean[]; depths: number[]; groups: number[]; piped: boolean[]; shortCircuit: boolean[]; unterminated: boolean } {
  const segments: string[] = [];
  const isolation: boolean[] = [];
  const depths: number[] = [];
  const groups: number[] = [];
  const pipedFlags: boolean[] = [];
  const shortCircuitFlags: boolean[] = [];
  let precededByShortCircuit = false;
  let current = "";
  let quote: "'" | '"' | null = null;
  let escaped = false;
  let substitutionDepth = 0;
  let substitutionQuote: "'" | '"' | null = null;
  let inBacktick = false;
  let parenDepth = 0;
  let pipedFromPrevious = false;
  // Every `(` opens a NEW shell. Two siblings are both depth 1 but are different processes,
  // so depth alone cannot identify a frame.
  let groupCounter = 0;
  const groupStack: number[] = [0];

  const flush = (nextSeparator: string | null) => {
    if (current.trim()) {
      segments.push(current.trim());
      // A stage of a pipeline runs in its own process, as does anything inside `( … )`.
      isolation.push(parenDepth > 0 || pipedFromPrevious || nextSeparator === "|");
      depths.push(parenDepth);
      groups.push(groupStack[groupStack.length - 1] ?? 0);
      pipedFlags.push(pipedFromPrevious || nextSeparator === "|");
      shortCircuitFlags.push(precededByShortCircuit);
    }
    current = "";
    pipedFromPrevious = nextSeparator === "|";
  };

  for (let i = 0; i < command.length; i += 1) {
    const ch = command[i];
    if (escaped) {
      current += ch;
      escaped = false;
      continue;
    }
    if (ch === "\\" && quote !== "'") {
      escaped = true;
      current += ch;
      continue;
    }
    if (atomicSubstitutions && substitutionDepth > 0) {
      current += ch;
      // Quotes inside the body are tracked so a quoted paren is not read as structure.
      if (substitutionQuote) {
        if (ch === substitutionQuote) substitutionQuote = null;
      } else if (ch === "'" || ch === '"') {
        substitutionQuote = ch;
      } else if (ch === "(") substitutionDepth += 1;
      else if (ch === ")") substitutionDepth -= 1;
      continue;
    }
    if (atomicSubstitutions && inBacktick) {
      current += ch;
      if (ch === "`") inBacktick = false;
      continue;
    }
    if (atomicSubstitutions && quote !== "'" && ch === "$" && command[i + 1] === "(") {
      current += "$(";
      substitutionDepth = 1;
      i += 1;
      continue;
    }
    if (atomicSubstitutions && quote !== "'" && ch === "`") {
      current += ch;
      inBacktick = true;
      continue;
    }
    if (quote) {
      current += ch;
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === "'" || ch === "\"") {
      quote = ch;
      current += ch;
      continue;
    }
    if (ch === ";" || ch === "|" || ch === "&" || ch === "(" || ch === ")" || ch === "\n") {
      const doubled = (ch === "|" || ch === "&") && command[i + 1] === ch;
      // `||` and `&&` are sequencing, not a pipe.
      flush(ch === "|" && !doubled ? "|" : null);
      // `a && X=1` and `a || X=1` run X= only if the left side decided so.
      precededByShortCircuit = doubled && (ch === "|" || ch === "&");
      if (ch === "(") {
        parenDepth += 1;
        groupCounter += 1;
        groupStack.push(groupCounter);
      } else if (ch === ")") {
        parenDepth = Math.max(0, parenDepth - 1);
        if (groupStack.length > 1) groupStack.pop();
      }
      if (doubled) i += 1;
      continue;
    }
    current += ch;
  }

  flush(null);
  return { segments, isolation, depths, groups, piped: pipedFlags, shortCircuit: shortCircuitFlags, unterminated: substitutionDepth > 0 || inBacktick };
}

export function splitShellSegments(command: string): string[] {
  return splitShellSegmentsDetailed(command).map((segment) => segment.text);
}

/** A segment plus whether a `cd` in it changes the working directory of later segments. */
export interface ShellSegment {
  text: string;
  /** Subshell nesting depth of this segment; a `cd` applies to this depth and deeper. */
  depth: number;
  /** Identity of the subshell this segment runs in; siblings at one depth differ. */
  group: number;
  /** This segment is a pipeline stage, so its `cd` affects nothing outside the stage. */
  piped: boolean;
  /** Reached only via `&&` / `||`, so whether it ran depends on the previous command. */
  shortCircuit: boolean;
  /**
   * True when the segment runs in a subshell `( … )` or as a stage of a pipeline. A `cd`
   * there affects only that child process, so treating it as persistent silently moves the
   * guard's idea of cwd away from the directory the later `rm` actually runs in.
   */
  isolated: boolean;
}

const segmentCache = new Map<string, ShellSegment[]>();
const MAX_SEGMENT_CACHE = 16;

export function splitShellSegmentsDetailed(command: string): ShellSegment[] {
  const cached = segmentCache.get(command);
  if (cached) return cached;
  const computed = splitShellSegmentsUncached(command);
  if (segmentCache.size >= MAX_SEGMENT_CACHE) {
    const oldest = segmentCache.keys().next().value;
    if (oldest !== undefined) segmentCache.delete(oldest);
  }
  segmentCache.set(command, computed);
  return computed;
}

function splitShellSegmentsUncached(command: string): ShellSegment[] {
  const pass = splitShellSegmentsPass(command, true);
  const chosen = pass.unterminated ? splitShellSegmentsPass(command, false) : pass;
  return chosen.segments.map((text, index) => ({
    text,
    depth: chosen.depths[index] ?? 0,
    group: chosen.groups[index] ?? 0,
    piped: chosen.piped[index] ?? false,
    shortCircuit: chosen.shortCircuit[index] ?? false,
    isolated: chosen.isolation[index] ?? false,
  }));
}

function shellWordsPass(segment: string, atomicSubstitutions: boolean): { words: string[]; unterminated: boolean } {
  const words: string[] = [];
  let current = "";
  let quote: "'" | '"' | null = null;
  let escaped = false;
  let substitutionDepth = 0;
  let substitutionQuote: "'" | '"' | null = null;
  let inBacktick = false;

  const push = () => {
    if (current.length > 0) {
      words.push(current);
      current = "";
    }
  };

  for (let i = 0; i < segment.length; i += 1) {
    const ch = segment[i];
    if (escaped) {
      // A backslash before a glob metacharacter is part of the pattern, not shell quoting.
      current += /[[\]*?]/.test(ch) ? `\\${ch}` : ch;
      escaped = false;
      continue;
    }
    // Substitution bodies are copied verbatim - quotes, spaces AND backslashes. Consuming the
    // escape here strips the backslash, and findExpansions then re-counts `\'` or `\(` as
    // structure on the de-escaped text, which reopened the bug the quote fix closed.
    if (atomicSubstitutions && substitutionDepth > 0) {
      current += ch;
      if (ch === "\\") {
        current += segment[i + 1] ?? "";
        i += 1;
      } else if (substitutionQuote) {
        if (ch === substitutionQuote) substitutionQuote = null;
      } else if (ch === "'" || ch === '"') {
        substitutionQuote = ch;
      } else if (ch === "(") substitutionDepth += 1;
      else if (ch === ")") substitutionDepth -= 1;
      continue;
    }
    if (atomicSubstitutions && inBacktick) {
      current += ch;
      if (ch === "\\") { current += segment[i + 1] ?? ""; i += 1; }
      else if (ch === "`") inBacktick = false;
      continue;
    }
    if (ch === "\\" && quote !== "'") {
      escaped = true;
      continue;
    }
    if (atomicSubstitutions && quote !== "'" && ch === "$" && segment[i + 1] === "(") {
      current += "$(";
      substitutionDepth = 1;
      i += 1;
      continue;
    }
    if (atomicSubstitutions && quote !== "'" && ch === "`") {
      current += ch;
      inBacktick = true;
      continue;
    }
    if (quote) {
      if (ch === quote) {
        quote = null;
      } else {
        current += ch;
      }
      continue;
    }
    if (ch === "'" || ch === "\"") {
      quote = ch;
      continue;
    }
    if (/\s/.test(ch)) {
      push();
      continue;
    }
    current += ch;
  }
  push();
  return { words, unterminated: substitutionDepth > 0 || inBacktick };
}

export function shellWords(segment: string): string[] {
  const atomic = shellWordsPass(segment, true);
  if (!atomic.unterminated) return atomic.words;
  return shellWordsPass(segment, false).words;
}

export function expandHome(path: string): string {
  // One home for every form. `~` used homedir() while `$HOME` and every protected root used
  // process.env.HOME, so wherever the two differ the target and the rule were resolved against
  // different directories and `rm -rf ~/.hasna` missed the ~/.hasna rule entirely.
  const home = process.env.HOME || homedir();
  if (path === "~") return home;
  if (path.startsWith("~/")) return join(home, path.slice(2));
  if (path === "$HOME" || path === "${HOME}") return home;
  if (path.startsWith("$HOME/")) return join(home, path.slice("$HOME/".length));
  if (path.startsWith("${HOME}/")) return join(home, path.slice("${HOME}/".length));
  return path;
}

export function resolveFrom(cwd: string, path: string): string {
  const expanded = expandHome(path);
  return isAbsolute(expanded) ? resolve(expanded) : resolve(cwd, expanded);
}

export function optionValue(token: string, next: string | undefined, option: string): { value?: string; consumed: number } | null {
  if (token === option) return { value: next, consumed: next === undefined ? 1 : 2 };
  if (token.startsWith(`${option}=`)) return { value: token.slice(option.length + 1), consumed: 1 };
  return null;
}

export function shortOptionValue(token: string, next: string | undefined, option: string): { value?: string; consumed: number } | null {
  if (token === option) return { value: next, consumed: next === undefined ? 1 : 2 };
  if (token.startsWith(option) && token.length > option.length) return { value: token.slice(option.length), consumed: 1 };
  return null;
}

export function isGitToken(token: string): boolean {
  return token === "git" || token.endsWith("/git");
}

function gitInfoFromTokens(tokens: string[], baseCwd: string): GitCommandInfo | null {
  const gitIndex = tokens.findIndex(isGitToken);
  if (gitIndex === -1) return null;

  let i = gitIndex + 1;
  let cwd = resolve(baseCwd);
  let gitDir: string | undefined;
  let workTree: string | undefined;

  while (i < tokens.length) {
    const token = tokens[i];

    const cDir = shortOptionValue(token, tokens[i + 1], "-C");
    if (cDir) {
      if (cDir.value) cwd = resolveFrom(cwd, cDir.value);
      i += cDir.consumed;
      continue;
    }

    const config = shortOptionValue(token, tokens[i + 1], "-c");
    if (config) {
      i += config.consumed;
      continue;
    }

    const gitDirValue = optionValue(token, tokens[i + 1], "--git-dir");
    if (gitDirValue) {
      if (gitDirValue.value) gitDir = resolveFrom(cwd, gitDirValue.value);
      i += gitDirValue.consumed;
      continue;
    }

    const workTreeValue = optionValue(token, tokens[i + 1], "--work-tree");
    if (workTreeValue) {
      if (workTreeValue.value) workTree = resolveFrom(cwd, workTreeValue.value);
      i += workTreeValue.consumed;
      continue;
    }

    const namespaceValue = optionValue(token, tokens[i + 1], "--namespace");
    if (namespaceValue) {
      i += namespaceValue.consumed;
      continue;
    }

    const execPathValue = optionValue(token, tokens[i + 1], "--exec-path");
    if (execPathValue) {
      i += execPathValue.consumed;
      continue;
    }

    if (token === "--config-env") {
      i += tokens[i + 1] === undefined ? 1 : 2;
      continue;
    }

    if (token === "--") {
      i += 1;
      continue;
    }

    if (token.startsWith("-")) {
      i += 1;
      continue;
    }

    if (token === "commit" || token === "push") {
      const targetCwd = workTree || (gitDir ? (gitDir.endsWith(`${sep}.git`) || gitDir.endsWith("/.git") ? dirname(gitDir) : gitDir) : cwd);
      return { action: token, targetCwd, ...(gitDir ? { gitDir } : {}), ...(workTree ? { workTree } : {}) };
    }
    return null;
  }

  return null;
}

export function gitCommandInfo(command: string, baseCwd: string = process.cwd()): GitCommandInfo | null {
  for (const segment of splitShellSegments(command)) {
    const tokens = shellWords(segment);
    const info = gitInfoFromTokens(tokens, baseCwd);
    if (info) return info;
  }
  return null;
}

export function isGitCommitOrPush(command: string): boolean {
  return gitCommandInfo(command) !== null;
}

export function isGitPushOrCommitCommand(command: string): "commit" | "push" | null {
  return gitCommandInfo(command)?.action || null;
}

export function isRiskyOperation(command: string): boolean {
  const patterns = [
    /(^|[;&|()\s])(?:npm|pnpm|yarn|bun)\s+publish\b/,
    /(^|[;&|()\s])gh\s+release\b/,
    /(^|[;&|()\s])terraform\s+(?:apply|destroy|import)\b/,
    /(^|[;&|()\s])tofu\s+(?:apply|destroy|import)\b/,
    /(^|[;&|()\s])kubectl\s+(?:apply|delete|rollout|scale)\b/,
    /(^|[;&|()\s])aws\s+[^;&|]*\bdeploy\b/,
    /(^|[;&|()\s])(?:drizzle|prisma|sequelize|knex)\s+[^;&|]*\bmigrat(?:e|ion)\b/,
    /(^|[;&|()\s])(?:migrate|migration)\b/,
    /\bdeploy(?:ment)?\b/,
  ];
  return patterns.some((pattern) => pattern.test(command));
}
