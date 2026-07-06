#!/usr/bin/env bun

/**
 * Claude Code Hook: fleet-blockers-gate
 *
 * PreToolUse hook — every-turn insurance against working through a fleet
 * freeze. While an unread [FREEZE] blocking message is active, mutating
 * tools are denied with a reason; read-only tools stay allowed so the agent
 * can read the freeze and react.
 *
 * Design constraints (fleet comms strategy §3):
 * - deterministic local CLI call (`conversations blockers -j`)
 * - hard 500ms fail-open timeout on the check
 * - TTL cache so the common path never spawns a process per tool call
 *
 * Environment:
 * - HOOKS_FLEET_GATE_DISABLE=1   → allow everything (kill switch)
 * - HOOKS_FLEET_GATE_TTL_MS=<n>  → cache TTL (default 60000)
 * - HOOKS_FLEET_TIMEOUT_MS=<n>   → blockers check exec timeout (default 500)
 * - HOOKS_FLEET_AGENT=<name>     → identity passed as --from
 */

import { readFileSync, existsSync, mkdirSync, writeFileSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import { execSync } from "child_process";

interface HookInput {
  session_id: string;
  cwd: string;
  hook_event_name: string;
  tool_name?: string;
  tool_input?: Record<string, unknown>;
}

interface HookOutput {
  continue?: boolean;
  hookSpecificOutput?: {
    hookEventName: "PreToolUse";
    permissionDecision: "allow" | "deny" | "ask";
    permissionDecisionReason: string;
  };
}

export interface FreezeState {
  checked_at: string;
  frozen: boolean;
  reason: string;
}

const DEFAULT_TTL_MS = 60_000;
const DEFAULT_TIMEOUT_MS = 500;
const STATE_DIR = join(homedir(), ".hasna", "hooks", "state");
const CACHE_FILE = join(STATE_DIR, "fleet-blockers-gate.json");

/** Built-in tools that only read state — never gated, so a frozen agent can orient itself. */
const READ_ONLY_TOOLS = new Set([
  "Read",
  "Glob",
  "Grep",
  "LS",
  "NotebookRead",
  "WebFetch",
  "WebSearch",
  "TodoWrite",
  "ToolSearch",
  "AskUserQuestion",
]);

/** MCP operation prefixes treated as read-only (mcp__server__<op>). */
const READ_ONLY_MCP_PREFIXES = [
  "get",
  "list",
  "read",
  "search",
  "show",
  "describe",
  "check",
  "status",
  "heartbeat",
  "count",
  "recall",
  "inspect",
];

function readStdinJson(): HookInput | null {
  try {
    const input = readFileSync(0, "utf-8").trim();
    if (!input) return null;
    return JSON.parse(input);
  } catch {
    return null;
  }
}

function respond(output: HookOutput): void {
  console.log(JSON.stringify(output));
}

function ttlMs(): number {
  const raw = Number(process.env.HOOKS_FLEET_GATE_TTL_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_TTL_MS;
}

function timeoutMs(): number {
  const raw = Number(process.env.HOOKS_FLEET_TIMEOUT_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_TIMEOUT_MS;
}

/** True when the tool cannot mutate anything and must stay usable during a freeze. */
export function isReadOnlyTool(toolName: string | undefined): boolean {
  if (!toolName) return false;
  if (READ_ONLY_TOOLS.has(toolName)) return true;

  if (toolName.startsWith("mcp__")) {
    const op = toolName.split("__").pop() || "";
    return READ_ONLY_MCP_PREFIXES.some(
      (prefix) => op === prefix || op.startsWith(`${prefix}_`) || op.startsWith(`${prefix}-`)
    );
  }

  return false;
}

/** Detect an active [FREEZE] in the unread blocking messages list. */
export function detectFreeze(blockers: unknown[]): { frozen: boolean; reason: string } {
  for (const item of blockers) {
    if (!item || typeof item !== "object") continue;
    const m = item as Record<string, unknown>;
    const body = [m.content, m.preview, m.message, m.title]
      .filter((v): v is string => typeof v === "string")
      .join(" ");
    if (/\[FREEZE\]/.test(body)) {
      const from = typeof m.from === "string" ? m.from : "unknown";
      return {
        frozen: true,
        reason: `Unread [FREEZE] blocking message from ${from}: ${body.slice(0, 240)}`,
      };
    }
  }
  return { frozen: false, reason: "" };
}

export function parseBlockersJson(raw: string | null): unknown[] {
  if (!raw) return [];
  try {
    const data = JSON.parse(raw);
    if (Array.isArray(data)) return data;
    if (data && typeof data === "object") {
      const inner = (data as Record<string, unknown>).blockers ?? (data as Record<string, unknown>).messages;
      if (Array.isArray(inner)) return inner;
    }
    return [];
  } catch {
    return [];
  }
}

function readCache(now: Date): FreezeState | null {
  try {
    if (!existsSync(CACHE_FILE)) return null;
    const state = JSON.parse(readFileSync(CACHE_FILE, "utf-8")) as FreezeState;
    const checkedAt = new Date(state.checked_at).getTime();
    if (Number.isNaN(checkedAt)) return null;
    if (now.getTime() - checkedAt > ttlMs()) return null;
    return state;
  } catch {
    return null;
  }
}

function writeCache(state: FreezeState): void {
  try {
    mkdirSync(STATE_DIR, { recursive: true });
    writeFileSync(CACHE_FILE, JSON.stringify(state));
  } catch {
    // fail-open: cache is an optimization
  }
}

function checkFreeze(now: Date): FreezeState {
  const cached = readCache(now);
  if (cached) return cached;

  let frozen = false;
  let reason = "";
  try {
    const agent = process.env.HOOKS_FLEET_AGENT;
    const from = agent && /^[A-Za-z0-9._-]{1,64}$/.test(agent) ? ` --from ${agent}` : "";
    const raw = execSync(`conversations blockers -j${from}`, {
      encoding: "utf-8",
      timeout: timeoutMs(),
      stdio: ["pipe", "pipe", "pipe"],
    });
    const result = detectFreeze(parseBlockersJson(raw.trim()));
    frozen = result.frozen;
    reason = result.reason;
  } catch {
    // CLI missing / timeout / service down → fail open (never wedge the agent)
    frozen = false;
    reason = "";
  }

  const state: FreezeState = { checked_at: now.toISOString(), frozen, reason };
  writeCache(state);
  return state;
}

export function run(): void {
  if (process.env.HOOKS_FLEET_GATE_DISABLE === "1") {
    respond({ continue: true });
    return;
  }

  const input = readStdinJson();
  if (!input) {
    respond({ continue: true });
    return;
  }

  // Read-only tools always pass — the agent must stay able to read the freeze.
  if (isReadOnlyTool(input.tool_name)) {
    respond({ continue: true });
    return;
  }

  const state = checkFreeze(new Date());

  if (state.frozen) {
    respond({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason:
          `[hook-fleet-blockers-gate] Fleet freeze active — mutating tools are blocked. ` +
          `${state.reason} ` +
          `Read the blocking message (conversations blockers), resolve or wait for [UNFREEZE], then retry.`,
      },
    });
    return;
  }

  respond({ continue: true });
}

if (import.meta.main) {
  run();
}
