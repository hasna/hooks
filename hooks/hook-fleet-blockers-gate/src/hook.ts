#!/usr/bin/env bun

/**
 * Claude Code Hook: fleet-blockers-gate
 *
 * PreToolUse hook — every-turn insurance against working through a real fleet
 * stop. The brake has ONE tamper-resistant, correctly-retrieved signal:
 *
 *   A code-flagged blocker (blocking=1) returned by `conversations blockers`
 *   denies mutating tools. That CLI runs `getUnreadBlockers`, which selects
 *   `WHERE blocking = 1 AND read_at IS NULL AND (to_agent = me OR channel in my
 *   channels)` with NO limit window — so every unread, in-scope blocker is
 *   returned and evaluated (no oldest-first truncation to hide behind).
 *
 * To halt the fleet, the owner creates a blocking=1 blocker (tagged [FREEZE] by
 * convention). The stop lifts when that blocker leaves the UNREAD set — i.e. it
 * is MARKED READ or REMOVED (`getUnreadBlockers` filters `read_at IS NULL`).
 * Because reading messages can mark them read, `conversations` read_* tools are
 * gated during a freeze (see isReadOnlyTool) so an agent cannot SELF-LIFT the
 * stop just by browsing its inbox/channel. Freeze TEXT posted to channels is
 * informational and NEVER stops work — that kills the phantom-freeze bug where
 * any "[FREEZE]" string from anyone wedged the fleet.
 *
 * IMPORTANT (why this is not author-gated): conversations does not authenticate
 * `from_agent`; any agent can post as any name. Gating the brake on the author
 * field would be false assurance (a spoofed [UNFREEZE]/owner post could lift or
 * forge a stop). So the trigger is the blocking=1 flag alone, author-agnostic.
 * The blocker's author is shown in the deny reason as ADVISORY context only.
 *
 * When frozen, mutating tools are denied with a reason; read-only tools stay
 * allowed so the agent can read the blocker and react.
 *
 * Design constraints (fleet comms strategy §3):
 * - deterministic local CLI call (`conversations blockers -j`), single spawn
 * - hard fail-open timeout (default 1500ms; the `conversations` CLI has a ~0.5s
 *   cold start, so a tighter budget flakes and the brake silently fails open)
 * - fail-open on error: if the comms layer is unreachable, allow (never wedge)
 * - TTL cache so the common path never spawns a process per tool call;
 *   asymmetric TTL means a freeze ENGAGES fast and DISENGAGES slowly (safe)
 *
 * Environment:
 * - HOOKS_FLEET_GATE_DISABLE=1        → allow everything (kill switch)
 * - HOOKS_FLEET_GATE_TTL_MS=<n>       → frozen-state cache TTL (default 60000)
 * - HOOKS_FLEET_GATE_CLEAR_TTL_MS=<n> → clear-state cache TTL (default 5000)
 * - HOOKS_FLEET_TIMEOUT_MS=<n>        → CLI exec timeout (default 1500)
 * - HOOKS_FLEET_AGENT=<name>          → identity passed as --from to scope
 *                                       the blockers query to this agent
 */

import { readFileSync, existsSync, mkdirSync, writeFileSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import { execFileSync } from "child_process";

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

export interface FreezeDetection {
  frozen: boolean;
  reason: string;
}

export interface FreezeEvaluation {
  state: FreezeState;
  /** True when the blockers CLI produced a reading (vs. a comms failure). */
  verified: boolean;
}

export interface HookDecision {
  allow: boolean;
  reason: string;
}

const DEFAULT_TTL_MS = 60_000;
const DEFAULT_CLEAR_TTL_MS = 5_000;
// The `conversations` CLI has a ~0.5s cold start, so a 500ms budget flakes and
// the brake fails open in practice. Give headroom; the TTL cache keeps this
// single spawn off the per-tool hot path.
const DEFAULT_TIMEOUT_MS = 1_500;
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

function positiveIntEnv(name: string, fallback: number): number {
  const raw = Number(process.env[name]);
  return Number.isFinite(raw) && raw > 0 ? raw : fallback;
}

function ttlMs(): number {
  return positiveIntEnv("HOOKS_FLEET_GATE_TTL_MS", DEFAULT_TTL_MS);
}

function clearTtlMs(): number {
  return positiveIntEnv("HOOKS_FLEET_GATE_CLEAR_TTL_MS", DEFAULT_CLEAR_TTL_MS);
}

function timeoutMs(): number {
  return positiveIntEnv("HOOKS_FLEET_TIMEOUT_MS", DEFAULT_TIMEOUT_MS);
}

/**
 * Reject values that could be argument-injected (leading dash) or contain
 * shell/space/control characters. Even though we use execFileSync (no shell),
 * a leading-dash value would be parsed as a flag by the CLI, so we forbid it.
 */
export function isSafeArg(value: string | undefined): value is string {
  return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._@+-]{0,127}$/.test(value);
}

