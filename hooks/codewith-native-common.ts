import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, writeFileSync, writeSync } from "fs";
import { basename, dirname, isAbsolute, join, parse, relative, resolve, sep } from "path";
import { homedir, tmpdir } from "os";

export interface CodewithHookInput {
  session_id?: string;
  cwd?: string;
  hook_event_name?: string;
  model?: string;
  permission_mode?: string;
  source?: string;
  prompt?: string;
  tool_name?: string;
  tool_input?: Record<string, unknown>;
  tool_use_id?: string;
  transcript_path?: string | null;
  turn_id?: string;
  last_assistant_message?: string | null;
  stop_hook_active?: boolean;
  agent_id?: string;
  agent_type?: string;
  agent?: unknown;
  [key: string]: unknown;
}

export interface CodewithHookOutput {
  continue?: boolean;
  decision?: "approve" | "block";
  reason?: string;
  stopReason?: string;
  suppressOutput?: boolean;
  systemMessage?: string;
  hookSpecificOutput?: {
    hookEventName: "SessionStart" | "UserPromptSubmit" | "SubagentStart" | "PreToolUse";
    additionalContext?: string;
    permissionDecision?: "allow" | "deny" | "ask";
    permissionDecisionReason?: string;
    updatedInput?: unknown;
  };
}

export interface CommandResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

export function readInput(): CodewithHookInput {
  try {
    const raw = readFileSync(0, "utf-8").trim();
    if (!raw) return {};
    return JSON.parse(raw) as CodewithHookInput;
  } catch {
    return {};
  }
}

export function respond(output: CodewithHookOutput): void {
  // Written synchronously: `process.stdout.write` is async on a pipe, so a verdict
  // larger than the pipe buffer is silently truncated if the process exits before it
  // drains — and a truncated verdict is unparseable, so the caller sees no decision.
  const payload = `${JSON.stringify(output)}\n`;
  try {
    writeSync(1, payload);
  } catch {
    process.stdout.write(payload);
  }
}

export function warn(message: string): void {
  process.stderr.write(`[hooks] ${message}\n`);
}

export function cap(text: string, max = 6000): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}\n[truncated ${text.length - max} bytes]`;
}

export function commandExists(command: string, env: NodeJS.ProcessEnv = process.env): boolean {
  const pathValue = env.PATH || "";
  for (const dir of pathValue.split(":")) {
    if (!dir) continue;
    if (existsSync(join(dir, command))) return true;
  }
  return false;
}

export async function runCommand(
  argv: string[],
  options: { cwd?: string; timeoutMs?: number; env?: NodeJS.ProcessEnv } = {}
): Promise<CommandResult> {
  const timeoutMs = options.timeoutMs ?? 5000;
  const env = options.env ?? process.env;
  let proc: ReturnType<typeof Bun.spawn> | null = null;
  let timedOut = false;
  try {
    proc = Bun.spawn(argv, {
      cwd: options.cwd,
      env,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
    const timer = setTimeout(() => {
      timedOut = true;
      try { proc?.kill(); } catch {}
    }, timeoutMs);
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited.catch(() => null),
    ]);
    clearTimeout(timer);
    return { exitCode, stdout, stderr, timedOut };
  } catch (error) {
    return { exitCode: null, stdout: "", stderr: error instanceof Error ? error.message : String(error), timedOut };
  }
}

export function getCommand(input: CodewithHookInput): string {
  const command = input.tool_input?.command;
  return typeof command === "string" ? command : "";
}

export function isBashPreToolUse(input: CodewithHookInput): boolean {
  return input.hook_event_name === "PreToolUse" && input.tool_name === "Bash";
}

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
function splitShellSegmentsPass(command: string, atomicSubstitutions: boolean): { segments: string[]; unterminated: boolean } {
  const segments: string[] = [];
  let current = "";
  let quote: "'" | '"' | null = null;
  let escaped = false;
  let substitutionDepth = 0;
  let inBacktick = false;

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
      if (ch === "(") substitutionDepth += 1;
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
      if (current.trim()) segments.push(current.trim());
      current = "";
      if ((ch === "|" || ch === "&") && command[i + 1] === ch) i += 1;
      continue;
    }
    current += ch;
  }

  if (current.trim()) segments.push(current.trim());
  return { segments, unterminated: substitutionDepth > 0 || inBacktick };
}

function splitShellSegments(command: string): string[] {
  const atomic = splitShellSegmentsPass(command, true);
  if (!atomic.unterminated) return atomic.segments;
  return splitShellSegmentsPass(command, false).segments;
}

function shellWordsPass(segment: string, atomicSubstitutions: boolean): { words: string[]; unterminated: boolean } {
  const words: string[] = [];
  let current = "";
  let quote: "'" | '"' | null = null;
  let escaped = false;
  let substitutionDepth = 0;
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
      current += ch;
      escaped = false;
      continue;
    }
    // Substitution bodies are copied verbatim, quotes and spaces included: the raw text
    // is what emptyExpansionCollapse inspects.
    if (atomicSubstitutions && substitutionDepth > 0) {
      current += ch;
      if (ch === "(") substitutionDepth += 1;
      else if (ch === ")") substitutionDepth -= 1;
      continue;
    }
    if (atomicSubstitutions && inBacktick) {
      current += ch;
      if (ch === "`") inBacktick = false;
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

function shellWords(segment: string): string[] {
  const atomic = shellWordsPass(segment, true);
  if (!atomic.unterminated) return atomic.words;
  return shellWordsPass(segment, false).words;
}

function expandHome(path: string): string {
  const home = process.env.HOME || homedir();
  if (path === "~") return homedir();
  if (path.startsWith("~/")) return join(homedir(), path.slice(2));
  if (path === "$HOME" || path === "${HOME}") return home;
  if (path.startsWith("$HOME/")) return join(home, path.slice("$HOME/".length));
  if (path.startsWith("${HOME}/")) return join(home, path.slice("${HOME}/".length));
  return path;
}

function resolveFrom(cwd: string, path: string): string {
  const expanded = expandHome(path);
  return isAbsolute(expanded) ? resolve(expanded) : resolve(cwd, expanded);
}

function optionValue(token: string, next: string | undefined, option: string): { value?: string; consumed: number } | null {
  if (token === option) return { value: next, consumed: next === undefined ? 1 : 2 };
  if (token.startsWith(`${option}=`)) return { value: token.slice(option.length + 1), consumed: 1 };
  return null;
}

function shortOptionValue(token: string, next: string | undefined, option: string): { value?: string; consumed: number } | null {
  if (token === option) return { value: next, consumed: next === undefined ? 1 : 2 };
  if (token.startsWith(option) && token.length > option.length) return { value: token.slice(option.length), consumed: 1 };
  return null;
}

function isGitToken(token: string): boolean {
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

export interface DangerousOperationMatch {
  block: boolean;
  reason?: string;
  targetPath?: string;
  protectedPath?: string;
  protectedLabel?: string;
  operation?: string;
}

interface ProtectedPathRule {
  root: string;
  label: string;
  mode: "tree" | "root";
}

interface ProtectedPathContext {
  rules: ProtectedPathRule[];
  workspaceRoots: string[];
  currentManagedRepoRoot: string | null;
}

function splitPathList(value: unknown): string[] {
  if (typeof value === "string") return value.split(":").map((v) => v.trim()).filter(Boolean);
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => splitPathList(item));
}

function inputPathList(input: CodewithHookInput, ...keys: string[]): string[] {
  const out: string[] = [];
  for (const key of keys) out.push(...splitPathList(input[key]));
  return out;
}

function uniqueResolved(paths: string[], cwd: string): string[] {
  return [...new Set(paths.map((path) => resolveFrom(cwd, path)))];
}

function workspaceRootsFor(input: CodewithHookInput, cwd: string): string[] {
  const home = process.env.HOME || homedir();
  const candidates = [
    ...inputPathList(input, "workspace_roots", "workspaceRoots", "workspace_root", "workspaceRoot"),
    ...splitPathList(process.env.CODEWITH_WORKSPACE_ROOTS),
    ...splitPathList(process.env.HASNA_WORKSPACE_ROOTS),
    join(home, "workspace"),
    join(home, "Workspace"),
  ];
  return uniqueResolved(candidates, cwd);
}

function activeRootsFor(input: CodewithHookInput, cwd: string): string[] {
  const candidates = [
    ...inputPathList(input, "active_repo_roots", "activeRepoRoots", "active_worktree_roots", "activeWorktreeRoots"),
    ...splitPathList(process.env.HASNA_ACTIVE_REPO_ROOTS),
    ...splitPathList(process.env.HASNA_ACTIVE_WORKTREE_ROOTS),
  ];
  return uniqueResolved(candidates, cwd);
}

