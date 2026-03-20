#!/usr/bin/env bun

/**
 * Claude Code Hook: filelock
 *
 * PreToolUse hook that checks for file locks before any Edit/Write/NotebookEdit.
 * Creates locks in ~/.hooks/locks/ so multiple agents can coordinate editing.
 *
 * Lock files are automatically expired after 30 minutes.
 * The same session can always edit its own locked files.
 */

import { readFileSync, existsSync, mkdirSync, writeFileSync, unlinkSync } from "fs";
import { join, basename } from "path";
import { homedir } from "os";

interface HookInput {
  session_id: string;
  cwd: string;
  tool_name: string;
  tool_input: Record<string, unknown>;
}

interface HookOutput {
  decision: "approve" | "block";
  reason?: string;
}

interface LockEntry {
  file: string;
  session_id: string;
  agent?: string;
  locked_at: string;
  expires_at: string;
}

const LOCK_DIR = join(homedir(), ".hooks", "locks");
const LOCK_TTL_MS = 30 * 60 * 1000; // 30 minutes

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

function getLockFilePath(filePath: string): string {
  const safe = filePath.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 200);
  return join(LOCK_DIR, `${safe}.lock`);
}

function checkFileLock(
  filePath: string,
  sessionId: string
): { locked: boolean; lockedBy?: string; lockedAt?: string } {
  const lockFilePath = getLockFilePath(filePath);
  if (!existsSync(lockFilePath)) return { locked: false };

  try {
    const lock: LockEntry = JSON.parse(readFileSync(lockFilePath, "utf-8"));

    // Expire old locks
    if (new Date(lock.expires_at).getTime() < Date.now()) {
      try {
        unlinkSync(lockFilePath);
      } catch {}
      return { locked: false };
    }

    // Same session — allow
    if (lock.session_id === sessionId) return { locked: false };

    return {
      locked: true,
      lockedBy: lock.agent || lock.session_id.slice(0, 8),
      lockedAt: lock.locked_at,
    };
  } catch {
    return { locked: false };
  }
}

function acquireLock(filePath: string, sessionId: string): void {
  mkdirSync(LOCK_DIR, { recursive: true });
  const now = new Date();
  const lock: LockEntry = {
    file: filePath,
    session_id: sessionId,
    agent: process.env.HOOKS_AGENT_NAME,
    locked_at: now.toISOString(),
    expires_at: new Date(now.getTime() + LOCK_TTL_MS).toISOString(),
  };
  writeFileSync(getLockFilePath(filePath), JSON.stringify(lock, null, 2));
}

export function run(): void {
  const input = readStdinJson();

  if (!input) {
    respond({ decision: "approve" });
    return;
  }

  const filePath = (input.tool_input.file_path || input.tool_input.notebook_path) as
    | string
    | undefined;

  if (!filePath) {
    respond({ decision: "approve" });
    return;
  }

  const { locked, lockedBy, lockedAt } = checkFileLock(filePath, input.session_id);

  if (locked) {
    const name = basename(filePath);
    const age = lockedAt
      ? ` (locked ${Math.round((Date.now() - new Date(lockedAt).getTime()) / 60000)}m ago)`
      : "";
    console.error(`[hook-filelock] Blocked: ${name} is locked by ${lockedBy}${age}`);
    respond({
      decision: "block",
      reason: `File '${name}' is locked by another agent (${lockedBy})${age}. Wait for the lock to be released or coordinate first.`,
    });
    return;
  }

  // Acquire lock for this session
  try {
    acquireLock(filePath, input.session_id);
  } catch (err) {
    console.error(`[hook-filelock] Could not write lock: ${err}`);
  }

  respond({ decision: "approve" });
}

if (import.meta.main) {
  run();
}
