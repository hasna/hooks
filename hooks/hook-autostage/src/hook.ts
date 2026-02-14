#!/usr/bin/env bun

/**
 * Claude Code Hook: autostage
 *
 * PostToolUse hook that automatically runs `git add <file>` after
 * Claude edits or writes a file. Only stages if:
 * - The project is a git repo (.git directory exists)
 * - The file is not in .gitignore
 *
 * Matcher: Edit|Write
 * Always outputs { continue: true } — never blocks.
 */

import { readFileSync, existsSync } from "fs";
import { execSync } from "child_process";
import { join, resolve } from "path";

interface HookInput {
  session_id: string;
  cwd: string;
  tool_name: string;
  tool_input: Record<string, unknown>;
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
 * Check if a directory is inside a git repository
 */
function isGitRepo(cwd: string): boolean {
  try {
    execSync("git rev-parse --is-inside-work-tree", {
      cwd,
      stdio: "pipe",
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * Check if a file is ignored by .gitignore
 */
function isGitIgnored(cwd: string, filePath: string): boolean {
  try {
    // git check-ignore exits 0 if file IS ignored, 1 if NOT ignored
    execSync(`git check-ignore -q "${filePath}"`, {
      cwd,
      stdio: "pipe",
    });
    return true; // Exit 0 → file is ignored
  } catch {
    return false; // Exit 1 → file is NOT ignored
  }
}

/**
 * Stage a file with git add
 */
function stageFile(cwd: string, filePath: string): boolean {
  try {
    execSync(`git add "${filePath}"`, {
      cwd,
      stdio: "pipe",
    });
    return true;
  } catch (error) {
    const errMsg = error instanceof Error ? error.message : String(error);
    console.error(`[hook-autostage] Failed to stage ${filePath}: ${errMsg}`);
    return false;
  }
}

/**
 * Extract file path from tool input
 */
function getFilePath(toolInput: Record<string, unknown>): string | null {
  return (toolInput.file_path as string) || null;
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

  // Only handle Edit and Write tools
  if (input.tool_name !== "Edit" && input.tool_name !== "Write") {
    respond();
    return;
  }

  const filePath = getFilePath(input.tool_input || {});

  if (!filePath) {
    console.error("[hook-autostage] No file_path found in tool_input");
    respond();
    return;
  }

  const cwd = input.cwd;

  // Check if this is a git repo
  if (!isGitRepo(cwd)) {
    console.error("[hook-autostage] Not a git repo, skipping");
    respond();
    return;
  }

  // Resolve the file path relative to cwd
  const absPath = resolve(cwd, filePath);

  // Check if file exists
  if (!existsSync(absPath)) {
    console.error(`[hook-autostage] File does not exist: ${filePath}`);
    respond();
    return;
  }

  // Check if file is gitignored
  if (isGitIgnored(cwd, filePath)) {
    console.error(`[hook-autostage] File is gitignored, skipping: ${filePath}`);
    respond();
    return;
  }

  // Stage the file
  if (stageFile(cwd, filePath)) {
    console.error(`[hook-autostage] Staged: ${filePath}`);
  }

  respond();
}

if (import.meta.main) {
  run();
}
