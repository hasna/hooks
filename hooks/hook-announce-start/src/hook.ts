#!/usr/bin/env bun

/**
 * Claude Code Hook: announce-start
 *
 * Notification hook that fires on session start (first notification).
 * - Registers the agent profile if not already registered
 * - Reads unread DMs and injects them into context
 * - Announces presence to the team space
 *
 * Uses a per-session marker to only fire once per session.
 */

import { readFileSync, existsSync, mkdirSync, writeFileSync } from "fs";
import { join } from "path";
import { homedir, tmpdir } from "os";
import { execSync } from "child_process";

interface HookInput {
  session_id: string;
  cwd: string;
  hook_event_name: string;
  notification_type?: string;
}

interface HookOutput {
  continue: boolean;
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

function announceToSpace(cwd: string, sessionId: string): void {
  const project = cwd.split("/").filter(Boolean).pop() || "project";
  const agent = process.env.HOOKS_AGENT_NAME || `session:${sessionId.slice(0, 8)}`;
  const space = process.env.HOOKS_SPACE || "general";
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

  // Only fire once per session
  if (hasAlreadyAnnounced(input.session_id)) {
    respond({ continue: true });
    return;
  }

  markAnnounced(input.session_id);

  // 1. Register agent profile
  registerAgentProfile();

  // 2. Fetch context (unread DMs + online agents + spaces)
  const context = fetchContext();
  if (context) {
    process.stderr.write(
      `[hook-announce-start] Session context:\n${context}\n`
    );
  }

  // 3. Announce to team space
  announceToSpace(input.cwd, input.session_id);

  respond({ continue: true });
}

if (import.meta.main) {
  run();
}
