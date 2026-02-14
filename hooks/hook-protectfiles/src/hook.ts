#!/usr/bin/env bun

/**
 * Claude Code Hook: protectfiles
 *
 * PreToolUse hook that blocks access to sensitive files:
 *
 * Always blocked (Edit/Write/Read/Bash):
 * - .env, .env.local, .env.production, .env.*
 * - .secrets/, credentials.json
 * - *.pem, *.key
 * - id_rsa, id_ed25519, .ssh/
 *
 * Blocked for Edit/Write only (Read is OK):
 * - package-lock.json, yarn.lock, bun.lock, bun.lockb
 *
 * For Edit/Write/Read: checks tool_input.file_path
 * For Bash: checks if the command references protected files
 */

import { readFileSync } from "fs";
import { basename } from "path";

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
 * Sensitive file patterns that are always blocked (read + write).
 */
const ALWAYS_PROTECTED_PATTERNS: Array<{ pattern: RegExp; description: string }> = [
  // Environment files
  { pattern: /(?:^|\/)\.env$/, description: ".env file" },
  { pattern: /(?:^|\/)\.env\.[a-zA-Z0-9._-]+$/, description: ".env.* file" },

  // Secrets directory
  { pattern: /(?:^|\/)\.secrets(?:\/|$)/, description: ".secrets/ directory" },

  // Credential files
  { pattern: /(?:^|\/)credentials\.json$/, description: "credentials.json" },

  // SSL/TLS keys and certificates
  { pattern: /\.pem$/, description: ".pem file (certificate/key)" },
  { pattern: /\.key$/, description: ".key file (private key)" },
  { pattern: /\.p12$/, description: ".p12 file (certificate bundle)" },
  { pattern: /\.pfx$/, description: ".pfx file (certificate bundle)" },

  // SSH keys
  { pattern: /(?:^|\/)id_rsa(?:\.pub)?$/, description: "SSH RSA key" },
  { pattern: /(?:^|\/)id_ed25519(?:\.pub)?$/, description: "SSH Ed25519 key" },
  { pattern: /(?:^|\/)id_ecdsa(?:\.pub)?$/, description: "SSH ECDSA key" },
  { pattern: /(?:^|\/)id_dsa(?:\.pub)?$/, description: "SSH DSA key" },
  { pattern: /(?:^|\/)\.ssh\//, description: ".ssh/ directory" },

  // AWS credentials
  { pattern: /(?:^|\/)\.aws\/credentials$/, description: "AWS credentials" },

  // Token files
  { pattern: /(?:^|\/)\.npmrc$/, description: ".npmrc (may contain tokens)" },
  { pattern: /(?:^|\/)\.netrc$/, description: ".netrc (may contain credentials)" },

  // Keystore files
  { pattern: /\.keystore$/, description: "keystore file" },
  { pattern: /\.jks$/, description: "Java keystore" },
];

/**
 * Lock file patterns — blocked for Edit/Write only, allowed for Read.
 */
const LOCK_FILE_PATTERNS: Array<{ pattern: RegExp; description: string }> = [
  { pattern: /(?:^|\/)package-lock\.json$/, description: "package-lock.json (auto-generated)" },
  { pattern: /(?:^|\/)yarn\.lock$/, description: "yarn.lock (auto-generated)" },
  { pattern: /(?:^|\/)bun\.lock$/, description: "bun.lock (auto-generated)" },
  { pattern: /(?:^|\/)bun\.lockb$/, description: "bun.lockb (auto-generated binary)" },
  { pattern: /(?:^|\/)pnpm-lock\.yaml$/, description: "pnpm-lock.yaml (auto-generated)" },
  { pattern: /(?:^|\/)Gemfile\.lock$/, description: "Gemfile.lock (auto-generated)" },
  { pattern: /(?:^|\/)poetry\.lock$/, description: "poetry.lock (auto-generated)" },
  { pattern: /(?:^|\/)Cargo\.lock$/, description: "Cargo.lock (auto-generated)" },
  { pattern: /(?:^|\/)composer\.lock$/, description: "composer.lock (auto-generated)" },
];

type ToolCategory = "read" | "write" | "bash";

function getToolCategory(toolName: string): ToolCategory | null {
  switch (toolName) {
    case "Read":
      return "read";
    case "Edit":
    case "Write":
      return "write";
    case "Bash":
      return "bash";
    default:
      return null;
  }
}

function checkFilePath(filePath: string, category: ToolCategory): { blocked: boolean; reason?: string } {
  // Check always-protected files
  for (const { pattern, description } of ALWAYS_PROTECTED_PATTERNS) {
    if (pattern.test(filePath)) {
      return {
        blocked: true,
        reason: `Blocked: access to ${description} (${basename(filePath)})`,
      };
    }
  }

  // Check lock files — only block writes, allow reads
  if (category === "write") {
    for (const { pattern, description } of LOCK_FILE_PATTERNS) {
      if (pattern.test(filePath)) {
        return {
          blocked: true,
          reason: `Blocked: writing to ${description} — this file is auto-generated`,
        };
      }
    }
  }

  return { blocked: false };
}

function checkBashCommand(command: string): { blocked: boolean; reason?: string } {
  // For Bash, check if the command references any protected file
  // We check both always-protected and lock files (since bash could write to them)

  for (const { pattern, description } of ALWAYS_PROTECTED_PATTERNS) {
    // Extract the core pattern to search in the command string
    if (pattern.test(command)) {
      return {
        blocked: true,
        reason: `Blocked: command references ${description}`,
      };
    }
  }

  // Additional string-based checks for common patterns in bash commands
  const sensitiveReferences: Array<{ pattern: RegExp; description: string }> = [
    { pattern: /\b\.env\b(?!\.)/, description: ".env file" },
    { pattern: /\.env\.[a-zA-Z]+/, description: ".env.* file" },
    { pattern: /\.secrets\//, description: ".secrets/ directory" },
    { pattern: /credentials\.json/, description: "credentials.json" },
    { pattern: /\bid_rsa\b/, description: "SSH RSA key" },
    { pattern: /\bid_ed25519\b/, description: "SSH Ed25519 key" },
    { pattern: /\.ssh\//, description: ".ssh/ directory" },
    { pattern: /\.aws\/credentials/, description: "AWS credentials" },
  ];

  for (const { pattern, description } of sensitiveReferences) {
    if (pattern.test(command)) {
      // Allow read-only commands that just check existence or list
      // e.g., "test -f .env", "ls .secrets/", "cat .env" should still be caught
      // But git commands that reference .env in .gitignore context are OK
      if (/\bgit\s+(add|commit|diff|status|log)\b/.test(command)) {
        continue;
      }

      return {
        blocked: true,
        reason: `Blocked: command references ${description}`,
      };
    }
  }

  // Check if bash command writes to lock files
  const lockFileWritePatterns: Array<{ pattern: RegExp; description: string }> = [
    { pattern: />\s*package-lock\.json/, description: "writing to package-lock.json" },
    { pattern: />\s*yarn\.lock/, description: "writing to yarn.lock" },
    { pattern: />\s*bun\.lock/, description: "writing to bun.lock" },
    { pattern: /sed\s+.*package-lock\.json/, description: "modifying package-lock.json" },
    { pattern: /sed\s+.*yarn\.lock/, description: "modifying yarn.lock" },
    { pattern: /sed\s+.*bun\.lock/, description: "modifying bun.lock" },
  ];

  for (const { pattern, description } of lockFileWritePatterns) {
    if (pattern.test(command)) {
      return {
        blocked: true,
        reason: `Blocked: ${description} — this file is auto-generated`,
      };
    }
  }

  return { blocked: false };
}

export function run(): void {
  const input = readStdinJson();

  if (!input) {
    respond({ decision: "approve" });
    return;
  }

  const category = getToolCategory(input.tool_name);
  if (!category) {
    respond({ decision: "approve" });
    return;
  }

  // For Edit/Write/Read: check file_path
  if (category === "read" || category === "write") {
    const filePath = input.tool_input?.file_path as string;
    if (!filePath || typeof filePath !== "string") {
      respond({ decision: "approve" });
      return;
    }

    const result = checkFilePath(filePath, category);
    if (result.blocked) {
      console.error(`[hook-protectfiles] ${result.reason}`);
      respond({ decision: "block", reason: result.reason });
      return;
    }

    respond({ decision: "approve" });
    return;
  }

  // For Bash: check command
  if (category === "bash") {
    const command = input.tool_input?.command as string;
    if (!command || typeof command !== "string") {
      respond({ decision: "approve" });
      return;
    }

    const result = checkBashCommand(command);
    if (result.blocked) {
      console.error(`[hook-protectfiles] ${result.reason}`);
      respond({ decision: "block", reason: result.reason });
      return;
    }

    respond({ decision: "approve" });
    return;
  }

  respond({ decision: "approve" });
}

if (import.meta.main) {
  run();
}
