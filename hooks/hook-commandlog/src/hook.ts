#!/usr/bin/env bun

/**
 * Claude Code Hook: commandlog
 *
 * PostToolUse hook that logs every bash command Claude runs to
 * .claude/commands.log in the project directory.
 *
 * Format: [ISO timestamp] <exit_code> <command>
 * One command per line.
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

function logCommand(input: HookInput): void {
  const claudeDir = join(input.cwd, ".claude");

  // Create .claude/ directory if it doesn't exist
  if (!existsSync(claudeDir)) {
    mkdirSync(claudeDir, { recursive: true });
  }

  const logFile = join(claudeDir, "commands.log");
  const timestamp = new Date().toISOString();
  const command = (input.tool_input.command as string) || "(unknown command)";
  const exitCode = input.tool_input.exit_code;

  // Format: [timestamp] exit_code command
  // If exit_code is available, include it; otherwise just log the command
  let logLine: string;
  if (exitCode !== undefined && exitCode !== null) {
    logLine = `[${timestamp}] exit=${exitCode} ${command}\n`;
  } else {
    logLine = `[${timestamp}] ${command}\n`;
  }

  appendFileSync(logFile, logLine);
}

export function run(): void {
  const input = readStdinJson();

  if (!input) {
    respond({ continue: true });
    return;
  }

  // Only log Bash tool calls
  if (input.tool_name !== "Bash") {
    respond({ continue: true });
    return;
  }

  try {
    logCommand(input);
  } catch (error) {
    const errMsg = error instanceof Error ? error.message : String(error);
    console.error(`[hook-commandlog] Warning: failed to log command: ${errMsg}`);
  }

  respond({ continue: true });
}

if (import.meta.main) {
  run();
}
