#!/usr/bin/env bun

/**
 * Claude Code Hook: branchprotect
 *
 * PreToolUse hook that prevents file modifications (Write/Edit) when
 * the current git branch is main or master. Forces feature branch workflow.
 */

import { readFileSync } from "fs";
import { execSync } from "child_process";

interface HookInput {
  session_id: string;
  cwd: string;
  tool_name: string;
  tool_input: Record<string, unknown>;
}

interface HookOutput {
  decision?: "approve" | "block";
  reason?: string;
}

const PROTECTED_BRANCHES = ["main", "master"];
const FILE_MODIFYING_TOOLS = ["Write", "Edit", "NotebookEdit"];

function readStdinJson(): HookInput | null {
  try {
    const input = readFileSync(0, "utf-8").trim();
    if (!input) return null;
    return JSON.parse(input);
  } catch {
    return null;
  }
}

function getCurrentBranch(cwd: string): string | null {
  try {
    return execSync("git rev-parse --abbrev-ref HEAD", {
      cwd,
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
    }).trim();
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
    respond({ decision: "approve" });
    return;
  }

  // Only check file-modifying tools
  if (!FILE_MODIFYING_TOOLS.includes(input.tool_name)) {
    respond({ decision: "approve" });
    return;
  }

  const branch = getCurrentBranch(input.cwd);

  if (!branch) {
    // Not a git repo — allow
    respond({ decision: "approve" });
    return;
  }

  if (PROTECTED_BRANCHES.includes(branch)) {
    const reason = `Blocked: cannot modify files on '${branch}' branch. Create a feature branch first (git checkout -b feat/your-change).`;
    console.error(`[hook-branchprotect] ${reason}`);
    respond({ decision: "block", reason });
    return;
  }

  respond({ decision: "approve" });
}

if (import.meta.main) {
  run();
}
