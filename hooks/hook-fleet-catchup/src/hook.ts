#!/usr/bin/env bun

/**
 * Claude Code Hook: fleet-catchup
 *
 * SessionStart hook that catches an agent up on fleet communications:
 * - `conversations blockers -j`                     → unread blocking messages
 * - `conversations notifications --since <last>`    → channel notifications since last catchup
 * - `conversations digest announcements --unread --since 7d` → bounded announcements digest
 *
 * All reads are deterministic CLI calls against the local conversations
 * service. Every step is fail-open: a missing CLI, timeout, or parse error
 * skips that section and never blocks the session. Output is injected via
 * SessionStart's `hookSpecificOutput.additionalContext`.
 *
 * Environment:
 * - HOOKS_FLEET_CATCHUP_DISABLE=1   → skip entirely
 * - HOOKS_FLEET_AGENT=<name>        → identity passed as --from
 * - HOOKS_FLEET_TIMEOUT_MS=<n>      → per-command exec timeout (default 1500)
 * - HOOKS_FLEET_SINCE=<duration>    → announcements digest window (default 7d)
 */

import { readFileSync, existsSync, mkdirSync, writeFileSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import { exec } from "child_process";

interface HookInput {
  session_id: string;
  cwd: string;
  hook_event_name: string;
  source?: string;
}

interface HookOutput {
  continue: boolean;
  hookSpecificOutput?: {
    hookEventName: "SessionStart";
    additionalContext: string;
  };
}

const DEFAULT_TIMEOUT_MS = 1500;
const DEFAULT_LOOKBACK_MS = 24 * 60 * 60 * 1000; // 24h when no last-seen state
const STATE_DIR = join(homedir(), ".hasna", "hooks", "state");
const LAST_SEEN_FILE = join(STATE_DIR, "fleet-catchup.last_seen");

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

function timeoutMs(): number {
  const raw = Number(process.env.HOOKS_FLEET_TIMEOUT_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_TIMEOUT_MS;
}

/** Only pass through shell-safe identifier values (defense against env-borne injection). */
export function safeIdentifier(value: string | undefined): string | null {
  if (!value) return null;
  return /^[A-Za-z0-9._-]{1,64}$/.test(value) ? value : null;
}

/** Only accept relative durations (7d, 24h) or ISO-ish timestamps for --since. */
export function safeSince(value: string | undefined, fallback: string): string {
  if (!value) return fallback;
  if (/^[0-9]{1,4}[smhdw]$/.test(value)) return value;
  if (/^[0-9]{4}-[0-9]{2}-[0-9]{2}[T0-9:.Z+-]*$/.test(value)) return value;
  return fallback;
}

function fromFlag(): string {
  const agent = safeIdentifier(process.env.HOOKS_FLEET_AGENT);
  return agent ? ` --from ${agent}` : "";
}

/**
 * Run a CLI command, resolving stdout or null on any failure (fail-open).
 * Async so the three catchup reads run in parallel — worst-case session-start
 * cost is one timeout, not the sum of three.
 */
function tryExec(command: string): Promise<string | null> {
  return new Promise((resolve) => {
    try {
      exec(command, { encoding: "utf-8", timeout: timeoutMs() }, (err, stdout) => {
        resolve(err ? null : (stdout ?? "").trim() || null);
      });
    } catch {
      resolve(null);
    }
  });
}

/** Parse CLI JSON that may be an array or an object wrapping an array. */
export function parseJsonList(raw: string | null, ...wrapperKeys: string[]): unknown[] {
  if (!raw) return [];
  try {
    const data = JSON.parse(raw);
    if (Array.isArray(data)) return data;
    if (data && typeof data === "object") {
      for (const key of wrapperKeys) {
        const inner = (data as Record<string, unknown>)[key];
        if (Array.isArray(inner)) return inner;
      }
    }
    return [];
  } catch {
    return [];
  }
}

/** True when raw CLI output was parseable as the expected list shape. */
export function hasJsonList(raw: string | null, ...wrapperKeys: string[]): boolean {
  if (!raw) return false;
  try {
    const data = JSON.parse(raw);
    if (Array.isArray(data)) return true;
    if (data && typeof data === "object") {
      return wrapperKeys.some((key) => Array.isArray((data as Record<string, unknown>)[key]));
    }
    return false;
  } catch {
    return false;
  }
}

/** Read the last catchup timestamp; fall back to a bounded 24h lookback. */
export function resolveSince(now: Date, stored: string | null): string {
  if (stored) {
    const parsed = new Date(stored.trim());
    if (!Number.isNaN(parsed.getTime()) && parsed.getTime() <= now.getTime()) {
      return parsed.toISOString();
    }
  }
  return new Date(now.getTime() - DEFAULT_LOOKBACK_MS).toISOString();
}

function readLastSeen(): string | null {
  try {
    if (!existsSync(LAST_SEEN_FILE)) return null;
    return readFileSync(LAST_SEEN_FILE, "utf-8");
  } catch {
    return null;
  }
}

function writeLastSeen(now: Date): void {
  try {
    mkdirSync(STATE_DIR, { recursive: true });
    writeFileSync(LAST_SEEN_FILE, now.toISOString());
  } catch {
    // fail-open: state is an optimization, not a requirement
  }
}

function describeItem(item: unknown): string {
  if (!item || typeof item !== "object") return String(item);
  const m = item as Record<string, unknown>;
  const from = typeof m.from === "string" ? m.from : typeof m.sender === "string" ? m.sender : "unknown";
  const channel = typeof m.channel === "string" ? m.channel : typeof m.channel_name === "string" ? m.channel_name : null;
  const body =
    typeof m.preview === "string" ? m.preview :
    typeof m.content === "string" ? m.content :
    typeof m.message === "string" ? m.message : JSON.stringify(m).slice(0, 200);
  const time = typeof m.created_at === "string" ? m.created_at : typeof m.timestamp === "string" ? m.timestamp : "";
  const where = channel ? ` #${channel}` : "";
  return `- [${time}]${where} ${from}: ${truncate(body, 300)}`;
}

export function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/** Build the injected context from the three catchup sections. */
export function formatCatchup(
  blockers: unknown[],
  notifications: unknown[],
  digestRaw: string | null
): string | null {
  const sections: string[] = [];

  if (blockers.length > 0) {
    sections.push(
      `UNREAD BLOCKING MESSAGES (${blockers.length}) — resolve before starting work:\n` +
        blockers.slice(0, 10).map(describeItem).join("\n")
    );
  }

  if (notifications.length > 0) {
    sections.push(
      `CHANNEL NOTIFICATIONS since last catchup (${notifications.length}):\n` +
        notifications.slice(0, 15).map(describeItem).join("\n")
    );
  }

  if (digestRaw) {
    try {
      const digest = JSON.parse(digestRaw) as Record<string, unknown>;
      const messages = Array.isArray(digest.messages) ? digest.messages : [];
      if (messages.length > 0) {
        sections.push(
          `ANNOUNCEMENTS digest (unread, last 7d, ${messages.length} shown):\n` +
            messages.slice(0, 15).map(describeItem).join("\n")
        );
      }
    } catch {
      // unparseable digest → skip section
    }
  }

  if (sections.length === 0) return null;

  return (
    `[hook-fleet-catchup] Fleet communications catchup:\n\n` +
    sections.join("\n\n") +
    `\n\nRead-duty: handle blockers before claiming work; an unread [FREEZE] means stop and escalate to #help.`
  );
}

export async function run(): Promise<void> {
  if (process.env.HOOKS_FLEET_CATCHUP_DISABLE === "1") {
    respond({ continue: true });
    return;
  }

  const input = readStdinJson();
  if (!input) {
    respond({ continue: true });
    return;
  }

  const now = new Date();
  const from = fromFlag();
  const since = resolveSince(now, readLastSeen());
  const window = safeSince(process.env.HOOKS_FLEET_SINCE, "7d");

  // The three catchup reads run in parallel — all fail-open independently:
  // 1. unread blocking messages
  // 2. channel notifications since last catchup (bounded lookback)
  // 3. bounded announcements digest (never hands a session full history)
  const [blockersRaw, notificationsRaw, digestRaw] = await Promise.all([
    tryExec(`conversations blockers -j${from}`),
    tryExec(`conversations notifications --since ${since} -j${from}`),
    tryExec(`conversations digest announcements --unread --since ${window} -j${from}`),
  ]);

  const blockers = parseJsonList(blockersRaw, "blockers", "messages");
  const notifications = parseJsonList(notificationsRaw, "notifications", "messages");

  // Advance the last-seen cursor ONLY when the notifications read succeeded
  // and returned the expected JSON shape. Otherwise bad output at session
  // start would silently swallow the window.
  if (hasJsonList(notificationsRaw, "notifications", "messages")) {
    writeLastSeen(now);
  }

  const context = formatCatchup(blockers, notifications, digestRaw);
  if (context) {
    respond({
      continue: true,
      hookSpecificOutput: {
        hookEventName: "SessionStart",
        additionalContext: context,
      },
    });
    return;
  }

  respond({ continue: true });
}

if (import.meta.main) {
  void run();
}