/**
 * Filesystem roots a recursive delete must never target wholesale: the FHS system
 * directories plus their macOS equivalents, and `/` itself.
 *
 * `/` is here because of the 2026-07-24 station02 incident: `rm -rf "$(bun pm cache)"/*`
 * ran as `rm -rf /*` after the substitution collapsed to empty, freed ~700 GB and
 * permanently destroyed one repository's only source copy. Every entry is matched in
 * "root" mode, so `rm -rf /usr` and `rm -rf /usr/*` block while `rm -rf /usr/local/lib/mine`
 * stays allowed - the guard is about wholesale wipes, not targeted deletes.
 *
 * `/tmp` is deliberately absent: scratch cleanup there is routine and bounded.
 * Machine-specific additions come from HASNA_PROTECTED_SYSTEM_ROOTS (colon-separated).
 */
export const SYSTEM_PROTECTED_ROOTS: readonly string[] = [
  "/",
  "/bin",
  "/boot",
  "/dev",
  "/etc",
  "/home",
  "/lib",
  "/lib32",
  "/lib64",
  "/libx32",
  "/opt",
  "/proc",
  "/root",
  "/run",
  "/sbin",
  "/srv",
  "/sys",
  "/usr",
  "/var",
  "/Applications",
  "/Library",
  "/System",
  "/Users",
  "/Volumes",
  "/private",
];

function systemProtectedRulesFor(cwd: string): ProtectedPathRule[] {
  const roots = uniqueResolved(
    [...SYSTEM_PROTECTED_ROOTS, ...splitPathList(process.env.HASNA_PROTECTED_SYSTEM_ROOTS)],
    cwd
  );
  return roots.map((root) => ({
    root,
    label: root === sep ? "filesystem root /" : `system root ${root}`,
    mode: "root" as const,
  }));
}

