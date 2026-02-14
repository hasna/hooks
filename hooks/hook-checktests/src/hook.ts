#!/usr/bin/env bun

/**
 * Claude Code Hook: check-tests
 *
 * Runs a headless Claude Code agent to check for missing tests.
 * Uses service-implementation CLI to dispatch tasks.
 *
 * This hook runs ASYNC (non-blocking) on PostToolUse.
 * Only runs for repos matching [prefix]-[name] pattern.
 *
 * Configuration:
 * - taskListId: task list for dispatching test tasks
 * - editThreshold: run check after this many edits (default: 3, range: 3-7)
 * - keywords: keywords that trigger the check (default: ["dev"])
 * - enabled: enable/disable the hook
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import { spawn } from "child_process";

interface CheckTestsConfig {
  taskListId?: string;
  editThreshold?: number;
  keywords?: string[];
  enabled?: boolean;
}

interface HookInput {
  session_id: string;
  transcript_path: string;
  cwd: string;
  tool_name: string;
  tool_input: Record<string, unknown>;
  tool_output?: string;
}

interface SessionState {
  editCount: number;
  editedFiles: string[];
  lastCheckRun: number;
  checkInProgress: boolean;
}

const CONFIG_KEY = "checkTestsConfig";
const STATE_DIR = join(homedir(), ".claude", "hook-state");
const EDIT_TOOLS = ["Edit", "Write", "NotebookEdit"];

/**
 * Sanitize ID to prevent path traversal and injection attacks
 */
function sanitizeId(id: string): string {
  if (!id || typeof id !== 'string') return 'default';
  return id.replace(/[^a-zA-Z0-9_-]/g, '-').slice(0, 100) || 'default';
}

/**
 * Sanitize file path for safe display in prompts
 */
function sanitizePath(path: string): string {
  if (!path || typeof path !== 'string') return '';
  return path.replace(/[`$"'\\;&|<>(){}[\]!#*?~]/g, '_');
}

const TESTS_PROMPT = `You are a test coverage reviewer. Review the following files that were recently edited and identify missing or incomplete tests:

FILES TO REVIEW:
{files}

For each test coverage issue found, create a task using the service-implementation CLI:
service-implementation task dispatch "{taskListId}" -s "TEST: [brief description]" -d "[detailed description of what tests need to be added]"

Focus on:
- Missing unit tests for new functions/methods
- Missing integration tests for new features
- Missing edge case tests
- Missing error handling tests
- Untested code paths
- Missing mock/stub implementations
- Missing test fixtures or setup
- Missing API endpoint tests
- Missing validation tests

If no test coverage issues are found, do not create any tasks.
Only create tasks for meaningful test gaps, not trivial ones.
Limit to max 5 most important test tasks.`;

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

function getConfig(cwd: string): CheckTestsConfig {
  // Try project settings first
  const projectSettings = readSettings(join(cwd, ".claude", "settings.json"));
  if (projectSettings[CONFIG_KEY]) {
    return projectSettings[CONFIG_KEY] as CheckTestsConfig;
  }

  // Fall back to global settings
  const globalSettings = readSettings(join(homedir(), ".claude", "settings.json"));
  if (globalSettings[CONFIG_KEY]) {
    return globalSettings[CONFIG_KEY] as CheckTestsConfig;
  }

  // Default config
  return {
    editThreshold: 3,
    keywords: ["dev"],
    enabled: true,
  };
}

function getStateFile(sessionId: string): string {
  mkdirSync(STATE_DIR, { recursive: true });
  const safeSessionId = sanitizeId(sessionId);
  return join(STATE_DIR, `checktests-${safeSessionId}.json`);
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
  return { editCount: 0, editedFiles: [], lastCheckRun: 0, checkInProgress: false };
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
  return `${dirName}-qa`;
}

function runHeadlessTestsCheck(
  cwd: string,
  files: string[],
  taskListId: string
): void {
  // Sanitize file paths to prevent prompt injection
  const filesFormatted = files.map((f) => `- ${sanitizePath(f)}`).join("\n");
  // Sanitize taskListId
  const safeTaskListId = sanitizeId(taskListId);

  const prompt = TESTS_PROMPT
    .replace("{files}", filesFormatted)
    .replace("{taskListId}", safeTaskListId);

  // Spawn headless Claude Code agent in background
  const child = spawn(
    "claude",
    [
      "-p",
      prompt,
      "--permission-mode",
      "acceptEdits",
      "--allowedTools",
      "Bash,Read",
      "--no-session-persistence",
    ],
    {
      cwd,
      detached: true,
      stdio: "ignore",
    }
  );

  // Detach from parent process
  child.unref();

  console.error(`[hook-checktests] Started tests check for ${files.length} files`);
}

function approve() {
  console.log(JSON.stringify({ decision: "approve" }));
  process.exit(0);
}

export function run() {
  const hookInput = readStdinJson();
  if (!hookInput) {
    approve();
    return;
  }

  const { session_id, cwd, tool_name, tool_input, transcript_path } = hookInput;

  // Only process edit tools
  if (!EDIT_TOOLS.includes(tool_name)) {
    approve();
    return;
  }

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

  // Get edited file path
  const filePath = (tool_input.file_path || tool_input.notebook_path) as string | undefined;
  if (!filePath) {
    approve();
    return;
  }

  // Update session state
  const state = getSessionState(session_id);

  // Skip if check already in progress
  if (state.checkInProgress) {
    approve();
    return;
  }

  state.editCount++;

  if (!state.editedFiles.includes(filePath)) {
    state.editedFiles.push(filePath);
  }

  const threshold = Math.min(7, Math.max(3, config.editThreshold || 3));

  // Check if we should run tests check
  if (state.editCount >= threshold) {
    const taskListId = config.taskListId || getProjectTaskListId(cwd) || "default-qa";

    // Mark check in progress
    state.checkInProgress = true;
    saveSessionState(session_id, state);

    // Run headless tests check (async, non-blocking)
    runHeadlessTestsCheck(cwd, state.editedFiles, taskListId);

    // Reset counter after starting check
    state.editCount = 0;
    state.editedFiles = [];
    state.lastCheckRun = Date.now();
    state.checkInProgress = false;
  }

  saveSessionState(session_id, state);
  approve();
}

// Allow direct execution
if (import.meta.main) {
  run();
}
