#!/usr/bin/env bun

/**
 * Claude Code Hook: check-files
 *
 * Runs a headless Claude Code agent to review files and create tasks.
 * Uses service-implementation CLI to dispatch tasks.
 *
 * This hook runs ASYNC (non-blocking) on PostToolUse.
 *
 * Configuration:
 * - taskListId: task list for dispatching review tasks
 * - editThreshold: run review after this many edits (default: 3, range: 3-7)
 * - keywords: keywords that trigger the check (default: ["dev"])
 * - reviewPrompt: custom prompt for the headless agent
 * - enabled: enable/disable the hook
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import { spawn } from "child_process";

interface CheckFilesConfig {
  taskListId?: string;
  editThreshold?: number;
  keywords?: string[];
  reviewPrompt?: string;
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
  lastReviewRun: number;
  reviewInProgress: boolean;
}

const CONFIG_KEY = "checkFilesConfig";
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

const DEFAULT_REVIEW_PROMPT = `You are a code reviewer. Review the following files that were recently edited and identify any issues:

FILES TO REVIEW:
{files}

For each issue found, create a task using the service-implementation CLI:
service-implementation task dispatch "{taskListId}" -s "REVIEW: [brief issue description]" -d "[detailed description with file:line reference]"

Focus on:
- Potential bugs or logic errors
- Security vulnerabilities
- Performance issues
- Code style violations
- Missing error handling

If no issues are found, do not create any tasks.
Only create tasks for real issues, not minor style preferences.
Limit to max 5 most important issues.`;

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

function getConfig(cwd: string): CheckFilesConfig {
  // Try project settings first
  const projectSettings = readSettings(join(cwd, ".claude", "settings.json"));
  if (projectSettings[CONFIG_KEY]) {
    return projectSettings[CONFIG_KEY] as CheckFilesConfig;
  }

  // Fall back to global settings
  const globalSettings = readSettings(join(homedir(), ".claude", "settings.json"));
  if (globalSettings[CONFIG_KEY]) {
    return globalSettings[CONFIG_KEY] as CheckFilesConfig;
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
  return join(STATE_DIR, `checkfiles-${safeSessionId}.json`);
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
  return { editCount: 0, editedFiles: [], lastReviewRun: 0, reviewInProgress: false };
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
  // Default to project-bugfixes or project-dev
  return `${dirName}-bugfixes`;
}

function runHeadlessReview(
  cwd: string,
  files: string[],
  taskListId: string,
  customPrompt?: string
): void {
  // Sanitize file paths to prevent prompt injection
  const filesFormatted = files.map((f) => `- ${sanitizePath(f)}`).join("\n");
  // Sanitize taskListId
  const safeTaskListId = sanitizeId(taskListId);

  const prompt = (customPrompt || DEFAULT_REVIEW_PROMPT)
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

  console.error(`[hook-checkfiles] Started headless review of ${files.length} files`);
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

  // Skip if review already in progress
  if (state.reviewInProgress) {
    approve();
    return;
  }

  state.editCount++;

  if (!state.editedFiles.includes(filePath)) {
    state.editedFiles.push(filePath);
  }

  const threshold = Math.min(7, Math.max(3, config.editThreshold || 3));

  // Check if we should run review
  if (state.editCount >= threshold) {
    const taskListId = config.taskListId || getProjectTaskListId(cwd) || "default-bugfixes";

    // Mark review in progress
    state.reviewInProgress = true;
    saveSessionState(session_id, state);

    // Run headless review (async, non-blocking)
    runHeadlessReview(cwd, state.editedFiles, taskListId, config.reviewPrompt);

    // Reset counter after starting review
    state.editCount = 0;
    state.editedFiles = [];
    state.lastReviewRun = Date.now();
    state.reviewInProgress = false;
  }

  saveSessionState(session_id, state);
  approve();
}

// Allow direct execution
if (import.meta.main) {
  run();
}
