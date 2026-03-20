#!/usr/bin/env bun

/**
 * Claude Code Hook: conflict-detect
 *
 * PreToolUse hook that checks for git merge conflict markers before editing files.
 * Blocks edits on files that contain unresolved conflicts (<<<<<<, =======, >>>>>>>).
 */

import { readFileSync, existsSync } from "fs";
import { basename } from "path";
import { execSync } from "child_process";

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

// Git conflict marker patterns
const CONFLICT_MARKERS = [
  /^<{7}\s/m,   // <<<<<<< HEAD
  /^={7}$/m,    // =======
  /^>{7}\s/m,   // >>>>>>> branch
];

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

function hasConflictMarkers(filePath: string): { found: boolean; lines: string[] } {
  try {
    if (!existsSync(filePath)) return { found: false, lines: [] };

    const content = readFileSync(filePath, "utf-8");
    const hasConflicts = CONFLICT_MARKERS.every((pattern) => pattern.test(content));

    if (!hasConflicts) return { found: false, lines: [] };

    // Extract lines with conflict markers for the reason message
    const conflictLines = content
      .split("\n")
      .filter((line) => /^(<{7}|={7}|>{7})/.test(line))
      .slice(0, 6);

    return { found: true, lines: conflictLines };
  } catch {
    return { found: false, lines: [] };
  }
}

function isTrackedByGit(filePath: string, cwd: string): boolean {
  try {
    execSync(`git ls-files --error-unmatch "${filePath}"`, {
      cwd,
      stdio: ["pipe", "pipe", "pipe"],
      timeout: 5_000,
    });
    return true;
  } catch {
    return false;
  }
}

export function run(): void {
  const input = readStdinJson();

  if (!input) {
    respond({ decision: "approve" });
    return;
  }

  const filePath = input.tool_input?.file_path as string | undefined;

  if (!filePath || typeof filePath !== "string") {
    respond({ decision: "approve" });
    return;
  }

  const { found, lines } = hasConflictMarkers(filePath);

  if (!found) {
    respond({ decision: "approve" });
    return;
  }

  const name = basename(filePath);
  const markerPreview = lines.join("\n");

  console.error(`[hook-conflict-detect] Conflict markers found in ${name} — blocking edit`);

  respond({
    decision: "block",
    reason: `File '${name}' contains unresolved git merge conflicts. Resolve them before editing:\n\n${markerPreview}\n\nRun \`git diff ${name}\` to see the full conflict.`,
  });
}

if (import.meta.main) {
  run();
}
