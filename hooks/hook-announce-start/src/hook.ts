#!/usr/bin/env bun

/**
 * Claude Code Hook: announce-start
 *
 * SessionStart hook that fires when a session starts (or resumes).
 * - Registers the agent profile if not already registered
 * - Reads unread DMs/context and injects them into session context
 * - Announces presence to the team space
 *
 * Uses a per-session marker so resume/clear/compact SessionStart events
 * do not re-announce the same session.
 */

import { readFileSync, existsSync, mkdirSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { execSync } from "child_process";

interface HookInput {
  session_id: string;
  cwd: string;
  hook_event_name: string;
  /** SessionStart provides how the session began: startup | resume | clear | compact */
  source?: string;
}

interface HookOutput {
  continue: boolean;
  hookSpecificOutput?: {
    hookEventName: "SessionStart";
    additionalContext: string;
  };
}

const STATE_DIR = join(tmpdir(), "hook-announce-start");

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

function sanitizeId(id: string): string {
  return id.replace(/[^a-zA-Z0-9_-]/g, "-").slice(0, 64);
}

function hasAlreadyAnnounced(sessionId: string): boolean {
  const safe = sanitizeId(sessionId);
  return existsSync(join(STATE_DIR, `${safe}.announced`));
}

function markAnnounced(sessionId: string): void {
  mkdirSync(STATE_DIR, { recursive: true });
  const safe = sanitizeId(sessionId);
  writeFileSync(join(STATE_DIR, `${safe}.announced`), new Date().toISOString());
}

function registerAgentProfile(): void {
  try {
    execSync("hooks init", {
      encoding: "utf-8",
      timeout: 5_000,
      stdio: ["pipe", "pipe", "pipe"],
    });
  } catch {}
}

function fetchContext(): string | null {
  try {
    const output = execSync("conversations context", {
      encoding: "utf-8",
      timeout: 10_000,
      stdio: ["pipe", "pipe", "pipe"],
    });
    return output.trim() || null;
  } catch {
    return null;
  }
}

/** Strip anything shell-unsafe from values interpolated into the announce command. */
function shellSafe(value: string, fallback: string): string {
  const cleaned = value.replace(/[^A-Za-z0-9 ._:-]/g, "").trim().slice(0, 64);
  return cleaned || fallback;
}

function announceToSpace(cwd: string, sessionId: string): void {
  const project = shellSafe(cwd.split("/").filter(Boolean).pop() || "", "project");
  const agent = shellSafe(process.env.HOOKS_AGENT_NAME || "", `session:${sanitizeId(sessionId).slice(0, 8)}`);
  const space = shellSafe(process.env.HOOKS_SPACE || "", "general");
  const message = `Agent **${agent}** started a session on **${project}**`;

  try {
    execSync(`conversations send "${message}" --space "${space}"`, {
      encoding: "utf-8",
      timeout: 10_000,
      stdio: ["pipe", "pipe", "pipe"],
    });
    console.error(`[hook-announce-start] Announced to space '${space}'`);
  } catch {
    console.error(`[hook-announce-start] Could not post to space`);
  }
}

export function run(): void {
  const input = readStdinJson();

  if (!input) {
    respond({ continue: true });
    return;
  }

  // Only fire once per session (SessionStart also fires on resume/clear/compact)
  if (hasAlreadyAnnounced(input.session_id)) {
    respond({ continue: true });
    return;
  }

  markAnnounced(input.session_id);

  // 1. Register agent profile
  registerAgentProfile();

  // 2. Fetch context (unread DMs + online agents + spaces)
  const context = fetchContext();

  // 3. Announce to team space
  announceToSpace(input.cwd, input.session_id);

  // 4. Inject fetched context into the session (SessionStart supports additionalContext)
  if (context) {
    respond({
      continue: true,
      hookSpecificOutput: {
        hookEventName: "SessionStart",
        additionalContext: `[hook-announce-start] Session context:\n${context}`,
      },
    });
    return;
  }

  respond({ continue: true });
}

if (import.meta.main) {
  run();
}
