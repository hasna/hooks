#!/usr/bin/env bun

/**
 * Claude Code Hook: checkpoint
 *
 * PreToolUse hook that creates shadow git snapshots before any file
 * Write/Edit operations. This provides a safety net with easy rollback
 * capability without cluttering the main project's git history.
 *
 * Shadow repo is stored in .claude-checkpoints/ (gitignored).
 */

import { readFileSync, existsSync, mkdirSync, writeFileSync, appendFileSync } from "fs";
import { execSync } from "child_process";
import { join, resolve } from "path";

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

const CHECKPOINT_DIR = ".claude-checkpoints";
const TOOLS_TO_CHECKPOINT = ["Write", "Edit", "NotebookEdit"];

/**
 * Read JSON from stdin
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
 * Initialize shadow git repo for checkpoints
 */
function initShadowRepo(cwd: string): string {
  const shadowPath = join(cwd, CHECKPOINT_DIR);

  if (!existsSync(shadowPath)) {
    mkdirSync(shadowPath, { recursive: true });
  }

  const gitDir = join(shadowPath, ".git");
  if (!existsSync(gitDir)) {
    execSync("git init", { cwd: shadowPath, stdio: "pipe" });
    execSync('git config user.email "hook-checkpoint@claude.local"', {
      cwd: shadowPath,
      stdio: "pipe",
    });
    execSync('git config user.name "hook-checkpoint"', {
      cwd: shadowPath,
      stdio: "pipe",
    });

    // Create initial commit
    writeFileSync(join(shadowPath, ".checkpoint-init"), new Date().toISOString());
    execSync("git add -A && git commit -m 'init: checkpoint repo'", {
      cwd: shadowPath,
      stdio: "pipe",
    });
  }

  // Ensure .claude-checkpoints is gitignored in main project
  const mainGitignore = join(cwd, ".gitignore");
  if (existsSync(mainGitignore)) {
    const content = readFileSync(mainGitignore, "utf-8");
    if (!content.includes(CHECKPOINT_DIR)) {
      appendFileSync(mainGitignore, `\n${CHECKPOINT_DIR}/\n`);
    }
  }

  return shadowPath;
}

/**
 * Copy the target file into the shadow repo and commit
 */
function createCheckpoint(
  cwd: string,
  shadowPath: string,
  toolName: string,
  filePath: string,
  sessionId: string
): void {
  const absFilePath = resolve(cwd, filePath);

  if (!existsSync(absFilePath)) {
    // File doesn't exist yet (new file being created) — log but no snapshot needed
    const logEntry = `[${new Date().toISOString()}] ${toolName} creating new file: ${filePath}\n`;
    appendFileSync(join(shadowPath, "checkpoint.log"), logEntry);
    return;
  }

  // Copy file to shadow repo preserving relative path
  const relativePath = filePath.startsWith("/")
    ? filePath.replace(cwd, "").replace(/^\//, "")
    : filePath;
  const shadowFilePath = join(shadowPath, "files", relativePath);
  const shadowFileDir = join(shadowFilePath, "..");

  mkdirSync(shadowFileDir, { recursive: true });

  const content = readFileSync(absFilePath);
  writeFileSync(shadowFilePath, content);

  // Create metadata
  const metadata = {
    tool: toolName,
    file: filePath,
    session: sessionId,
    timestamp: new Date().toISOString(),
  };
  writeFileSync(
    join(shadowPath, "last-checkpoint.json"),
    JSON.stringify(metadata, null, 2)
  );

  // Commit to shadow repo
  try {
    execSync("git add -A", { cwd: shadowPath, stdio: "pipe" });
    const msg = `checkpoint: ${toolName} ${relativePath}`;
    execSync(`git commit -m "${msg}" --allow-empty`, {
      cwd: shadowPath,
      stdio: "pipe",
    });
  } catch {
    // Commit may fail if nothing changed — that's fine
  }

  // Log
  const logEntry = `[${new Date().toISOString()}] ${toolName} → ${relativePath} (session: ${sessionId})\n`;
  appendFileSync(join(shadowPath, "checkpoint.log"), logEntry);
}

/**
 * Extract file path from tool input
 */
function getFilePath(toolName: string, toolInput: Record<string, unknown>): string | null {
  switch (toolName) {
    case "Write":
    case "Edit":
      return (toolInput.file_path as string) || null;
    case "NotebookEdit":
      return (toolInput.notebook_path as string) || null;
    default:
      return null;
  }
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

  // Only checkpoint file-modifying tools
  if (!TOOLS_TO_CHECKPOINT.includes(input.tool_name)) {
    respond({ decision: "approve" });
    return;
  }

  const filePath = getFilePath(input.tool_name, input.tool_input);
  if (!filePath) {
    respond({ decision: "approve" });
    return;
  }

  try {
    const shadowPath = initShadowRepo(input.cwd);
    createCheckpoint(input.cwd, shadowPath, input.tool_name, filePath, input.session_id);
  } catch (error) {
    // Never block operations due to checkpoint failures
    const errMsg = error instanceof Error ? error.message : String(error);
    console.error(`[hook-checkpoint] Warning: checkpoint failed: ${errMsg}`);
  }

  // Always approve — checkpointing is non-blocking
  respond({ decision: "approve" });
}

if (import.meta.main) {
  run();
}
