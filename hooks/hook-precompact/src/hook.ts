#!/usr/bin/env bun

/**
 * Claude Code Hook: precompact
 *
 * PreCompact hook that saves session state/handoff data before
 * context compaction to prevent information loss in long sessions.
 *
 * Creates timestamped handoff files in .claude-handoffs/ with:
 * - Session ID and timestamp
 * - Current working directory
 * - Git branch and recent changes
 * - Task list state (if any)
 * - Environment context
 */

import { readFileSync, existsSync, mkdirSync, writeFileSync, appendFileSync } from "fs";
import { execSync } from "child_process";
import { join } from "path";

interface HookInput {
  session_id: string;
  cwd: string;
  hook_event_name: string;
  transcript_summary?: string;
}

interface HookOutput {
  continue?: boolean;
}

const HANDOFF_DIR = ".claude-handoffs";

function readStdinJson(): HookInput | null {
  try {
    const input = readFileSync(0, "utf-8").trim();
    if (!input) return null;
    return JSON.parse(input);
  } catch {
    return null;
  }
}

function safeExec(cmd: string, cwd: string): string {
  try {
    return execSync(cmd, { cwd, encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] }).trim();
  } catch {
    return "";
  }
}

function getGitContext(cwd: string): Record<string, string> {
  const branch = safeExec("git rev-parse --abbrev-ref HEAD", cwd);
  const lastCommit = safeExec("git log -1 --oneline", cwd);
  const status = safeExec("git status --short", cwd);
  const recentCommits = safeExec("git log -5 --oneline", cwd);

  return { branch, lastCommit, status, recentCommits };
}

function createHandoff(input: HookInput): void {
  const handoffDir = join(input.cwd, HANDOFF_DIR);
  mkdirSync(handoffDir, { recursive: true });

  // Ensure it's gitignored
  const gitignorePath = join(input.cwd, ".gitignore");
  if (existsSync(gitignorePath)) {
    const content = readFileSync(gitignorePath, "utf-8");
    if (!content.includes(HANDOFF_DIR)) {
      appendFileSync(gitignorePath, `\n${HANDOFF_DIR}/\n`);
    }
  }

  const timestamp = new Date().toISOString();
  const gitContext = getGitContext(input.cwd);

  const handoff = {
    session_id: input.session_id,
    timestamp,
    cwd: input.cwd,
    event: "PreCompact",
    git: gitContext,
    summary: input.transcript_summary || null,
  };

  // Write timestamped handoff file
  const filename = `handoff-${timestamp.replace(/[:.]/g, "-")}.json`;
  writeFileSync(join(handoffDir, filename), JSON.stringify(handoff, null, 2));

  // Also write a "latest" file for easy access
  writeFileSync(join(handoffDir, "latest.json"), JSON.stringify(handoff, null, 2));

  // Append to log
  const logEntry = `[${timestamp}] PreCompact handoff saved (session: ${input.session_id})\n`;
  appendFileSync(join(handoffDir, "handoff.log"), logEntry);
}

function respond(output: HookOutput): void {
  console.log(JSON.stringify(output));
}

export function run(): void {
  const input = readStdinJson();

  if (!input) {
    respond({ continue: true });
    return;
  }

  try {
    createHandoff(input);
  } catch (error) {
    const errMsg = error instanceof Error ? error.message : String(error);
    console.error(`[hook-precompact] Warning: handoff save failed: ${errMsg}`);
  }

  respond({ continue: true });
}

if (import.meta.main) {
  run();
}
