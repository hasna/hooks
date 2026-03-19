#!/usr/bin/env bun

/**
 * Claude Code Hook: commandlog
 *
 * PostToolUse hook that logs every Bash command to SQLite (~/.hooks/hooks.db).
 */

import { readFileSync } from "fs";
import { writeHookEvent } from "../../../src/lib/db-writer";

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

  const command = (input.tool_input.command as string) || "(unknown command)";
  const exitCode = input.tool_input.exit_code;

  writeHookEvent({
    session_id: input.session_id,
    hook_name: "commandlog",
    event_type: "PostToolUse",
    tool_name: "Bash",
    tool_input: command,
    project_dir: input.cwd,
    metadata: exitCode !== undefined && exitCode !== null ? JSON.stringify({ exit_code: exitCode }) : null,
  });

  respond({ continue: true });
}

if (import.meta.main) {
  run();
}
