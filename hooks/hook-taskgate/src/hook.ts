#!/usr/bin/env bun

/**
 * Claude Code Hook: taskgate
 *
 * TaskCompleted hook that validates a task is actually complete before
 * allowing it to be marked done. Lightweight gate designed to be
 * extended by users with custom validation logic.
 *
 * Current checks:
 * - If task mentions "test" or "tests", verifies test files exist in cwd
 * - If task mentions "lint" or "format", approves (can't verify externally)
 * - For all other tasks, approves by default
 */

import { readFileSync, existsSync, readdirSync } from "fs";
import { join } from "path";

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
 * Recursively check if any test files exist in a directory
 * Looks for common test file patterns: *.test.*, *.spec.*, test_*, *_test.*
 */
function hasTestFiles(dir: string, depth: number = 0): boolean {
  if (depth > 4) return false; // Don't recurse too deep

  try {
    const entries = readdirSync(dir, { withFileTypes: true });

    for (const entry of entries) {
      const name = entry.name;

      // Skip node_modules, .git, dist, build, etc.
      if (entry.isDirectory()) {
        if (["node_modules", ".git", "dist", "build", ".next", "coverage", "__pycache__"].includes(name)) {
          continue;
        }

        // Check common test directories
        if (["test", "tests", "__tests__", "spec", "specs"].includes(name)) {
          return true;
        }

        // Recurse into subdirectories
        if (hasTestFiles(join(dir, name), depth + 1)) {
          return true;
        }
      }

      // Check test file patterns
      if (entry.isFile()) {
        const lower = name.toLowerCase();
        if (
          lower.includes(".test.") ||
          lower.includes(".spec.") ||
          lower.startsWith("test_") ||
          lower.endsWith("_test.py") ||
          lower.endsWith("_test.go") ||
          lower.endsWith("_test.ts") ||
          lower.endsWith("_test.js")
        ) {
          return true;
        }
      }
    }
  } catch {
    // Directory read failed — can't verify, so don't block
    return true;
  }

  return false;
}

/**
 * Extract task description from tool_input
 */
function getTaskDescription(toolInput: Record<string, unknown>): string {
  // Try common field names for task description
  const candidates = [
    toolInput.description,
    toolInput.task,
    toolInput.title,
    toolInput.summary,
    toolInput.content,
    toolInput.text,
  ];

  for (const candidate of candidates) {
    if (candidate && typeof candidate === "string") {
      return candidate;
    }
  }

  // Fallback: stringify the whole input
  return JSON.stringify(toolInput).toLowerCase();
}

/**
 * Output hook response
 */
function respond(output: HookOutput): void {
  console.log(JSON.stringify(output));
}

/**
 * Main hook execution
 */
export function run(): void {
  const input = readStdinJson();

  if (!input) {
    respond({ decision: "approve" });
    return;
  }

  const description = getTaskDescription(input.tool_input || {}).toLowerCase();
  const cwd = input.cwd;

  // Check: if the task mentions tests, verify test files exist
  if (/\btests?\b/.test(description)) {
    if (!hasTestFiles(cwd)) {
      console.error("[hook-taskgate] Task mentions tests but no test files found in project");
      respond({
        decision: "block",
        reason: "Task mentions tests but no test files were found in the project. Please create test files before marking this task as complete.",
      });
      return;
    }
    console.error("[hook-taskgate] Task mentions tests — test files found, approved");
  }

  // Check: if the task mentions lint/format, approve (can't verify externally)
  if (/\b(lint|linting|format|formatting)\b/.test(description)) {
    console.error("[hook-taskgate] Task mentions lint/format — approved (cannot verify externally)");
    respond({ decision: "approve" });
    return;
  }

  // Default: approve all other tasks
  respond({ decision: "approve" });
}

if (import.meta.main) {
  run();
}
