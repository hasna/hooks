#!/usr/bin/env bun

/**
 * Claude Code Hook: sessionlog
 *
 * PostToolUse hook that logs every tool call to SQLite (~/.hooks/hooks.db).
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

  writeHookEvent({
    session_id: input.session_id,
    hook_name: "sessionlog",
    event_type: "PostToolUse",
    tool_name: input.tool_name,
    tool_input: JSON.stringify(input.tool_input),
    project_dir: input.cwd,
  });

  respond({ continue: true });
}

if (import.meta.main) {
  run();
}
