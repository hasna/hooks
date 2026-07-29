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

