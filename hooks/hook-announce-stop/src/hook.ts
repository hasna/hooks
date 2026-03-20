#!/usr/bin/env bun

/**
 * Claude Code Hook: announce-stop
 *
 * Stop hook that:
 * 1. Releases all file locks held by this session
 * 2. Posts a summary to the agent's conversation space
 * 3. Updates in-progress tasks to reflect the session ending
 */

import { readFileSync, existsSync, readdirSync, unlinkSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import { execSync } from "child_process";

interface HookInput {
  session_id: string;
  cwd: string;
  hook_event_name: string;
  transcript_path?: string;
}

interface HookOutput {
  continue: boolean;
}

interface LockEntry {
  file: string;
  session_id: string;
  agent?: string;
  locked_at: string;
  expires_at: string;
}

const LOCK_DIR = join(homedir(), ".hooks", "locks");

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

function releaseSessionLocks(sessionId: string): string[] {
  const released: string[] = [];

  if (!existsSync(LOCK_DIR)) return released;

  try {
    const files = readdirSync(LOCK_DIR).filter((f) => f.endsWith(".lock"));

    for (const file of files) {
      const lockPath = join(LOCK_DIR, file);
      try {
        const lock: LockEntry = JSON.parse(readFileSync(lockPath, "utf-8"));
        if (lock.session_id === sessionId) {
          unlinkSync(lockPath);
          released.push(lock.file);
        }
      } catch {}
    }
  } catch {}

  return released;
}

function getProjectName(cwd: string): string {
  return cwd.split("/").filter(Boolean).pop() || "project";
}

function buildSummary(
  input: HookInput,
  releasedLocks: string[]
): string {
  const project = getProjectName(input.cwd);
  const agent = process.env.HOOKS_AGENT_NAME || `session:${input.session_id.slice(0, 8)}`;
  const lines: string[] = [
    `Agent **${agent}** finished working on **${project}**.`,
  ];

  if (releasedLocks.length > 0) {
    const names = releasedLocks.map((f) => f.split("/").pop()).join(", ");
    lines.push(`Released locks: ${names}`);
  }

  lines.push(`Session: \`${input.session_id.slice(0, 8)}\``);
  return lines.join(" | ");
}

function postToSpace(summary: string): void {
  const space = process.env.HOOKS_SPACE || "general";
  try {
    execSync(`conversations send "${summary.replace(/"/g, "'")}" --space "${space}"`, {
      encoding: "utf-8",
      timeout: 10_000,
      stdio: ["pipe", "pipe", "pipe"],
    });
    console.error(`[hook-announce-stop] Posted to space '${space}'`);
  } catch {
    console.error(`[hook-announce-stop] Could not post to space (conversations CLI unavailable)`);
  }
}

function updateInProgressTasks(sessionId: string): void {
  try {
    // List tasks in_progress assigned to this session and add a note
    const output = execSync(
      `todos list --status in_progress --json`,
      { encoding: "utf-8", timeout: 10_000, stdio: ["pipe", "pipe", "pipe"] }
    );
    const tasks = JSON.parse(output.trim());
    if (!Array.isArray(tasks) || tasks.length === 0) return;

    for (const task of tasks.slice(0, 10)) {
      if (!task.id) continue;
      try {
        execSync(
          `todos comment ${task.id} "Session ${sessionId.slice(0, 8)} ended — task may need to be resumed"`,
          { encoding: "utf-8", timeout: 5_000, stdio: ["pipe", "pipe", "pipe"] }
        );
      } catch {}
    }
  } catch {}
}

export function run(): void {
  const input = readStdinJson();

  if (!input) {
    respond({ continue: true });
    return;
  }

  // 1. Release all file locks held by this session
  const released = releaseSessionLocks(input.session_id);
  if (released.length > 0) {
    console.error(`[hook-announce-stop] Released ${released.length} lock(s)`);
  }

  // 2. Post summary to conversation space
  const summary = buildSummary(input, released);
  postToSpace(summary);

  // 3. Update any in-progress tasks
  updateInProgressTasks(input.session_id);

  respond({ continue: true });
}

if (import.meta.main) {
  run();
}
