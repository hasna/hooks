#!/usr/bin/env bun

/**
 * Claude Code Hook: errornotify
 *
 * PostToolUse hook that detects tool failures and logs errors to SQLite (~/.hooks/hooks.db).
 * Also writes warnings to stderr for immediate terminal visibility.
 * Never blocks — always outputs { continue: true }.
 */

import { readFileSync } from "fs";
import { writeHookEvent } from "../../../src/lib/db-writer";

interface HookInput {
  session_id: string;
  cwd: string;
  tool_name: string;
  tool_input: Record<string, unknown>;
  tool_output?: Record<string, unknown>;
}

interface HookOutput {
  continue: true;
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

function detectError(input: HookInput): { isError: boolean; message: string } {
  const output = input.tool_output || {};

  const exitCode = output.exit_code ?? output.exitCode ?? output.code;
  if (exitCode !== undefined && exitCode !== null && exitCode !== 0) {
    const stderr = (output.stderr as string) || (output.output as string) || "unknown error";
    return { isError: true, message: `Exit code ${exitCode}: ${truncate(stderr, 200)}` };
  }

  if (output.error && typeof output.error === "string") {
    return { isError: true, message: `Error: ${truncate(output.error, 200)}` };
  }

  const outputText =
    (output.stderr as string) ||
    (output.output as string) ||
    (output.content as string) ||
    (output.text as string) ||
    "";

  if (typeof outputText === "string" && outputText.length > 0) {
    const errorPatterns = [
      /^error:/im,
      /^fatal:/im,
      /^panic:/im,
      /command not found/i,
      /permission denied/i,
      /no such file or directory/i,
      /segmentation fault/i,
      /killed/i,
      /ENOENT/,
      /EACCES/,
      /EPERM/,
      /ENOMEM/,
      /TypeError:/,
      /ReferenceError:/,
      /SyntaxError:/,
      /ModuleNotFoundError:/,
      /ImportError:/,
      /FileNotFoundError:/,
      /PermissionError:/,
      /traceback \(most recent call last\)/i,
    ];

    for (const pattern of errorPatterns) {
      if (pattern.test(outputText)) {
        const lines = outputText.split("\n").filter((l: string) => l.trim());
        const errorLine = lines.find((l: string) => pattern.test(l)) || lines[0] || "";
        return { isError: true, message: truncate(errorLine.trim(), 200) };
      }
    }
  }

  return { isError: false, message: "" };
}

function truncate(str: string, maxLen: number): string {
  if (str.length <= maxLen) return str;
  return str.slice(0, maxLen) + "...";
}

function getToolContext(input: HookInput): string {
  const toolName = input.tool_name;
  const toolInput = input.tool_input || {};

  switch (toolName) {
    case "Bash":
      return `Bash: ${truncate((toolInput.command as string) || "unknown command", 100)}`;
    case "Write":
    case "Edit":
      return `${toolName}: ${(toolInput.file_path as string) || "unknown file"}`;
    case "Read":
      return `Read: ${(toolInput.file_path as string) || "unknown file"}`;
    default:
      return toolName;
  }
}

function respond(): void {
  const output: HookOutput = { continue: true };
  console.log(JSON.stringify(output));
}

export function run(): void {
  const input = readStdinJson();

  if (!input) {
    respond();
    return;
  }

  const { isError, message } = detectError(input);

  if (isError) {
    const toolContext = getToolContext(input);

    // Keep stderr warnings for immediate terminal visibility
    process.stderr.write(`[hook-errornotify] FAILURE in ${toolContext}\n`);
    process.stderr.write(`[hook-errornotify] ${message}\n`);

    writeHookEvent({
      session_id: input.session_id,
      hook_name: "errornotify",
      event_type: "PostToolUse",
      tool_name: input.tool_name,
      tool_input: JSON.stringify(input.tool_input),
      error: message,
      project_dir: input.cwd,
    });
  }

  respond();
}

if (import.meta.main) {
  run();
}
