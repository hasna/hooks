import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "path";
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
  process.stdout.write(`${JSON.stringify(output)}\n`);
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

function splitShellSegments(command: string): string[] {
  const segments: string[] = [];
  let current = "";
  let quote: "'" | '"' | null = null;
  let escaped = false;

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
  return segments;
}

function shellWords(segment: string): string[] {
  const words: string[] = [];
  let current = "";
  let quote: "'" | '"' | null = null;
  let escaped = false;

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
    if (ch === "\\" && quote !== "'") {
      escaped = true;
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
  return words;
}

function expandHome(path: string): string {
  if (path === "~") return homedir();
  if (path.startsWith("~/")) return join(homedir(), path.slice(2));
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

export function managedWorktreeInfo(cwd: string): { managed: boolean; root: string; reason?: string } {
  const root = defaultWorktreesRoot();
  if (!isInsidePath(cwd, root)) return { managed: false, root, reason: "outside worktrees root" };
  const rel = relative(resolve(root), resolve(cwd));
  const parts = rel.split(sep).filter(Boolean);
  if (parts.length < 3) return { managed: false, root, reason: "path is inside worktrees root but not deep enough" };
  const [machine, repoSlugHash, lease] = parts;
  if (!machine || !repoSlugHash || !lease) return { managed: false, root, reason: "missing machine/repo/lease path segments" };
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]{1,80}$/.test(machine)) return { managed: false, root, reason: "machine segment is malformed" };
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]*-[0-9a-fA-F]{7,16}$/.test(repoSlugHash)) {
    return { managed: false, root, reason: "repo segment must end in a hex hash suffix" };
  }
  if (!/^wt_[0-9a-fA-F]{16,64}$/.test(lease)) {
    return { managed: false, root, reason: "lease segment must look like wt_<hex hash>" };
  }
  return { managed: true, root };
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

export function claimCommand(repo: string | null, taskId: string | null, runId: string | null): string {
  return `repos worktrees claim --repo ${repo || "<repo>"} --task-id ${taskId || "<task-id>"} --run-id ${runId || "<run-id>"} --base main --mode required --json`;
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
