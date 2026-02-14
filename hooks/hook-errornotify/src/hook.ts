#!/usr/bin/env bun

/**
 * Claude Code Hook: errornotify
 *
 * PostToolUse hook that detects tool failures and logs errors.
 * Checks tool output for error indicators (non-zero exit codes,
 * error messages) and logs warnings to stderr. Optionally writes
 * to a .claude/errors.log file for persistent error tracking.
 *
 * Never blocks — always outputs { continue: true }.
 */

import { readFileSync, appendFileSync, mkdirSync, existsSync } from "fs";
import { join } from "path";

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

/**
 * Read and parse JSON from stdin
 */
function readStdinJson(): HookInput | null {
  try {
    const input = readFileSync(0, "utf-8").trim();
    if (!input) return null;
    return JSON.parse(input);
  } catch {
    return null;
  }
}

/**
 * Check if the tool output indicates a failure
 */
function detectError(input: HookInput): { isError: boolean; message: string } {
  const output = input.tool_output || {};

  // Check for explicit exit code
  const exitCode = output.exit_code ?? output.exitCode ?? output.code;
  if (exitCode !== undefined && exitCode !== null && exitCode !== 0) {
    const stderr = (output.stderr as string) || (output.output as string) || "unknown error";
    return {
      isError: true,
      message: `Exit code ${exitCode}: ${truncate(stderr, 200)}`,
    };
  }

  // Check for error field
  if (output.error && typeof output.error === "string") {
    return {
      isError: true,
      message: `Error: ${truncate(output.error, 200)}`,
    };
  }

  // Check output text for common error indicators
  const outputText =
    (output.stderr as string) ||
    (output.output as string) ||
    (output.content as string) ||
    (output.text as string) ||
    "";

  if (typeof outputText === "string" && outputText.length > 0) {
    // Check for common error patterns in output
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
        // Extract the first relevant line
        const lines = outputText.split("\n").filter((l: string) => l.trim());
        const errorLine = lines.find((l: string) => pattern.test(l)) || lines[0] || "";
        return {
          isError: true,
          message: truncate(errorLine.trim(), 200),
        };
      }
    }
  }

  return { isError: false, message: "" };
}

/**
 * Truncate a string to a maximum length
 */
function truncate(str: string, maxLen: number): string {
  if (str.length <= maxLen) return str;
  return str.slice(0, maxLen) + "...";
}

/**
 * Get a human-readable description of what was being executed
 */
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

/**
 * Write error to .claude/errors.log
 */
function writeErrorLog(cwd: string, toolContext: string, errorMessage: string, sessionId: string): void {
  try {
    const claudeDir = join(cwd, ".claude");
    if (!existsSync(claudeDir)) {
      mkdirSync(claudeDir, { recursive: true });
    }

    const logFile = join(claudeDir, "errors.log");
    const timestamp = new Date().toISOString();
    const entry = `[${timestamp}] [session:${sessionId.slice(0, 8)}] ${toolContext} — ${errorMessage}\n`;
    appendFileSync(logFile, entry);
  } catch {
    // Silently fail — logging should never cause issues
  }
}

/**
 * Output hook response
 */
function respond(): void {
  const output: HookOutput = { continue: true };
  console.log(JSON.stringify(output));
}

/**
 * Main hook execution
 */
export function run(): void {
  const input = readStdinJson();

  if (!input) {
    respond();
    return;
  }

  const { isError, message } = detectError(input);

  if (isError) {
    const toolContext = getToolContext(input);
    console.error(`[hook-errornotify] FAILURE in ${toolContext}`);
    console.error(`[hook-errornotify] ${message}`);

    // Write to persistent error log
    writeErrorLog(input.cwd, toolContext, message, input.session_id);
  }

  respond();
}

if (import.meta.main) {
  run();
}
