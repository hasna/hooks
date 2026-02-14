#!/usr/bin/env bun

/**
 * Claude Code Hook: permissionguard
 *
 * PreToolUse hook that auto-approves safe read-only commands and
 * blocks dangerous patterns. Everything else passes through.
 *
 * Safe commands (auto-approve):
 * - git status, git log, git diff, git branch
 * - ls, cat, head, tail, wc, find, grep
 * - npm test, bun test, pytest, cargo test
 * - npm list, bun pm ls, pip list
 * - node --version, bun --version, python --version
 *
 * Dangerous patterns (auto-block):
 * - rm -rf / or ~ or $HOME
 * - Fork bombs
 * - dd if=, mkfs., fdisk
 * - curl|sh, wget|sh (pipe to shell)
 * - chmod 777
 */

import { readFileSync } from "fs";

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

/**
 * Patterns for safe read-only commands that can be auto-approved.
 * These match the beginning of a command (after trimming).
 */
const SAFE_COMMAND_PATTERNS: RegExp[] = [
  // Git read-only
  /^git\s+status(\s|$)/,
  /^git\s+log(\s|$)/,
  /^git\s+diff(\s|$)/,
  /^git\s+branch(\s|$)/,
  /^git\s+show(\s|$)/,
  /^git\s+remote\s+-v(\s|$)/,
  /^git\s+tag(\s|$)/,

  // File reading
  /^ls(\s|$)/,
  /^cat\s/,
  /^head\s/,
  /^tail\s/,
  /^wc\s/,
  /^find\s/,
  /^grep\s/,
  /^rg\s/,
  /^file\s/,
  /^stat\s/,
  /^du\s/,
  /^df\s/,
  /^which\s/,
  /^type\s/,
  /^pwd$/,
  /^echo\s/,

  // Testing
  /^npm\s+test(\s|$)/,
  /^npm\s+run\s+test(\s|$)/,
  /^bun\s+test(\s|$)/,
  /^bun\s+run\s+test(\s|$)/,
  /^pytest(\s|$)/,
  /^python\s+-m\s+pytest(\s|$)/,
  /^cargo\s+test(\s|$)/,
  /^go\s+test(\s|$)/,
  /^jest(\s|$)/,
  /^vitest(\s|$)/,

  // Package listing
  /^npm\s+list(\s|$)/,
  /^npm\s+ls(\s|$)/,
  /^bun\s+pm\s+ls(\s|$)/,
  /^pip\s+list(\s|$)/,
  /^pip\s+show\s/,
  /^cargo\s+tree(\s|$)/,

  // Version checks
  /^node\s+--version$/,
  /^node\s+-v$/,
  /^bun\s+--version$/,
  /^bun\s+-v$/,
  /^python\s+--version$/,
  /^python3\s+--version$/,
  /^pip\s+--version$/,
  /^cargo\s+--version$/,
  /^go\s+version$/,
  /^rustc\s+--version$/,
  /^ruby\s+--version$/,
  /^java\s+--version$/,
  /^java\s+-version$/,
];

/**
 * Dangerous patterns that should always be blocked.
 */
const DANGEROUS_PATTERNS: Array<{ pattern: RegExp; description: string }> = [
  // Destructive rm commands
  {
    pattern: /rm\s+(-[a-zA-Z]*r[a-zA-Z]*f|--recursive\s+--force|-[a-zA-Z]*f[a-zA-Z]*r)\s+[/~]/,
    description: "rm -rf on root or home directory",
  },
  {
    pattern: /rm\s+(-[a-zA-Z]*r[a-zA-Z]*f|--recursive\s+--force|-[a-zA-Z]*f[a-zA-Z]*r)\s+\$HOME/,
    description: "rm -rf $HOME",
  },
  {
    pattern: /rm\s+(-[a-zA-Z]*r[a-zA-Z]*f|--recursive\s+--force|-[a-zA-Z]*f[a-zA-Z]*r)\s+\/\s*$/,
    description: "rm -rf /",
  },

  // Fork bomb
  {
    pattern: /:\(\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;\s*:/,
    description: "fork bomb",
  },

  // Disk destruction
  {
    pattern: /\bdd\s+if=/,
    description: "dd command (raw disk write)",
  },
  {
    pattern: /\bmkfs\./,
    description: "mkfs (filesystem format)",
  },
  {
    pattern: /\bfdisk\b/,
    description: "fdisk (partition manipulation)",
  },

  // Pipe to shell (remote code execution)
  {
    pattern: /curl\s+.*\|\s*(ba)?sh/,
    description: "curl piped to shell (remote code execution)",
  },
  {
    pattern: /wget\s+.*\|\s*(ba)?sh/,
    description: "wget piped to shell (remote code execution)",
  },
  {
    pattern: /curl\s+.*\|\s*sudo\s+(ba)?sh/,
    description: "curl piped to sudo shell (remote code execution)",
  },
  {
    pattern: /wget\s+.*\|\s*sudo\s+(ba)?sh/,
    description: "wget piped to sudo shell (remote code execution)",
  },

  // Insecure permissions
  {
    pattern: /chmod\s+(-R\s+)?777\b/,
    description: "chmod 777 (world-writable permissions)",
  },
  {
    pattern: /chmod\s+-R\s+777\b/,
    description: "chmod -R 777 (recursive world-writable permissions)",
  },

  // Additional dangerous patterns
  {
    pattern: /\bshutdown\b/,
    description: "system shutdown",
  },
  {
    pattern: /\breboot\b/,
    description: "system reboot",
  },
  {
    pattern: />\s*\/dev\/sda/,
    description: "writing to raw disk device",
  },
];

function isSafeCommand(command: string): boolean {
  const trimmed = command.trim();

  // Check each line of a multi-line or piped command
  // If the FIRST command in a pipeline is safe and there are no pipes, approve
  // For piped commands, don't auto-approve (could pipe safe command to dangerous one)
  if (trimmed.includes("|") || trimmed.includes("&&") || trimmed.includes(";")) {
    return false;
  }

  for (const pattern of SAFE_COMMAND_PATTERNS) {
    if (pattern.test(trimmed)) {
      return true;
    }
  }

  return false;
}

function isDangerousCommand(command: string): { dangerous: boolean; reason?: string } {
  for (const { pattern, description } of DANGEROUS_PATTERNS) {
    if (pattern.test(command)) {
      return { dangerous: true, reason: `Blocked: ${description}` };
    }
  }
  return { dangerous: false };
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

  // Check for dangerous patterns first (highest priority)
  const dangerCheck = isDangerousCommand(command);
  if (dangerCheck.dangerous) {
    console.error(`[hook-permissionguard] ${dangerCheck.reason}`);
    respond({ decision: "block", reason: dangerCheck.reason });
    return;
  }

  // Check for safe commands (auto-approve without prompting)
  if (isSafeCommand(command)) {
    respond({ decision: "approve" });
    return;
  }

  // Everything else: approve (pass through to Claude's normal permission flow)
  respond({ decision: "approve" });
}

if (import.meta.main) {
  run();
}