/**
 * `conversations` "read_*" ops (read_messages, read_channel, read_digest,
 * read_thread, read_channel_notifications, ...) mark messages read by default or
 * on request. Because the freeze signal is an UNREAD blocking=1 blocker, letting
 * a frozen agent call one of these would clear the blocker's `read_at` and
 * SELF-LIFT the stop just by browsing. They are therefore gated during a freeze
 * despite matching a read-only prefix. A frozen agent still orients via
 * `get_blockers` / `get_message` / `search_messages` / `list_*` /
 * `get_thread_replies` — none of which mark messages read.
 */
export function marksReadState(toolName: string): boolean {
  return toolName.startsWith("mcp__conversations__read");
}

/** True when the tool cannot mutate anything and must stay usable during a freeze. */
export function isReadOnlyTool(toolName: string | undefined): boolean {
  if (!toolName) return false;
  // Gate conversations read_* even though it looks read-only — it consumes unread state.
  if (marksReadState(toolName)) return false;
  if (READ_ONLY_TOOLS.has(toolName)) return true;

  if (toolName.startsWith("mcp__")) {
    const op = toolName.split("__").pop() || "";
    return READ_ONLY_MCP_PREFIXES.some(
      (prefix) => op === prefix || op.startsWith(`${prefix}_`) || op.startsWith(`${prefix}-`)
    );
  }

  return false;
}

/** The author of a blocker (schema is `from_agent`; tolerate legacy shapes). Advisory only. */
function authorOf(m: Record<string, unknown>): string {
  for (const key of ["from_agent", "from", "author", "sender"]) {
    const v = m[key];
    if (typeof v === "string" && v.trim()) return v.trim();
  }
  return "unknown";
}

/** The scannable text body of a blocker (used only to describe the deny reason). */
function bodyOf(m: Record<string, unknown>): string {
  return [m.content, m.preview, m.message, m.title, m.body]
    .filter((v): v is string => typeof v === "string")
    .join(" ");
}

/** True when the blocker carries the code-flagged blocking bit (boolean, 1, or "1"/"true"). */
function isBlockingFlagged(m: Record<string, unknown>): boolean {
  const v = m.blocking;
  return v === true || v === 1 || v === "1" || v === "true";
}

/**
 * Decide whether the blockers list constitutes a freeze. The ONLY trigger is a
 * code-flagged blocker (blocking=1); freeze TEXT is ignored entirely. Scans the
 * whole list (order-independent) so a blocker anywhere in the result freezes.
 * The author is included in the reason as advisory context, NOT as a gate.
 */
