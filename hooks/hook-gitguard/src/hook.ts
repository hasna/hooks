#!/usr/bin/env bun

/**
 * Claude Code Hook: gitguard
 *
 * PreToolUse hook that blocks destructive git operations:
 * - git reset --hard
 * - git push --force / -f (especially to main/master)
 * - git checkout . / git checkout -- .
 * - git clean -f / -fd
 * - git branch -D (force delete)
 * - git stash drop / clear
 * - git rebase without caution
 */

import { readFileSync } from "fs";

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

const DESTRUCTIVE_PATTERNS: Array<{ pattern: RegExp; description: string }> = [
  // git reset --hard
  { pattern: /git\s+reset\s+--hard/, description: "git reset --hard (discards all uncommitted changes)" },

  // git push --force (any variant)
  { pattern: /git\s+push\s+.*--force-with-lease/, description: "git push --force-with-lease (force push with safety)" },
  { pattern: /git\s+push\s+.*--force(?!-)/, description: "git push --force (overwrites remote history)" },
  { pattern: /git\s+push\s+.*\s-f\b/, description: "git push -f (force push)" },

  // Force push to main/master specifically
  { pattern: /git\s+push\s+.*--force.*\s+(main|master)\b/, description: "force push to main/master" },
  { pattern: /git\s+push\s+.*-f\s+.*(main|master)\b/, description: "force push to main/master" },

  // git checkout . / git checkout -- . (discard all changes)
  { pattern: /git\s+checkout\s+\.\s*$/, description: "git checkout . (discards all working directory changes)" },
  { pattern: /git\s+checkout\s+--\s+\./, description: "git checkout -- . (discards all working directory changes)" },

  // git restore . (discard all changes)
  { pattern: /git\s+restore\s+\.\s*$/, description: "git restore . (discards all working directory changes)" },
  { pattern: /git\s+restore\s+--staged\s+--worktree\s+\./, description: "git restore --staged --worktree . (discards everything)" },

  // git clean -f (remove untracked files)
  { pattern: /git\s+clean\s+(-[a-zA-Z]*f|--force)/, description: "git clean -f (removes untracked files permanently)" },

  // git branch -D (force delete branch)
  { pattern: /git\s+branch\s+-D\s/, description: "git branch -D (force delete branch without merge check)" },

  // git stash drop/clear
  { pattern: /git\s+stash\s+drop/, description: "git stash drop (permanently deletes stash entry)" },
  { pattern: /git\s+stash\s+clear/, description: "git stash clear (deletes all stash entries)" },

  // git reflog expire/delete
  { pattern: /git\s+reflog\s+(expire|delete)/, description: "git reflog expire/delete (destroys recovery points)" },

  // git gc --prune=now
  { pattern: /git\s+gc\s+--prune=now/, description: "git gc --prune=now (permanently removes unreachable objects)" },
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

function checkDestructiveGit(command: string): { blocked: boolean; reason?: string } {
  for (const { pattern, description } of DESTRUCTIVE_PATTERNS) {
    if (pattern.test(command)) {
      return { blocked: true, reason: `Blocked: ${description}` };
    }
  }
  return { blocked: false };
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

  if (input.tool_name !== "Bash") {
    respond({ decision: "approve" });
    return;
  }

  const command = input.tool_input?.command as string;
  if (!command || typeof command !== "string") {
    respond({ decision: "approve" });
    return;
  }

  // Only check commands that contain "git"
  if (!command.includes("git")) {
    respond({ decision: "approve" });
    return;
  }

  const result = checkDestructiveGit(command);

  if (result.blocked) {
    console.error(`[hook-gitguard] ${result.reason}`);
    respond({ decision: "block", reason: result.reason });
    return;
  }

  respond({ decision: "approve" });
}

if (import.meta.main) {
  run();
}
