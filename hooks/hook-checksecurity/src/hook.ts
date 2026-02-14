#!/usr/bin/env bun

/**
 * Claude Code Hook: check-security
 *
 * Runs security checks via Claude and Codex headless agents.
 * This is a BLOCKER hook on the Stop event.
 *
 * Only runs for repos matching [prefix]-[name] pattern.
 * Only runs once per session (state flag prevents re-runs).
 *
 * Configuration:
 * - taskListId: task list for dispatching security tasks
 * - keywords: keywords that trigger the check (default: ["dev"])
 * - enabled: enable/disable the hook
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import { spawnSync, execSync } from "child_process";

interface CheckSecurityConfig {
  taskListId?: string;
  keywords?: string[];
  enabled?: boolean;
}

interface HookInput {
  session_id: string;
  transcript_path: string;
  cwd: string;
}

interface SessionState {
  securityChecked: boolean;
  lastCheckRun: number;
}

const CONFIG_KEY = "checkSecurityConfig";
const STATE_DIR = join(homedir(), ".claude", "hook-state");

/**
 * Sanitize ID to prevent path traversal and injection attacks
 */
function sanitizeId(id: string): string {
  if (!id || typeof id !== 'string') return 'default';
  return id.replace(/[^a-zA-Z0-9_-]/g, '-').slice(0, 100) || 'default';
}

const SECURITY_PROMPT = `You are a security reviewer. Analyze the codebase in the current directory for security vulnerabilities.

For each security issue found, create a task using the service-implementation CLI:
service-implementation task dispatch "{taskListId}" -s "SECURITY: [severity] - [brief description]" -d "[detailed description with file:line reference and remediation advice]"

Severity levels: CRITICAL, HIGH, MEDIUM, LOW

Focus on:
- Injection vulnerabilities (SQL, XSS, command injection)
- Authentication/authorization issues
- Sensitive data exposure
- Insecure configurations
- Dependency vulnerabilities
- Hardcoded secrets or credentials
- Input validation issues
- CSRF vulnerabilities
- Insecure deserialization

If no security issues are found, do not create any tasks.
Only create tasks for real security concerns.
Limit to max 10 most critical security issues.`;

function isValidRepoPattern(cwd: string): boolean {
  const dirName = cwd.split("/").filter(Boolean).pop() || "";
  // Match: hook-checklint, skill-installhook, iapp-mail, etc.
  return /^[a-z]+-[a-z0-9-]+$/i.test(dirName);
}

function readStdinJson(): HookInput | null {
  try {
    const stdin = readFileSync(0, "utf-8");
    return JSON.parse(stdin);
  } catch {
    return null;
  }
}

function readSettings(path: string): Record<string, unknown> {
  if (!existsSync(path)) return {};
  try {
    return JSON.parse(readFileSync(path, "utf-8"));
  } catch {
    return {};
  }
}

function getConfig(cwd: string): CheckSecurityConfig {
  // Try project settings first
  const projectSettings = readSettings(join(cwd, ".claude", "settings.json"));
  if (projectSettings[CONFIG_KEY]) {
    return projectSettings[CONFIG_KEY] as CheckSecurityConfig;
  }

  // Fall back to global settings
  const globalSettings = readSettings(join(homedir(), ".claude", "settings.json"));
  if (globalSettings[CONFIG_KEY]) {
    return globalSettings[CONFIG_KEY] as CheckSecurityConfig;
  }

  // Default config
  return {
    keywords: ["dev"],
    enabled: true,
  };
}

function getStateFile(sessionId: string): string {
  mkdirSync(STATE_DIR, { recursive: true });
  const safeSessionId = sanitizeId(sessionId);
  return join(STATE_DIR, `checksecurity-${safeSessionId}.json`);
}

function getSessionState(sessionId: string): SessionState {
  const stateFile = getStateFile(sessionId);
  if (existsSync(stateFile)) {
    try {
      return JSON.parse(readFileSync(stateFile, "utf-8"));
    } catch {
      // Corrupted state, reset
    }
  }
  return { securityChecked: false, lastCheckRun: 0 };
}

function saveSessionState(sessionId: string, state: SessionState): void {
  const stateFile = getStateFile(sessionId);
  writeFileSync(stateFile, JSON.stringify(state, null, 2));
}