function hasnaDivisionRuleFor(target: string, workspaceRoot: string): ProtectedPathRule | null {
  const rel = relative(resolve(workspaceRoot), resolve(target));
  if (!rel || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return null;
  const parts = rel.split(sep).filter(Boolean);
  if (!parts[0]?.startsWith("hasna")) return null;
  if (parts.length === 1) {
    return { root: resolve(workspaceRoot, parts[0]), label: `Hasna division root ${parts[0]}`, mode: "root" };
  }
  if (parts.length === 2) {
    return { root: resolve(workspaceRoot, parts[0], parts[1]), label: `Hasna top-level scope ${parts[0]}/${parts[1]}`, mode: "root" };
  }
  return null;
}

async function protectedPathContextFor(input: CodewithHookInput, cwd: string): Promise<ProtectedPathContext> {
  const home = process.env.HOME || homedir();
  const rules: ProtectedPathRule[] = [
    // System roots first so a root wipe is reported as the root wipe it is, rather than as
    // whichever Hasna path happened to sit underneath it. Overlapping paths are deduplicated
    // below with the Hasna rule's more specific label winning.
    ...systemProtectedRulesFor(cwd),
    { root: join(home, ".hasna"), label: "Hasna state root ~/.hasna", mode: "tree" },
  ];
  const workspaceRoots = workspaceRootsFor(input, cwd);

  for (const root of workspaceRoots) {
    rules.push({ root, label: "workspace root", mode: "root" });
  }

  const repoRoot = await gitRepoRoot(cwd);
  if (repoRoot) rules.push({ root: repoRoot, label: "active repository root", mode: "root" });

  for (const root of activeRootsFor(input, cwd)) {
    rules.push({ root, label: "active repository or worktree root", mode: "root" });
  }

  const worktreesRoot = resolve(defaultWorktreesRoot());
  const isCurrentManagedRepo = repoRoot !== null
    && isInsidePath(cwd, worktreesRoot)
    && isInsidePath(repoRoot, worktreesRoot);
  const currentManagedRepoRoot = isCurrentManagedRepo ? resolve(repoRoot) : null;

  return {
    rules: [...new Map(rules.map((rule) => [resolve(rule.root), { ...rule, root: resolve(rule.root) }])).values()],
    workspaceRoots,
    currentManagedRepoRoot,
  };
}

function threatensProtectedPath(targetPath: string, rule: ProtectedPathRule): boolean {
  const target = resolve(targetPath);
  const root = resolve(rule.root);
  if (rule.mode === "tree") {
    return isInsidePath(target, root) || isInsidePath(root, target);
  }
  return target === root || isInsidePath(root, target);
}

function mutatesProtectedPath(targetPath: string, rule: ProtectedPathRule): boolean {
  const target = resolve(targetPath);
  const root = resolve(rule.root);
  if (rule.mode === "tree") return isInsidePath(target, root);
  return target === root;
}

// A trailing glob that matches every entry, so `dir/*` destroys all of `dir`.
const CATCH_ALL_GLOB = /^(?:\*|\*\*|\.\*|\.\[!\.\]\*)$/;

/**
 * Base directory of a wholesale content wipe (`dir/*`). Everything under the base is
 * destroyed, so this base is checked with the full threatensProtectedPath test - a
 * protected root nested *under* the base is destroyed just as surely as the base itself.
 * That asymmetry is why `rm -rf /` blocked before this change but `rm -rf /*` did not.
 */
function catchAllWipeBase(targetPath: string): string | null {
  const target = resolve(targetPath);
  return CATCH_ALL_GLOB.test(basename(target)) ? dirname(target) : null;
}

/**
 * Base directory of a narrower glob (`dir/build-*`). Such a glob cannot reach an
 * arbitrary sibling, so it keeps the weaker mutatesProtectedPath test it always had.
 */
function narrowGlobWipeBase(targetPath: string): string | null {
  const target = resolve(targetPath);
  const last = basename(target);
  if (!/[*?\[]/.test(last)) return null;
  return dirname(target);
}

// Command substitutions, backtick substitutions and variable expansions, in the order
// they must be tried (longest construct first).
const SHELL_EXPANSION = /\$\((?:[^()]|\([^()]*\))*\)|`[^`]*`|\$\{[^}]*\}|\$[A-Za-z_][A-Za-z0-9_]*|\$[0-9@*?#$!-]/g;

// `${VAR:?}` / `${VAR:?message}` aborts the shell when VAR is unset *or* empty, so this
// form cannot collapse. It is the POSIX way to assert a path is present, and blocking it
// would punish exactly the defensive code this guard asks for. `${VAR?}` without the colon
// is NOT exempt: it permits an empty value, which is the whole hazard.
const GUARDED_EXPANSION = /^\$\{[A-Za-z_][A-Za-z0-9_]*:\?/;
const NON_EMPTY_PLACEHOLDER = "__hooks_guarded_expansion__";

/**
 * The shape that destroyed station02 on 2026-07-24.
 *
 * `bun pm cache` writes its path to stdout on success, but exits 1 with an empty stdout
 * when no package.json is found walking up from cwd. `rm -rf "$(bun pm cache)"/*` therefore
 * became `rm -rf /*`. Redirecting stderr does not help: the redirect discards the
 * diagnostic, not the path. The hazard is not this command - it is any expansion the shell
 * may hand back empty, immediately followed by a path separator.
 *
 * Returns the token with every expansion replaced by the empty string, i.e. the worst case
 * the shell can produce. Returns null when:
 *  - the token contains no expansion; or
 *  - the collapse is not absolute. A bare `rm -rf "$(cmd)"` collapses to `rm -rf ""`, which
 *    POSIX rm rejects with "cannot remove ''" and a non-zero exit without deleting anything,
 *    and blocking it would break routine `rm -rf "$tmpdir"` cleanup for no safety gain. A
 *    relative collapse stays inside cwd and is already covered by the ordinary target check.
 *    The whole catastrophic class is the one where the collapse leaves a leading `/`.
 */
export function emptyExpansionCollapse(token: string): string | null {
  if (!/[$`]/.test(token)) return null;
  let sawCollapsible = false;
  const collapsed = token.replace(SHELL_EXPANSION, (match) => {
    if (GUARDED_EXPANSION.test(match)) return NON_EMPTY_PLACEHOLDER;
    sawCollapsible = true;
    return "";
  });
  if (!sawCollapsible || !collapsed.startsWith("/")) return null;
  return collapsed;
}

function shouldSkipHasnaTreeRule(targetPath: string, rule: ProtectedPathRule, currentManagedRepoRoot: string | null): boolean {
  if (rule.label !== "Hasna state root ~/.hasna") return false;
  if (!currentManagedRepoRoot) return false;
  const target = resolve(targetPath);
  return isInsidePath(target, currentManagedRepoRoot);
}

function isMissingPathError(error: unknown): boolean {
  return error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT";
}

function hasUnsafeTargetComponent(worktreesRoot: string, target: string): boolean {
  const relativeTarget = relative(worktreesRoot, target);
  const parts = relativeTarget.split(sep).filter(Boolean);
  if (parts.some((part) => part.toLowerCase() === ".git")) return true;

  const filesystemRoot = parse(target).root;
  const absoluteParts = relative(filesystemRoot, target).split(sep).filter(Boolean);
  let probe = filesystemRoot;
  try {
    if (lstatSync(probe).isSymbolicLink()) return true;
  } catch {
    return true;
  }
  for (const part of absoluteParts) {
    probe = join(probe, part);
    try {
      const metadata = lstatSync(probe);
      if (metadata.isSymbolicLink()) return true;
      if (probe === target && metadata.isFile() && metadata.nlink > 1) return true;
    } catch (error) {
      if (isMissingPathError(error)) return false;
      return true;
    }
  }
  return false;
}

/**
 * Candidate worktree roots for an absolute target, canonical shape first.
 *
 * The canonical root sits at `<worktrees-root>/<repo-name>/<worktree-name>`
 * (CANONICAL_WORKTREE_SEGMENTS). The deprecated station-id lease layout sits one
 * level deeper. Order matters: a canonical worktree that happens to contain a
 * subdirectory must resolve to the canonical root, never to the subdirectory.
 */
function managedWorktreeRootCandidates(worktreesRoot: string, target: string): string[] {
  const parts = relative(worktreesRoot, target).split(sep).filter(Boolean);
  const depths = [CANONICAL_WORKTREE_SEGMENTS, LEGACY_LEASE_WORKTREE_SEGMENTS];
  return depths
    .filter((depth) => parts.length >= depth)
    .map((depth) => resolve(worktreesRoot, ...parts.slice(0, depth)));
}

/**
 * Worktree roots that could own `target`, for the scoped dangerous-operation
 * carve-out only.
 *
 * This is a structural lookup ("could a real managed worktree own this path?"),
 * not a policy check ("is this path canonical?"). It therefore keeps the
 * deprecated station-id lease layout as a candidate, so that worktrees created
 * before rule 8 keep their `~/.hasna` write carve-out during migration. Policy
 * enforcement lives in managedWorktreeInfo() / worktree-guard.
 *
 * Both depths are returned when both are plausible, because path shape alone
 * cannot tell a canonical root from a legacy lease container. Each candidate is
 * still verified against Git provenance by the caller, which fails closed.
 */
function managedLeaseRootCandidates(worktreesRoot: string, target: string): string[] {
  return managedWorktreeRootCandidates(worktreesRoot, target).filter((candidate) => {
    const info = managedWorktreeInfo(candidate);
    return info.managed || info.layout === "legacy-station-lease";
  });
}

async function verifiedLinkedWorktreeRoot(leaseRoot: string): Promise<string | null> {
  const controlFile = join(leaseRoot, ".git");
  try {
    const metadata = lstatSync(controlFile);
    if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.nlink !== 1) return null;
  } catch {
    return null;
  }

  if (!commandExists("git")) return null;
  const result = await runCommand([
    "git",
    "rev-parse",
    "--show-toplevel",
    "--absolute-git-dir",
    "--git-common-dir",
  ], { cwd: leaseRoot, timeoutMs: 2000 });
  if (result.exitCode !== 0) return null;
  const [repoRootRaw, gitDirRaw, commonDirRaw] = result.stdout.trim().split(/\r?\n/);
  if (!repoRootRaw || !gitDirRaw || !commonDirRaw) return null;

  const repoRoot = resolve(repoRootRaw);
  const gitDir = resolveFrom(leaseRoot, gitDirRaw);
  const commonDir = resolveFrom(leaseRoot, commonDirRaw);
  if (repoRoot !== resolve(leaseRoot)) return null;
  try {
    const physicalGitDir = realpathSync(gitDir);
    const physicalCommonDir = realpathSync(commonDir);
    const physicalWorktreesDir = realpathSync(join(commonDir, "worktrees"));
    if (physicalGitDir === physicalWorktreesDir || !isInsidePath(physicalGitDir, physicalWorktreesDir)) return null;
    if (dirname(physicalWorktreesDir) !== physicalCommonDir) return null;

    const commondirPointer = readFileSync(join(gitDir, "commondir"), "utf-8").trim();
    const gitdirPointer = readFileSync(join(gitDir, "gitdir"), "utf-8").trim();
    if (!commondirPointer || !gitdirPointer) return null;
    if (realpathSync(resolveFrom(gitDir, commondirPointer)) !== physicalCommonDir) return null;
    const expectedControlFile = resolve(controlFile);
    const backPointer = resolveFrom(gitDir, gitdirPointer);
    if (backPointer !== expectedControlFile) return null;
    if (realpathSync(backPointer) !== realpathSync(expectedControlFile)) return null;
  } catch {
    return null;
  }
  return repoRoot;
}

async function managedRepoRootForAbsoluteTarget(
  targetPath: string,
  repoRootCache: Map<string, Promise<string | null>>,
): Promise<string | null> {
  if (!isAbsolute(targetPath)) return null;
  const worktreesRoot = resolve(defaultWorktreesRoot());
  const target = resolve(targetPath);
  if (target === worktreesRoot || !isInsidePath(target, worktreesRoot)) return null;
  if (hasUnsafeTargetComponent(worktreesRoot, target)) return null;

  let physicalWorktreesRoot: string;
  try {
    physicalWorktreesRoot = realpathSync(worktreesRoot);
  } catch {
    return null;
  }

  for (const leaseRoot of managedLeaseRootCandidates(worktreesRoot, target)) {
    const repoRoot = await verifiedManagedRepoRoot(leaseRoot, target, physicalWorktreesRoot, repoRootCache);
    if (repoRoot) return repoRoot;
  }
  return null;
}

async function verifiedManagedRepoRoot(
  leaseRoot: string,
  target: string,
  physicalWorktreesRoot: string,
  repoRootCache: Map<string, Promise<string | null>>,
): Promise<string | null> {
  let repoRootPromise = repoRootCache.get(leaseRoot);
  if (!repoRootPromise) {
    repoRootPromise = verifiedLinkedWorktreeRoot(leaseRoot);
    repoRootCache.set(leaseRoot, repoRootPromise);
  }
  const repoRoot = await repoRootPromise;
  if (!repoRoot) return null;
  const resolvedRepoRoot = resolve(repoRoot);
  if (resolvedRepoRoot !== resolve(leaseRoot)) return null;
  try {
    const physicalRepoRoot = realpathSync(resolvedRepoRoot);
    if (physicalRepoRoot === physicalWorktreesRoot || !isInsidePath(physicalRepoRoot, physicalWorktreesRoot)) return null;
    const probe = dirname(target);
    let existingProbe = probe;
    while (true) {
      try {
        lstatSync(existingProbe);
        break;
      } catch (error) {
        if (!isMissingPathError(error)) return null;
      }
      const parent = dirname(existingProbe);
      if (parent === existingProbe || !isInsidePath(parent, resolvedRepoRoot)) return null;
      existingProbe = parent;
    }
    const physicalProbe = realpathSync(existingProbe);
    const missingSuffix = relative(existingProbe, target);
    if (!missingSuffix || missingSuffix === ".." || missingSuffix.startsWith(`..${sep}`) || isAbsolute(missingSuffix)) return null;
    const physicalTarget = existsSync(target)
      ? realpathSync(target)
      : resolve(physicalProbe, missingSuffix);
    if (physicalTarget === physicalRepoRoot || !isInsidePath(physicalTarget, physicalRepoRoot)) return null;
  } catch {
    return null;
  }
  return resolvedRepoRoot;
}

function threatensRule(targetPath: string, rule: ProtectedPathRule, currentManagedRepoRoot: string | null): boolean {
  if (shouldSkipHasnaTreeRule(targetPath, rule, currentManagedRepoRoot)) return false;
  const catchAllBase = catchAllWipeBase(targetPath);
  if (catchAllBase && threatensProtectedPath(catchAllBase, rule)) return true;
  const narrowBase = narrowGlobWipeBase(targetPath);
  if (narrowBase && mutatesProtectedPath(narrowBase, rule)) return true;
  return threatensProtectedPath(targetPath, rule);
}

function mutatesRule(targetPath: string, rule: ProtectedPathRule, currentManagedRepoRoot: string | null): boolean {
  if (shouldSkipHasnaTreeRule(targetPath, rule, currentManagedRepoRoot)) return false;
  return mutatesProtectedPath(targetPath, rule);
}

interface DestructiveShellTarget {
  path: string;
  operation: string;
  /** Same target with every shell expansion collapsed to empty; see emptyExpansionCollapse. */
  collapsed?: string;
  /** Target of a command sent to another host, so relative paths cannot be resolved here. */
  remote?: boolean;
  /** Working directory in effect for this target, after any `cd` earlier in the command. */
  baseCwd?: string;
}

function destructiveTarget(path: string, operation: string): DestructiveShellTarget {
  const collapsed = emptyExpansionCollapse(path);
  return collapsed === null ? { path, operation } : { path, operation, collapsed };
}

function rmCommandTargets(command: string): DestructiveShellTarget[] {
  const targets: DestructiveShellTarget[] = [];
  for (const segment of splitShellSegments(command)) {
    const tokens = shellWords(segment);
    const rmIndex = tokens.findIndex((token) => token === "rm" || token.endsWith("/rm"));
    if (rmIndex === -1) continue;

    let recursive = false;
    let force = false;
    let afterOptions = false;
    const segmentTargets: string[] = [];

    for (let i = rmIndex + 1; i < tokens.length; i += 1) {
      const token = tokens[i];
      if (!afterOptions && token === "--") {
        afterOptions = true;
        continue;
      }
      if (!afterOptions && token.startsWith("--")) {
        if (token === "--recursive" || token === "--dir") recursive = true;
        if (token === "--force") force = true;
        continue;
      }
      if (!afterOptions && /^-[A-Za-z]+$/.test(token)) {
        if (token.includes("r") || token.includes("R")) recursive = true;
        if (token.includes("f")) force = true;
        continue;
      }
      segmentTargets.push(token);
    }

    if (recursive) {
      targets.push(...segmentTargets.map((path) => destructiveTarget(path, force ? "rm -rf" : "rm -r")));
    }
  }
  return targets;
}

const RSYNC_OPTIONS_WITH_VALUE = new Set([
  "-e",
  "--rsh",
  "--exclude",
  "--exclude-from",
  "--include",
  "--include-from",
  "--filter",
  "--files-from",
  "--rsync-path",
  "--out-format",
  "--log-file",
  "--password-file",
  "--backup-dir",
  "--partial-dir",
  "--compare-dest",
  "--copy-dest",
  "--link-dest",
]);

function optionTakesValue(token: string, options: Set<string>): boolean {
  if (options.has(token)) return true;
  const eq = token.indexOf("=");
  return eq === -1 ? false : options.has(token.slice(0, eq));
}

function rsyncDeleteTargets(command: string): DestructiveShellTarget[] {
  const targets: DestructiveShellTarget[] = [];
  for (const segment of splitShellSegments(command)) {
    const tokens = shellWords(segment);
    const rsyncIndex = tokens.findIndex((token) => token === "rsync" || token.endsWith("/rsync"));
    if (rsyncIndex === -1) continue;

    let hasDelete = false;
    let afterOptions = false;
    const operands: string[] = [];

    for (let i = rsyncIndex + 1; i < tokens.length; i += 1) {
      const token = tokens[i];
      if (!afterOptions && token === "--") {
        afterOptions = true;
        continue;
      }
      if (!afterOptions && (token === "--delete" || token.startsWith("--delete-"))) {
        hasDelete = true;
        continue;
      }
      if (!afterOptions && token.startsWith("-")) {
        if (optionTakesValue(token, RSYNC_OPTIONS_WITH_VALUE) && !token.includes("=")) i += 1;
        continue;
      }
      operands.push(token);
    }

    if (hasDelete && operands.length > 0) {
      targets.push(destructiveTarget(operands[operands.length - 1], "rsync --delete"));
    }
  }
  return targets;
}

function findDestructiveTargets(command: string): DestructiveShellTarget[] {
  const targets: DestructiveShellTarget[] = [];
  for (const segment of splitShellSegments(command)) {
    const tokens = shellWords(segment);
    const findIndex = tokens.findIndex((token) => token === "find" || token.endsWith("/find"));
    if (findIndex === -1) continue;

    let hasDelete = false;
    let hasExecRm = false;
    const roots: string[] = [];

    for (let i = findIndex + 1; i < tokens.length; i += 1) {
      const token = tokens[i];
      if (token === "-H" || token === "-L" || token === "-P") continue;
      if (token === "-O") {
        i += 1;
        continue;
      }
      if (token.startsWith("-") || token === "!" || token === "(" || token === ")") break;
      roots.push(token);
    }

    for (let i = findIndex + 1; i < tokens.length; i += 1) {
      const token = tokens[i];
      if (token === "-delete") hasDelete = true;
      if (token === "-exec" || token === "-execdir") {
        const next = tokens[i + 1];
        if (next === "rm" || next?.endsWith("/rm")) hasExecRm = true;
      }
    }

    if (hasDelete || hasExecRm) {
      targets.push(...(roots.length > 0 ? roots : ["."]).map((path) => destructiveTarget(
        path,
        hasDelete ? "find -delete" : "find -exec rm"
      )));
    }
  }
  return targets;
}

function gitTargetCwdFromTokens(tokens: string[], baseCwd: string): { gitIndex: number; commandIndex: number; targetCwd: string } | null {
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

    const targetCwd = workTree || (gitDir ? (gitDir.endsWith(`${sep}.git`) || gitDir.endsWith("/.git") ? dirname(gitDir) : gitDir) : cwd);
    return { gitIndex, commandIndex: i, targetCwd };
  }

  return null;
}

function gitDestructiveTargets(command: string, baseCwd: string): DestructiveShellTarget[] {
  const targets: DestructiveShellTarget[] = [];
  for (const segment of splitShellSegments(command)) {
    const tokens = shellWords(segment);
    const git = gitTargetCwdFromTokens(tokens, baseCwd);
    if (!git) continue;

    const commandName = tokens[git.commandIndex];
    if (commandName === "reset" && tokens.slice(git.commandIndex + 1).includes("--hard")) {
      targets.push({ path: git.targetCwd, operation: "git reset --hard" });
      continue;
    }

    if (commandName !== "clean") continue;

    let force = false;
    let recursive = false;
    const pathspecs: string[] = [];
    for (let i = git.commandIndex + 1; i < tokens.length; i += 1) {
      const token = tokens[i];
      if (token === "--") continue;
      if (token === "-f" || token === "--force") {
        force = true;
        continue;
      }
      if (token === "-d") {
        recursive = true;
        continue;
      }
      if (/^-[A-Za-z]+$/.test(token)) {
        if (token.includes("f")) force = true;
        if (token.includes("d")) recursive = true;
        continue;
      }
      if (token.startsWith("-")) continue;
      pathspecs.push(token);
    }

    if (force && recursive) {
      targets.push(...(pathspecs.length > 0 ? pathspecs : ["."]).map((path) => ({
        path: resolveFrom(git.targetCwd, path),
        operation: "git clean -xfd",
      })));
    }
  }
  return targets;
}

const SHELL_INTERPRETERS = new Set(["sh", "bash", "zsh", "dash", "ksh", "ash", "mksh", "busybox"]);

// Also take a script via `-c`, but with a username operand in front of the flag.
const USER_SWITCH_COMMANDS = new Set(["su", "runuser"]);

// ssh options that consume the following argument, so the first bare operand really is the host.
const SSH_OPTIONS_WITH_VALUE = new Set([
  "-B", "-b", "-c", "-D", "-E", "-e", "-F", "-I", "-i", "-J", "-L", "-l", "-m",
  "-O", "-o", "-P", "-p", "-Q", "-R", "-S", "-W", "-w",
]);

interface ShellCommandLayer {
  command: string;
  /** True once the layer is being executed on another host via ssh. */
  remote: boolean;
}

function commandName(token: string): string {
  return token.includes("/") ? token.slice(token.lastIndexOf("/") + 1) : token;
}

function isShellInterpreterToken(token: string): boolean {
  return SHELL_INTERPRETERS.has(commandName(token));
}

/**
 * Script passed via `-c`. For a shell, the first bare operand is the script *file* and the
 * scan stops there; `su`/`runuser` take a username operand first, so one is skipped.
 */
function interpreterScriptFrom(tokens: string[], shellIndex: number, allowedOperands = 0): string | null {
  let operands = 0;
  for (let i = shellIndex + 1; i < tokens.length; i += 1) {
    const token = tokens[i];
    // -c, and combined short forms such as -lc / -euxc.
    if (/^-[A-Za-z]*c$/.test(token)) return tokens[i + 1] ?? null;
    if (!token.startsWith("-")) {
      operands += 1;
      if (operands > allowedOperands) return null;
    }
  }
  return null;
}

function sshRemoteCommandFrom(tokens: string[], sshIndex: number): string | null {
  for (let i = sshIndex + 1; i < tokens.length; i += 1) {
    const token = tokens[i];
    if (token === "--") continue;
    if (token.startsWith("-")) {
      if (SSH_OPTIONS_WITH_VALUE.has(token)) i += 1;
      continue;
    }
    // First bare operand is [user@]host; everything after it is the remote command.
    const remote = tokens.slice(i + 1).join(" ").trim();
    return remote.length > 0 ? remote : null;
  }
  return null;
}

/**
 * Scripts this command hands to another interpreter or to another host.
 *
 * Required, not optional: the realized 2026-07-24 incident arrived as
 * `ssh station02 bash -c '...'`, and the `rm` token only exists inside the quoted script.
 * A scan of the outer command alone sees `ssh`, `bash` and a single opaque operand.
 */
function isSshToken(token: string): boolean {
  return token === "ssh" || token.endsWith("/ssh");
}

function wrappedShellLayers(command: string, remote: boolean): ShellCommandLayer[] {
  const layers: ShellCommandLayer[] = [];
  for (const segment of splitShellSegments(command)) {
    const tokens = shellWords(segment);
    // `ssh host bash -c '...'`: everything after the ssh token executes on the other machine.
    let sshSeen = false;
    for (let i = 0; i < tokens.length; i += 1) {
      const token = tokens[i];
      if (isShellInterpreterToken(token) || USER_SWITCH_COMMANDS.has(commandName(token))) {
        const allowedOperands = USER_SWITCH_COMMANDS.has(commandName(token)) ? 1 : 0;
        const script = interpreterScriptFrom(tokens, i, allowedOperands);
        if (script) layers.push({ command: script, remote: remote || sshSeen });
        continue;
      }
      if (token === "eval") {
        const script = tokens.slice(i + 1).join(" ").trim();
        if (script) layers.push({ command: script, remote: remote || sshSeen });
        continue;
      }
      if (isSshToken(token)) {
        sshSeen = true;
        const script = sshRemoteCommandFrom(tokens, i);
        if (script) layers.push({ command: script, remote: true });
      }
    }
  }
  return layers;
}

const MAX_WRAPPER_DEPTH = 3;
const MAX_SHELL_LAYERS = 32;

function shellCommandLayers(command: string): ShellCommandLayer[] {
  const layers: ShellCommandLayer[] = [{ command, remote: false }];
  const seen = new Set([command]);
  let frontier: ShellCommandLayer[] = layers;

  for (let depth = 0; depth < MAX_WRAPPER_DEPTH && layers.length < MAX_SHELL_LAYERS; depth += 1) {
    const next: ShellCommandLayer[] = [];
    for (const layer of frontier) {
      for (const inner of wrappedShellLayers(layer.command, layer.remote)) {
        if (seen.has(inner.command) || layers.length + next.length >= MAX_SHELL_LAYERS) continue;
        seen.add(inner.command);
        next.push(inner);
      }
    }
    if (next.length === 0) break;
    layers.push(...next);
    frontier = next;
  }

  return layers;
}

/**
 * Remote layers run against another machine's filesystem, so a relative or cwd-derived
 * target here would be a guess. Absolute targets (including `~` / `$HOME` forms, which the
 * fleet shares) and empty-collapse targets (always absolute by construction) still apply.
 */
function keepRemoteTarget(target: DestructiveShellTarget): boolean {
  return target.collapsed !== undefined || isAbsolute(expandHome(target.path));
}

interface CommandChunk {
  segment: string;
  /** Working directories this segment may run in: the tracked cwd, plus the cwd a `cd`
   *  whose operand collapsed to empty would have left behind. */
  cwds: string[];
  /** An absolute `cd` inside this layer fixed the directory, so it is known even remotely. */
  explicitCwd: boolean;
}

const MAX_CWD_VARIANTS = 4;

/**
 * Segments of one layer paired with the working directories in effect when they run.
 *
 * Without this, `cd / && rm -rf *` reads as a glob over wherever the agent started, which is
 * the cheapest possible way around a guard that only inspects the literal target. The
 * collapsed variant covers `cd "$(cmd)"/ && rm -rf ./*`, which is the incident's shape moved
 * one command to the left.
 */
function cwdTrackedSegments(command: string, baseCwd: string): CommandChunk[] {
  const chunks: CommandChunk[] = [];
  const home = process.env.HOME || homedir();
  let cwds = [baseCwd];
  let explicitCwd = false;

  for (const segment of splitShellSegments(command)) {
    const tokens = shellWords(segment);
    if (tokens[0] === "cd") {
      const operand = tokens[1];
      // `cd -` returns somewhere this scan cannot know, so the previous cwd is kept.
      if (operand === undefined) {
        cwds = [home];
        explicitCwd = true;
      } else if (operand !== "-" && !operand.startsWith("-")) {
        const collapsed = emptyExpansionCollapse(operand);
        const next = new Set<string>();
        for (const current of cwds) {
          next.add(resolveFrom(current, operand));
          if (collapsed !== null) next.add(resolveFrom(current, collapsed));
        }
        cwds = [...next].slice(0, MAX_CWD_VARIANTS);
        if (isAbsolute(expandHome(operand)) || collapsed !== null) explicitCwd = true;
      }
      continue;
    }
    chunks.push({ segment, cwds, explicitCwd });
  }
  return chunks;
}

/**
 * `for d in /*; do rm -rf "$d"; done` deletes the filesystem root one entry at a time while
 * the delete's own target is an innocuous `$d`. Only exact `$VAR` / `${VAR}` targets bound by
 * a `for ... in` in the same layer are substituted, so this cannot fire on unrelated commands.
 */
function forLoopBindings(command: string): Map<string, string[]> {
  const bindings = new Map<string, string[]>();
  for (const segment of splitShellSegments(command)) {
    const tokens = shellWords(segment);
    const forIndex = tokens.indexOf("for");
    if (forIndex === -1) continue;
    const name = tokens[forIndex + 1];
    if (!name || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) continue;
    if (tokens[forIndex + 2] !== "in") continue;
    const words = tokens.slice(forIndex + 3).filter((token) => token !== "do");
    if (words.length > 0) bindings.set(name, words);
  }
  return bindings;
}

function loopBoundWords(path: string, bindings: Map<string, string[]>): string[] | null {
  const match = path.match(/^\$\{?([A-Za-z_][A-Za-z0-9_]*)\}?$/);
  if (!match) return null;
  return bindings.get(match[1]) ?? null;
}

function destructiveShellTargets(command: string, cwd: string): DestructiveShellTarget[] {
  const targets: DestructiveShellTarget[] = [];
  for (const layer of shellCommandLayers(command)) {
    const bindings = forLoopBindings(layer.command);

    for (const chunk of cwdTrackedSegments(layer.command, cwd)) {
      const raw = [
        ...rmCommandTargets(chunk.segment),
        ...rsyncDeleteTargets(chunk.segment),
        ...findDestructiveTargets(chunk.segment),
        ...gitDestructiveTargets(chunk.segment, chunk.cwds[0]),
      ];

      const expanded = raw.flatMap((target) => {
        const words = loopBoundWords(target.path, bindings);
        return words === null ? [target] : words.map((word) => destructiveTarget(word, target.operation));
      });

      const chunkTargets = expanded.flatMap((target) =>
        chunk.cwds.map((chunkCwd) => ({ ...target, baseCwd: chunkCwd }))
      );

      if (!layer.remote) {
        targets.push(...chunkTargets);
        continue;
      }
      targets.push(
        ...chunkTargets
          .filter((target) => chunk.explicitCwd || keepRemoteTarget(target))
          .map((target) => ({ ...target, remote: true }))
      );
    }
  }
  return targets;
}

function isApplyPatchTool(toolName: string): boolean {
  return toolName === "apply_patch" || toolName === "ApplyPatch" || toolName === "functions.apply_patch";
}

function extractFileToolPaths(input: CodewithHookInput): Array<{ path: string; operation: string }> {
  if (input.hook_event_name !== "PreToolUse") return [];
  const toolName = typeof input.tool_name === "string" ? input.tool_name : "";
  const toolInput = input.tool_input && typeof input.tool_input === "object" ? input.tool_input : {};
  const paths: Array<{ path: string; operation: string }> = [];

  const addString = (value: unknown, operation: string) => {
    if (typeof value === "string" && value.trim()) paths.push({ path: value, operation });
  };
  const addPathFields = (obj: Record<string, unknown>, operation: string) => {
    for (const key of ["file_path", "path", "target_path", "old_path", "new_path", "notebook_path"]) {
      addString(obj[key], operation);
    }
  };

  if (["Write", "Edit", "MultiEdit", "NotebookEdit"].includes(toolName)) {
    addPathFields(toolInput, `${toolName} file mutation`);
  } else if (/^(?:apply_patch|ApplyPatch|functions\.apply_patch|mcp__.*|.*(?:write|edit|delete|remove|move).*file.*)$/i.test(toolName)) {
    addPathFields(toolInput, `${toolName} file mutation`);
  }

  const patch = toolInput.patch ?? toolInput.input ?? toolInput.content ?? toolInput.command;
  if (isApplyPatchTool(toolName) && typeof patch === "string") {
    for (const line of patch.split(/\r?\n/)) {
      const match = line.match(/^\*\*\* (?:(?:Add|Update|Delete) File|Move to): (.+)$/);
      if (match?.[1]) paths.push({ path: match[1].trim(), operation: "apply_patch file mutation" });
    }
  }

  const files = toolInput.files;
  if (Array.isArray(files)) {
    for (const item of files) {
      if (typeof item === "string") addString(item, `${toolName} file mutation`);
      else if (item && typeof item === "object") addPathFields(item as Record<string, unknown>, `${toolName} file mutation`);
    }
  }

  return paths;
}

function scopedBlockReason(operation: string, targetPath: string, rule: ProtectedPathRule, remote?: boolean): string {
  return [
    `Blocked scoped dangerous operation: ${operation} targets ${targetPath}${remote ? " on a remote host" : ""}.`,
    `Protected scope: ${rule.label} (${rule.root}).`,
    "This guard is scoped; destructive commands outside protected roots are not blocked.",
    "Delete a specific named subdirectory instead of the root or its contents.",
  ].join(" ");
}

function collapseBlockReason(
  operation: string,
  rawTarget: string,
  collapsedTarget: string,
  rule: ProtectedPathRule,
  remote?: boolean
): string {
  return [
    `Blocked unsafe expansion in a destructive command: ${operation} target ${rawTarget}`,
    `collapses to ${collapsedTarget}${remote ? " on a remote host" : ""} when the expansion returns empty`,
    "(a command substitution that fails or prints nothing, or an unset variable),",
    `which would destroy ${rule.label} (${rule.root}).`,
    "This is the 2026-07-24 station02 failure: `bun pm cache` exits non-zero with empty stdout when no",
    "package.json is found walking up from cwd, so `rm -rf \"$(bun pm cache)\"/*` ran as `rm -rf /*`.",
    "Redirecting stderr does not help - it discards the diagnostic, not the path.",
    "Safe alternative: resolve the path first, verify it is non-empty and not a protected root, then delete it,",
    'e.g. `dir="$(bun pm cache)" || exit 1; case "$dir" in /|"") exit 1;; esac; rm -rf -- "$dir"`.',
    "This guard blocks the shape, not the command: any expansion immediately followed by `/` can collapse to the filesystem root.",
  ].join(" ");
}

export async function classifyDangerousOperation(input: CodewithHookInput): Promise<DangerousOperationMatch> {
  if (input.hook_event_name !== "PreToolUse") return { block: false };
  const cwd = input.cwd || process.cwd();
  const { rules, workspaceRoots, currentManagedRepoRoot } = await protectedPathContextFor(input, cwd);

  if (input.tool_name === "Bash") {
    for (const target of destructiveShellTargets(getCommand(input), cwd)) {
      const targetCwd = target.baseCwd ?? cwd;
      const targetPath = resolveFrom(targetCwd, target.path);
      const rulesFor = (path: string) => {
        const extraRule = workspaceRoots.map((root) => hasnaDivisionRuleFor(path, root)).find((rule): rule is ProtectedPathRule => Boolean(rule));
        return extraRule ? [...rules, extraRule] : rules;
      };

      for (const rule of rulesFor(targetPath)) {
        if (threatensRule(targetPath, rule, currentManagedRepoRoot)) {
          return {
            block: true,
            targetPath,
            protectedPath: rule.root,
            protectedLabel: rule.label,
            operation: target.operation,
            reason: scopedBlockReason(target.operation, targetPath, rule, target.remote),
          };
        }
      }

      // Second pass over the same target as the shell would produce it if every expansion
      // came back empty. The managed-worktree escape hatch is not applied here: an empty
      // collapse leaves the worktree entirely, so it can never be the intended target.
      if (target.collapsed === undefined) continue;
      const collapsedPath = resolveFrom(targetCwd, target.collapsed);
      for (const rule of rulesFor(collapsedPath)) {
        if (threatensRule(collapsedPath, rule, null)) {
          return {
            block: true,
            targetPath: collapsedPath,
            protectedPath: rule.root,
            protectedLabel: rule.label,
            operation: target.operation,
            reason: collapseBlockReason(target.operation, target.path, collapsedPath, rule, target.remote),
          };
        }
      }
    }
  }

  const managedRepoRootCache = new Map<string, Promise<string | null>>();
  const worktreesRoot = resolve(defaultWorktreesRoot());
  for (const candidate of extractFileToolPaths(input)) {
    const targetPath = resolveFrom(cwd, candidate.path);
    const hasUnsafeManagedComponent = isInsidePath(targetPath, worktreesRoot)
      && hasUnsafeTargetComponent(worktreesRoot, targetPath);
    const targetManagedRepoRoot = hasUnsafeManagedComponent
      ? null
      : await managedRepoRootForAbsoluteTarget(targetPath, managedRepoRootCache);
    const exemptManagedRepoRoot = hasUnsafeManagedComponent
      ? null
      : targetManagedRepoRoot;
    const extraRule = workspaceRoots.map((root) => hasnaDivisionRuleFor(targetPath, root)).find((rule): rule is ProtectedPathRule => Boolean(rule));
    const allRules = extraRule ? [...rules, extraRule] : rules;
    for (const rule of allRules) {
      if (mutatesRule(targetPath, rule, exemptManagedRepoRoot)) {
        return {
          block: true,
          targetPath,
          protectedPath: rule.root,
          protectedLabel: rule.label,
          operation: candidate.operation,
          reason: scopedBlockReason(candidate.operation, targetPath, rule),
        };
      }
    }
  }

  return { block: false };
}

export function cacheDir(): string {
  return process.env.HASNA_HOOKS_CACHE_DIR || join(tmpdir(), "hasna-hooks-codewith");
}

export function cachePath(name: string): string {
  return join(cacheDir(), `${name.replace(/[^a-zA-Z0-9_.-]/g, "-")}.json`);
}

export function readCache<T>(name: string, ttlMs: number): T | null {
  try {
    const path = cachePath(name);
    if (!existsSync(path)) return null;
    const parsed = JSON.parse(readFileSync(path, "utf-8")) as { ts: number; value: T };
    if (!parsed.ts || Date.now() - parsed.ts > ttlMs) return null;
    return parsed.value;
  } catch {
    return null;
  }
}

export function writeCache<T>(name: string, value: T): void {
  try {
    const path = cachePath(name);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify({ ts: Date.now(), value }, null, 2));
  } catch {}
}

export function safeJsonSummary(raw: string): string {
  return cap(raw.replace(/((?:secret|token|password|api[_-]?key)\s*[:=]\s*)["']?[^"'\s,}]+/gi, "$1<redacted>"), 6000);
}

export function getAgentName(input: CodewithHookInput): string | null {
  const agent = input.agent && typeof input.agent === "object" ? input.agent as Record<string, unknown> : null;
  const candidates = [
    process.env.HOOKS_AGENT_NAME,
    process.env.CODEWITH_AGENT_NAME,
    process.env.CONVERSATIONS_AGENT_ID,
    typeof agent?.name === "string" ? agent.name : undefined,
    typeof agent?.agent_id === "string" ? agent.agent_id : undefined,
    typeof agent?.id === "string" ? agent.id : undefined,
    typeof input.agent_id === "string" ? input.agent_id : undefined,
  ];
  for (const candidate of candidates) {
    if (candidate && /^[a-zA-Z0-9][a-zA-Z0-9_.-]{1,80}$/.test(candidate)) return candidate;
  }
  return null;
}

export function isTopLevelSession(input: CodewithHookInput): boolean {
  if (process.env.CODEWITH_SUBAGENT === "1" || process.env.HASNA_SUBAGENT === "1") return false;
  if (typeof input.agent_type === "string" && /subagent/i.test(input.agent_type)) return false;
  return true;
}

export function defaultWorktreesRoot(): string {
  return process.env.HASNA_REPOS_WORKTREES_ROOT || join(homedir(), ".hasna", "repos", "worktrees");
}

export function isInsidePath(child: string, parent: string): boolean {
  const rel = relative(resolve(parent), resolve(child));
  return rel === "" || (!!rel && rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

/**
 * Canonical managed-worktree path shape.
 *
 * Source of truth: Hasna Agent Operating Rules rule 8, as published by the
 * @hasna/identities 0.4.4 global agent rules, verbatim:
 *
 *   "must happen in a task-specific worktree at
 *    $HOME/.hasna/repos/worktrees/<repo-name>/<worktree-name>
 *    (repo name then worktree name; no station-id or machine segment,
 *    never flat under the worktrees root)"
 *
 * So, relative to the worktrees root, a compliant worktree root is exactly two
 * segments deep: <repo-name>/<worktree-name>.
 */
export const CANONICAL_WORKTREE_SEGMENTS = 2;

/**
 * Depth of the DEPRECATED station-id lease layout
 * (`<station-id>/<repo-slug>-<hex>/wt_<hex>`) that predates rule 8.
 *
 * Read-only migration tolerance: it is never a compliant target shape, and it is
 * never reported as `managed`. It is recognised only so that (a) guard messages
 * can name it precisely and (b) the scoped dangerous-operation carve-out keeps
 * working for worktrees created before the canonical shape was mandated.
 */
export const LEGACY_LEASE_WORKTREE_SEGMENTS = 3;

// Any ordinary directory name, bounded by the filesystem's own limit rather than an
// allowlist — repo and worktree names are user data, and an over-narrow pattern would
// reject legitimate work (real fleet names include `_base`). Refused: a leading `.`,
// so `.`, `..` and `.git` can never be read as a segment; a leading `-`, so a segment
// can never read as an option in the remediation command; and control characters.
const WORKTREE_SEGMENT_PATTERN = /^[^.\-\/\x00-\x1f][^\/\x00-\x1f]{0,254}$/;
const LEGACY_LEASE_REPO_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9_.-]*-[0-9a-fA-F]{7,16}$/;
const LEGACY_LEASE_ID_PATTERN = /^wt_[0-9a-fA-F]{16,64}$/;

/**
 * Whether the deprecated station-id lease layout still gets its migration tolerance.
 *
 * Default on, so the change does not strand worktrees created before rule 8. It is a
 * kill switch, not a policy knob: the layout is non-compliant either way, and the
 * tolerance only softens the verdict from blocked to warned. Set
 * `HASNA_HOOKS_LEGACY_WORKTREE_TOLERANCE=0` once those worktrees are re-homed; the
 * whole branch goes away after that.
 *
 * Known limitation while it is on: the tolerance keys off the path name, so a newly
 * created worktree deliberately named to match also gets the warn tier. That is an
 * opt-out from a guardrail by a cooperating agent, not a security boundary — the
 * boundary is the provenance proof above, which applies to both tiers.
 */
export function legacyWorktreeToleranceEnabled(): boolean {
  return process.env.HASNA_HOOKS_LEGACY_WORKTREE_TOLERANCE !== "0";
}

export type ManagedWorktreeLayout = "canonical" | "legacy-station-lease";

export interface ManagedWorktreeInfo {
  managed: boolean;
  /** The worktrees root the path was classified against. */
  root: string;
  /** Recognised layout, set for compliant and for deprecated-but-recognised paths. */
  layout?: ManagedWorktreeLayout;
  /** True when the layout is recognised but no longer permitted by rule 8. */
  deprecated?: boolean;
  repo?: string;
  worktree?: string;
  /** Absolute path of the worktree root that owns `cwd`. */
  worktreeRoot?: string;
  reason?: string;
}

/** The canonical worktree path template, for user-facing guard messages. */
export function canonicalWorktreeTemplate(root: string = defaultWorktreesRoot()): string {
  return join(root, "<repo-name>", "<worktree-name>");
}

/**
 * Prove that `worktreeRoot` owns its own git history, synchronously.
 *
 * Shape is not evidence and neither is the mere presence of `.git`. A `.git` file is
 * two lines of text: pointing it at a shared checkout's `.git` grafts a second working
 * tree onto that checkout, so `git commit`/`git push` from the forged directory lands
 * on the shared checkout — the exact outcome rule 10 forbids. So a `.git` file must
 * carry real linked-worktree provenance:
 *
 *   - its `gitdir:` target must live under `<common-dir>/worktrees/`, and
 *   - that target's `gitdir` back-pointer must resolve to this very control file.
 *
 * A `.git` directory is accepted only as a self-contained repository. A `commondir`
 * grafts it onto another repository's history outright, and symlinked `objects` or
 * `refs` graft it onto another repository's refs — reaching the same end state as a
 * forged `.git` file without writing anything inside the victim.
 *
 * This is a structural proof only. It is deliberately close to, but not the same as,
 * the async verifiedLinkedWorktreeRoot() used for the write carve-out, which is
 * stricter still (regular-file control file, nlink === 1, worktrees dir directly
 * under the common dir).
 */
function worktreeProvenanceReason(worktreeRoot: string): string | null {
  const controlPath = join(worktreeRoot, ".git");
  let control;
  try {
    control = lstatSync(controlPath);
  } catch {
    return `${worktreeRoot} is not a git worktree root (no .git)`;
  }
  if (control.isSymbolicLink()) return `worktree .git is a symlink at ${worktreeRoot}`;

  if (control.isDirectory()) {
    if (existsSync(join(controlPath, "commondir"))) {
      return `worktree .git is grafted onto another repository at ${worktreeRoot}`;
    }
    if (!existsSync(join(controlPath, "HEAD"))) return `worktree .git is not a repository at ${worktreeRoot}`;
    // A self-contained repository owns its object and ref storage. Symlinking either
    // into another repository makes commits here land on that repository's refs.
    for (const store of ["objects", "refs"]) {
      let metadata;
      try {
        metadata = lstatSync(join(controlPath, store));
      } catch {
        return `worktree .git is missing ${store} at ${worktreeRoot}`;
      }
      if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
        return `worktree .git ${store} is grafted onto another repository at ${worktreeRoot}`;
      }
    }
    return null;
  }
  if (!control.isFile()) return `worktree .git is not a file or directory at ${worktreeRoot}`;

  try {
    const pointer = readFileSync(controlPath, "utf-8").trim();
    const match = pointer.match(/^gitdir:\s*(.+)$/);
    if (!match?.[1]) return `worktree .git is not a git worktree pointer at ${worktreeRoot}`;
    const gitDir = resolveFrom(worktreeRoot, match[1].trim());
    const commonDir = resolveFrom(gitDir, readFileSync(join(gitDir, "commondir"), "utf-8").trim());
    const physicalGitDir = realpathSync(gitDir);
    const physicalWorktreesDir = realpathSync(join(commonDir, "worktrees"));
    if (physicalGitDir === physicalWorktreesDir || !isInsidePath(physicalGitDir, physicalWorktreesDir)) {
      return `worktree .git points outside its repository's worktrees directory at ${worktreeRoot}`;
    }
    const backPointer = resolveFrom(gitDir, readFileSync(join(gitDir, "gitdir"), "utf-8").trim());
    if (realpathSync(backPointer) !== realpathSync(controlPath)) {
      return `worktree .git is not registered by its repository at ${worktreeRoot}`;
    }
  } catch {
    return `worktree .git provenance could not be verified at ${worktreeRoot}`;
  }
  return null;
}

/**
 * Verify that `<root>/<repo>/<worktree>` is a real, non-symlinked, provenance-checked
 * git worktree root.
 *
 * Path shape alone is not evidence: `<root>/<flat-worktree>/<subdir>` has exactly the
 * same shape as `<root>/<repo>/<worktree>`, so without this check a `cd` into any
 * subdirectory of a flat worktree would launder it into a compliant-looking path.
 * Symlinks are refused at every level (hence lstat, not existsSync, which follows
 * them) because a symlinked segment can aim a canonical-looking path at a shared
 * checkout.
 */
function groundedWorktreeRootReason(root: string, segments: string[]): string | null {
  let probe = resolve(root);
  for (const segment of segments) {
    probe = join(probe, segment);
    let metadata;
    try {
      metadata = lstatSync(probe);
    } catch {
      return `no worktree exists at ${probe}`;
    }
    if (metadata.isSymbolicLink()) return `worktree path traverses a symlink at ${probe}`;
    if (!metadata.isDirectory()) return `worktree path is not a directory at ${probe}`;
  }
  return worktreeProvenanceReason(probe);
}

/**
 * Classify a path against the canonical managed-worktree shape (rule 8).
 *
 * Accepted: a real git worktree root at `<worktrees-root>/<repo-name>/<worktree-name>`,
 * and any path inside it. Rejected, each with a reason: paths outside the worktrees
 * root, the root itself, flat single-segment worktrees, station-id/machine segments,
 * deeper nesting, and canonical-shaped paths that are not actually a worktree root
 * (invented, symlinked, or a subdirectory of a flat worktree).
 */
export function managedWorktreeInfo(cwd: string): ManagedWorktreeInfo {
  const root = defaultWorktreesRoot();
  const canonical = canonicalWorktreeTemplate(root);
  if (!isInsidePath(cwd, root)) return { managed: false, root, reason: "outside worktrees root" };

  const parts = relative(resolve(root), resolve(cwd)).split(sep).filter(Boolean);
  if (parts.length === 0) {
    return { managed: false, root, reason: `path is the worktrees root itself; canonical worktrees live at ${canonical}` };
  }
  if (parts.length < CANONICAL_WORKTREE_SEGMENTS) {
    return {
      managed: false,
      root,
      reason: `worktree is flat under the worktrees root, which rule 8 forbids; canonical shape is ${canonical}`,
    };
  }

  const [repo, worktree] = parts;
  for (const [label, segment] of [["repo-name", repo], ["worktree-name", worktree]] as const) {
    if (!segment || !WORKTREE_SEGMENT_PATTERN.test(segment)) {
      return { managed: false, root, reason: `${label} segment is malformed; canonical shape is ${canonical}` };
    }
  }

  // A canonical classification must be grounded in a real worktree root at depth 2,
  // never in path shape alone: at depth 2 the shape is ambiguous with a subdirectory
  // of a forbidden flat worktree, and at any depth it is ambiguous with an invented
  // or symlinked path.
  const worktreeRoot = resolve(root, repo!, worktree!);
  const rootReason = groundedWorktreeRootReason(root, [repo!, worktree!]);
  if (!rootReason) {
    return { managed: true, root, layout: "canonical", repo, worktree, worktreeRoot };
  }

  if (parts.length === CANONICAL_WORKTREE_SEGMENTS) {
    return { managed: false, root, reason: `${rootReason}; canonical shape is ${canonical}` };
  }

  // Recognised at or inside a legacy lease root, mirroring how a canonical worktree
  // covers its own subdirectories — an agent cwd'd into `src/` of a legacy worktree
  // is in the same non-compliant worktree, and must get the same migration message.
  //
  // The migration tolerance grants a weaker verdict than "blocked", so it has to clear
  // the same grounding as the canonical branch. Otherwise the lease name pattern is a
  // forgery kit: two directories named to match would launder a symlinked or grafted
  // path into a warn-and-allow.
  if (legacyWorktreeToleranceEnabled()
    && parts.length >= LEGACY_LEASE_WORKTREE_SEGMENTS
    && LEGACY_LEASE_REPO_PATTERN.test(parts[1]!)
    && LEGACY_LEASE_ID_PATTERN.test(parts[2]!)) {
    // The layout has two historical variants: the checkout sits at the lease dir, or
    // one level below it in a `repo/` child. Try both, nothing deeper.
    for (const depth of [LEGACY_LEASE_WORKTREE_SEGMENTS, LEGACY_LEASE_WORKTREE_SEGMENTS + 1]) {
      if (parts.length < depth) break;
      const segments = parts.slice(0, depth);
      if (groundedWorktreeRootReason(root, segments)) continue;
      return {
        managed: false,
        root,
        layout: "legacy-station-lease",
        deprecated: true,
        worktreeRoot: resolve(root, ...segments),
        reason: `deprecated station-id lease layout <station-id>/<repo-slug>-<hex>/wt_<hex>; rule 8 forbids a station-id or machine segment — re-home to ${canonical}`,
      };
    }
  }

  return {
    managed: false,
    root,
    reason: `worktree root is ${parts.length} segments under the worktrees root (station-id/machine segment or extra nesting); rule 8 requires the worktree to be created at exactly ${canonical}`,
  };
}

export async function gitRepoRoot(cwd: string): Promise<string | null> {
  if (!commandExists("git")) return null;
  const result = await runCommand(["git", "rev-parse", "--show-toplevel"], { cwd, timeoutMs: 2000 });
  if (result.exitCode !== 0) return null;
  return result.stdout.trim() || null;
}

export async function gitRemoteSlug(cwd: string): Promise<string | null> {
  if (!commandExists("git")) return null;
  const result = await runCommand(["git", "remote", "get-url", "origin"], { cwd, timeoutMs: 2000 });
  if (result.exitCode !== 0) return null;
  const remote = result.stdout.trim();
  if (!remote) return null;
  const match = remote.match(/[:/]([^/:\s]+\/[^/\s]+?)(?:\.git)?$/);
  return match?.[1] || null;
}

/** `origin` normalised to the `host/org/name` form the repos CLI resolves exactly. */
export async function gitRemoteHostSlug(cwd: string): Promise<string | null> {
  if (!commandExists("git")) return null;
  const result = await runCommand(["git", "remote", "get-url", "origin"], { cwd, timeoutMs: 2000 });
  if (result.exitCode !== 0) return null;
  const remote = result.stdout.trim().replace(/\.git$/, "");
  if (!remote) return null;
  const match = remote.match(/^(?:[a-z+]+:\/\/)?(?:[^@/]+@)?([^/:\s]+)[:/](.+)$/i);
  const host = match?.[1];
  const path = match?.[2]?.replace(/^\/+/, "");
  if (!host || !path || !/^[^/\s]+\/[^/\s]+$/.test(path)) return null;
  return `${host}/${path}`;
}

export interface CanonicalRepoIdentity {
  /** The repo name that forms the `<repo-name>` segment of the canonical path. */
  name: string | null;
  defaultBranch: string | null;
}

/**
 * Resolve the canonical repo name via the repos CLI, as rule 8 requires:
 * "Locate repos with the repos CLI (`repos repo <name> --json` for the exact
 * lookup; never fuzzy `repos cd` or 'did you mean' output for targeting)".
 *
 * This matters because the repos-CLI name is frequently NOT the git remote
 * basename — on this fleet 46 of 50 indexed repos differ (`open-hooks` is
 * `github.com/hasna/hooks`, `open-mailery` is `.../emails`). Deriving the
 * canonical path segment from the remote would send every agent to the wrong
 * directory, so the remote is only ever used as the exact lookup key.
 *
 * `--remote host/org/name` is the exact-match form, so no fuzzy "did you mean"
 * output can be mistaken for a hit. OSS-safe: a missing or failing repos CLI
 * yields nulls and the caller falls back to local information.
 */
export async function canonicalRepoIdentity(cwd: string): Promise<CanonicalRepoIdentity> {
  const empty: CanonicalRepoIdentity = { name: null, defaultBranch: null };
  if (!commandExists("repos")) return empty;
  const remote = await gitRemoteHostSlug(cwd);
  if (!remote) return empty;
  // Hard ceiling on the lookup. runCommand's timeout kills the direct child but still
  // awaits its pipes, which a forking CLI can hold open indefinitely; this hook sits on
  // the PreToolUse path, so it must degrade to local information rather than stall.
  const result = await Promise.race([
    runCommand(["repos", "repo", "--remote", remote, "--json"], { cwd, timeoutMs: 1000 }),
    new Promise<null>((done) => setTimeout(() => done(null), 1500).unref?.()),
  ]);
  if (!result || result.exitCode !== 0) return empty;
  try {
    const parsed = JSON.parse(result.stdout) as { name?: unknown; default_branch?: unknown; path?: unknown };
    const name = typeof parsed.name === "string" && parsed.name ? parsed.name : null;
    const defaultBranch = typeof parsed.default_branch === "string" && parsed.default_branch
      ? parsed.default_branch
      : null;

    // The index holds worktree directories as first-class rows, so an exact remote
    // match can resolve to a worktree rather than the repo. Such a row's name is a
    // worktree name and its default_branch is that worktree's branch — both wrong for
    // the canonical path. When the row lives under the worktrees root, the real repo
    // name is its first segment there; the branch is not recoverable, so drop it.
    const worktreesRoot = resolve(defaultWorktreesRoot());
    const rowPath = typeof parsed.path === "string" && parsed.path ? resolve(parsed.path) : null;
    if (rowPath && isInsidePath(rowPath, worktreesRoot) && rowPath !== worktreesRoot) {
      const segment = relative(worktreesRoot, rowPath).split(sep).filter(Boolean)[0];
      return { name: segment || null, defaultBranch: null };
    }
    return { name, defaultBranch };
  } catch {
    return empty;
  }
}

/**
 * Remediation command for work happening outside a canonical worktree.
 *
 * Rule 8: create the worktree at `<worktrees-root>/<repo-name>/<worktree-name>`,
 * named after the todos task where one exists, then `repos scan`. The repos CLI
 * has no worktree verb, so `git worktree` is the creation path.
 *
 * `repo` must be a canonical repo name (see canonicalRepoIdentity) — never a
 * remote slug, which names a different directory for most repos.
 *
 * This is the boundary where names become a command an operator may paste, so every
 * interpolated value is validated here rather than trusted from its source: a repo
 * name is attacker-influenced via the remote, and a task id is unvalidated hook input.
 * Anything unsafe degrades to the explicit placeholder instead of being emitted.
 */
const SAFE_COMMAND_VALUE = /^[a-zA-Z0-9_][a-zA-Z0-9_.\/-]{0,120}$/;

export function claimCommand(repo: string | null, taskId: string | null, defaultBranch: string | null = null): string {
  // A repo name is one path segment: a slug would silently add a third segment.
  const safeRepo = repo && SAFE_COMMAND_VALUE.test(repo) && !repo.includes("/") ? repo : null;
  const safeTask = taskId && SAFE_COMMAND_VALUE.test(taskId) ? taskId : null;
  const safeBase = defaultBranch && SAFE_COMMAND_VALUE.test(defaultBranch) ? defaultBranch : null;

  const repoName = safeRepo || "<repo-name>";
  const worktreeName = safeTask || "<worktree-name>";
  const path = join(defaultWorktreesRoot(), repoName, worktreeName);
  return `git worktree add -b ${worktreeName} ${path} origin/${safeBase || "<default-branch>"} && repos scan`;
}

export function taskIdFrom(input: CodewithHookInput): string | null {
  const candidates = [
    process.env.HASNA_TASK_ID,
    process.env.TASK_ID,
    process.env.CODEWITH_TASK_ID,
    typeof input.task_id === "string" ? input.task_id : undefined,
  ];
  return candidates.find(Boolean) || null;
}

export function runIdFrom(input: CodewithHookInput): string | null {
  const candidates = [
    process.env.HASNA_RUN_ID,
    process.env.RUN_ID,
    process.env.CODEWITH_RUN_ID,
    typeof input.run_id === "string" ? input.run_id : undefined,
    input.turn_id,
    input.session_id,
  ];
  return candidates.find((v): v is string => typeof v === "string" && v.length > 0) || null;
}

export function redactGitleaksOutput(_stdout: string, _stderr: string): string {
  return "Staged secrets scan found possible credential(s). Details redacted; run gitleaks locally to inspect.";
}
