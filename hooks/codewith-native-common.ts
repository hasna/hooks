import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "path";
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

function broadContentWipeBase(targetPath: string): string | null {
  const target = resolve(targetPath);
  const last = basename(target);
  if (!/[*?\[]/.test(last)) return null;
  return dirname(target);
}

function shouldSkipHasnaTreeRule(targetPath: string, rule: ProtectedPathRule, currentManagedRepoRoot: string | null): boolean {
  if (rule.label !== "Hasna state root ~/.hasna") return false;
  if (!currentManagedRepoRoot) return false;
  const target = resolve(targetPath);
  return isInsidePath(target, currentManagedRepoRoot);
}

function threatensRule(targetPath: string, rule: ProtectedPathRule, currentManagedRepoRoot: string | null): boolean {
  if (shouldSkipHasnaTreeRule(targetPath, rule, currentManagedRepoRoot)) return false;
  const contentBase = broadContentWipeBase(targetPath);
  if (contentBase && mutatesProtectedPath(contentBase, rule)) return true;
  return threatensProtectedPath(targetPath, rule);
}

function mutatesRule(targetPath: string, rule: ProtectedPathRule, currentManagedRepoRoot: string | null): boolean {
  if (shouldSkipHasnaTreeRule(targetPath, rule, currentManagedRepoRoot)) return false;
  return mutatesProtectedPath(targetPath, rule);
}

interface DestructiveShellTarget {
  path: string;
  operation: string;
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
      targets.push(...segmentTargets.map((path) => ({ path, operation: force ? "rm -rf" : "rm -r" })));
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
      targets.push({ path: operands[operands.length - 1], operation: "rsync --delete" });
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
      targets.push(...(roots.length > 0 ? roots : ["."]).map((path) => ({
        path,
        operation: hasDelete ? "find -delete" : "find -exec rm",
      })));
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

function destructiveShellTargets(command: string, cwd: string): DestructiveShellTarget[] {
  return [
    ...rmCommandTargets(command),
    ...rsyncDeleteTargets(command),
    ...findDestructiveTargets(command),
    ...gitDestructiveTargets(command, cwd),
  ];
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

function scopedBlockReason(operation: string, targetPath: string, rule: ProtectedPathRule): string {
  return [
    `Blocked scoped dangerous operation: ${operation} targets ${targetPath}.`,
    `Protected scope: ${rule.label} (${rule.root}).`,
    "This guard is scoped; destructive commands outside protected roots are not blocked.",
  ].join(" ");
}

export async function classifyDangerousOperation(input: CodewithHookInput): Promise<DangerousOperationMatch> {
  if (input.hook_event_name !== "PreToolUse") return { block: false };
  const cwd = input.cwd || process.cwd();
  const { rules, workspaceRoots, currentManagedRepoRoot } = await protectedPathContextFor(input, cwd);

  if (input.tool_name === "Bash") {
    for (const target of destructiveShellTargets(getCommand(input), cwd)) {
      const targetPath = resolveFrom(cwd, target.path);
      const extraRule = workspaceRoots.map((root) => hasnaDivisionRuleFor(targetPath, root)).find((rule): rule is ProtectedPathRule => Boolean(rule));
      const allRules = extraRule ? [...rules, extraRule] : rules;
      for (const rule of allRules) {
        if (threatensRule(targetPath, rule, currentManagedRepoRoot)) {
          return {
            block: true,
            targetPath,
            protectedPath: rule.root,
            protectedLabel: rule.label,
            operation: target.operation,
            reason: scopedBlockReason(target.operation, targetPath, rule),
          };
        }
      }
    }
  }

  for (const candidate of extractFileToolPaths(input)) {
    const targetPath = resolveFrom(cwd, candidate.path);
    const extraRule = workspaceRoots.map((root) => hasnaDivisionRuleFor(targetPath, root)).find((rule): rule is ProtectedPathRule => Boolean(rule));
    const allRules = extraRule ? [...rules, extraRule] : rules;
    for (const rule of allRules) {
      if (mutatesRule(targetPath, rule, currentManagedRepoRoot)) {
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