function getSessionName(transcriptPath: string): string | null {
  if (!existsSync(transcriptPath)) return null;

  try {
    const content = readFileSync(transcriptPath, "utf-8");
    let lastTitle: string | null = null;
    let searchStart = 0;

    while (true) {
      const titleIndex = content.indexOf('"custom-title"', searchStart);
      if (titleIndex === -1) break;

      const lineStart = content.lastIndexOf("\n", titleIndex) + 1;
      const lineEnd = content.indexOf("\n", titleIndex);
      const line = content.slice(lineStart, lineEnd === -1 ? undefined : lineEnd);

      try {
        const entry = JSON.parse(line);
        if (entry.type === "custom-title" && entry.customTitle) {
          lastTitle = entry.customTitle;
        }
      } catch {
        // Skip malformed lines
      }

      searchStart = titleIndex + 1;
    }

    return lastTitle;
  } catch {
    return null;
  }
}

function getProjectTaskListId(cwd: string): string | null {
  const dirName = cwd.split("/").filter(Boolean).pop() || "";
  return `${dirName}-dev`;
}

function isClaudeAvailable(): boolean {
  try {
    execSync("which claude", { stdio: "pipe" });
    return true;
  } catch {
    return false;
  }
}

function isCodexAvailable(): boolean {
  try {
    execSync("which codex", { stdio: "pipe" });
    return true;
  } catch {
    return false;
  }
}

function runClaudeSecurityCheck(cwd: string, taskListId: string): void {
  const safeTaskListId = sanitizeId(taskListId);
  const prompt = SECURITY_PROMPT.replace("{taskListId}", safeTaskListId);

  console.error(`[hook-checksecurity] Running Claude security check...`);

  spawnSync(
    "claude",
    [
      "-p",
      prompt,
      "--permission-mode",
      "acceptEdits",
      "--allowedTools",
      "Bash,Read,Glob,Grep",
      "--no-session-persistence",
    ],
    {
      cwd,
      stdio: "inherit",
    }
  );
}

function runCodexSecurityCheck(cwd: string, taskListId: string): void {
  const safeTaskListId = sanitizeId(taskListId);
  const prompt = SECURITY_PROMPT.replace("{taskListId}", safeTaskListId);

  console.error(`[hook-checksecurity] Running Codex security check...`);

  spawnSync(
    "codex",
    [
      "exec",
      prompt,
    ],
    {
      cwd,
      stdio: "inherit",
    }
  );
}

function approve() {
  console.log(JSON.stringify({ decision: "approve" }));
  process.exit(0);
}

function block(reason: string) {
  console.log(JSON.stringify({ decision: "block", reason }));
  process.exit(0);
}

export function run() {
  const hookInput = readStdinJson();
  if (!hookInput) {
    approve();
    return;
  }

  const { session_id, cwd, transcript_path } = hookInput;

  // Check repo pattern - only run for [prefix]-[name] folders
  if (!isValidRepoPattern(cwd)) {
    approve();
    return;
  }

  const config = getConfig(cwd);

  // Check if hook is disabled
  if (config.enabled === false) {
    approve();
    return;
  }

  // Check keywords match
  const sessionName = transcript_path ? getSessionName(transcript_path) : null;
  const nameToCheck = sessionName || config.taskListId || "";
  const keywords = config.keywords || ["dev"];

  const matchesKeyword = keywords.some((keyword) =>
    nameToCheck.toLowerCase().includes(keyword.toLowerCase())
  );

  // If keywords are configured and we have a session name, check for match
  if (keywords.length > 0 && nameToCheck && !matchesKeyword) {
    approve();
    return;
  }

  // Check session state - only run once per session
  const state = getSessionState(session_id);
  if (state.securityChecked) {
    // Already ran security check this session
    approve();
    return;
  }

  // Mark as checked before running (prevent re-runs)
  state.securityChecked = true;
  state.lastCheckRun = Date.now();
  saveSessionState(session_id, state);

  const taskListId = config.taskListId || getProjectTaskListId(cwd) || "default-dev";

  // Run security checks
  const claudeAvailable = isClaudeAvailable();
  const codexAvailable = isCodexAvailable();

  if (!claudeAvailable && !codexAvailable) {
    console.error(`[hook-checksecurity] Neither Claude nor Codex CLI available, skipping security check`);
    approve();
    return;
  }

  console.error(`[hook-checksecurity] Running security checks for ${cwd}`);

  // Run Claude security check
  if (claudeAvailable) {
    runClaudeSecurityCheck(cwd, taskListId);
  }

  // Run Codex security check
  if (codexAvailable) {
    runCodexSecurityCheck(cwd, taskListId);
  }

  console.error(`[hook-checksecurity] Security checks completed`);

  // After running checks, approve (let checktasks handle blocking if tasks exist)
  approve();
}

// Allow direct execution
if (import.meta.main) {
  run();
}
