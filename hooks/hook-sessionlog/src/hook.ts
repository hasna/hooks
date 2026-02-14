#!/usr/bin/env bun

/**
 * Claude Code Hook: sessionlog
 *
 * PostToolUse hook that logs every tool call to a session log file.
 * Creates .claude/session-log-<date>.jsonl in the project directory.
 *
 * Each line is a JSON object with:
 * - timestamp: ISO string
 * - tool_name: name of the tool that was called
 * - tool_input: first 500 characters of the stringified tool input
 * - session_id: current session ID
 */

import { readFileSync, existsSync, mkdirSync, appendFileSync } from "fs";
import { join } from "path";

interface HookInput {
  session_id: string;
  cwd: string;
  tool_name: string;
  tool_input: Record<string, unknown>;
}

interface HookOutput {
  continue: boolean;
}

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

function getDateString(): string {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function truncate(str: string, maxLength: number): string {
  if (str.length <= maxLength) return str;
  return str.slice(0, maxLength) + "...";
}

function logToolCall(input: HookInput): void {
  const claudeDir = join(input.cwd, ".claude");

  // Create .claude/ directory if it doesn't exist
  if (!existsSync(claudeDir)) {
    mkdirSync(claudeDir, { recursive: true });
  }

  const dateStr = getDateString();
  const logFile = join(claudeDir, `session-log-${dateStr}.jsonl`);

  const toolInputStr = truncate(JSON.stringify(input.tool_input), 500);

  const logEntry = {
    timestamp: new Date().toISOString(),
    tool_name: input.tool_name,
    tool_input: toolInputStr,
    session_id: input.session_id,
  };

  appendFileSync(logFile, JSON.stringify(logEntry) + "\n");
}

export function run(): void {
  const input = readStdinJson();

  if (!input) {
    respond({ continue: true });
    return;
  }

  try {
    logToolCall(input);
  } catch (error) {
    const errMsg = error instanceof Error ? error.message : String(error);
    console.error(`[hook-sessionlog] Warning: failed to log tool call: ${errMsg}`);
  }

  respond({ continue: true });
}

if (import.meta.main) {
  run();
}