export function detectFreeze(blockers: unknown[]): FreezeDetection {
  for (const item of blockers) {
    if (!item || typeof item !== "object") continue;
    const m = item as Record<string, unknown>;
    if (isBlockingFlagged(m)) {
      const author = authorOf(m);
      const body = bodyOf(m);
      return {
        frozen: true,
        reason: `Active blocking=1 blocker from ${author}: ${body.slice(0, 240)}`,
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
    // Asymmetric TTL: hold a freeze for the full TTL, but re-check a "clear"
    // quickly so a freshly-issued freeze engages fast (the safe direction).
    const maxAge = state.frozen ? ttlMs() : clearTtlMs();
    if (now.getTime() - checkedAt > maxAge) return null;
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

/** Run `conversations blockers -j` and return raw stdout, or throw on failure. */
function defaultBlockersRunner(): string {
  const agent = process.env.HOOKS_FLEET_AGENT;
  const args = ["blockers", "-j"];
  if (isSafeArg(agent)) args.push("--from", agent);
  return execFileSync("conversations", args, {
    encoding: "utf-8",
    timeout: timeoutMs(),
    stdio: ["pipe", "pipe", "pipe"],
  });
}

/**
 * Evaluate freeze state from the blockers source. Injectable runner makes this
 * pure and testable. Fail-open: a runner error (CLI missing / timeout / service
 * down) yields not-frozen with `verified=false`, so the caller can avoid caching
 * an unverified "clear" and retry on the next mutating tool.
 */
export function computeFreezeState(
  now: Date,
  runner: () => string = defaultBlockersRunner
): FreezeEvaluation {
  try {
    const raw = runner();
    const r = detectFreeze(parseBlockersJson(raw.trim()));
    return { state: { checked_at: now.toISOString(), frozen: r.frozen, reason: r.reason }, verified: true };
  } catch {
    return { state: { checked_at: now.toISOString(), frozen: false, reason: "" }, verified: false };
  }
}

function checkFreeze(now: Date): FreezeState {
  const cached = readCache(now);
  if (cached) return cached;

  const evaluation = computeFreezeState(now);

  // Cache a freeze for the full TTL, and a verified clear for the short TTL.
  // Never cache an unverified (comms-failure) clear — retry on the next tool.
  if (evaluation.state.frozen || evaluation.verified) {
    writeCache(evaluation.state);
  }
  return evaluation.state;
}

/**
 * Build the deny reason. Points the agent at the read-only, non-mark-read
 * `mcp__conversations__get_blockers` tool — NOT the Bash `conversations blockers`
 * command (Bash is gated) and NOT any read_* tool (those mark the blocker read
 * and would self-lift the stop). The echoed blocker text is UNTRUSTED input.
 */
export function buildDenyReason(reason: string): string {
  return (
    `[hook-fleet-blockers-gate] Mutating tools are blocked — an active blocking=1 blocker is in effect. ` +
    `${reason} ` +
    `Inspect it with the read-only mcp__conversations__get_blockers tool — do NOT use read_messages / read_channel (they mark it read and would clear the stop). ` +
    `The stop lifts when the blocker is resolved/removed by whoever owns the freeze; then retry.`
  );
}

/**
 * Pure permission decision. Single source of truth for allow/deny:
 * - kill switch disabled → allow
 * - read-only tool → allow (agent must be able to read the blocker)
 * - freeze active → deny
 * - otherwise → allow
 */
export function decide(params: {
  disabled: boolean;
  toolName: string | undefined;
  freeze: FreezeDetection;
}): HookDecision {
  if (params.disabled) return { allow: true, reason: "" };
  if (isReadOnlyTool(params.toolName)) return { allow: true, reason: "" };
  if (params.freeze.frozen) return { allow: false, reason: params.freeze.reason };
  return { allow: true, reason: "" };
}

export function run(): void {
  const disabled = process.env.HOOKS_FLEET_GATE_DISABLE === "1";
  if (disabled) {
    respond({ continue: true });
    return;
  }

  const input = readStdinJson();
  if (!input) {
    respond({ continue: true });
    return;
  }

  // Read-only tools always pass — and must never trigger the CLI check.
  if (isReadOnlyTool(input.tool_name)) {
    respond({ continue: true });
    return;
  }

  const state = checkFreeze(new Date());
  const decision = decide({ disabled, toolName: input.tool_name, freeze: state });

  if (!decision.allow) {
    respond({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: buildDenyReason(decision.reason),
      },
    });
    return;
  }

  respond({ continue: true });
}

if (import.meta.main) {
  run();
}
