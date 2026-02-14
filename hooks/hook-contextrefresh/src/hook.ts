#!/usr/bin/env bun

/**
 * Claude Code Hook: contextrefresh
 *
 * UserPromptSubmit hook that re-injects important context every N prompts
 * to prevent context decay in long sessions.
 *
 * Reads context from .claude-context file in project root and injects
 * it as a system message every N user prompts. Tracks prompt count
 * in a persistent counter file.
 */

import { readFileSync, existsSync, writeFileSync, mkdirSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import { tmpdir } from "os";

interface HookInput {
  session_id: string;
  cwd: string;
  hook_event_name: string;
  user_prompt?: string;
}

interface HookOutput {
  continue?: boolean;
  suppressPrompt?: boolean;
  updatedPrompt?: string;
}

interface RefreshConfig {
  enabled?: boolean;
  interval?: number;
  contextFile?: string;
}

const CONFIG_KEY = "contextRefreshConfig";
const COUNTER_DIR = join(tmpdir(), "hook-contextrefresh");

function readStdinJson(): HookInput | null {
  try {
    const input = readFileSync(0, "utf-8").trim();
    if (!input) return null;
    return JSON.parse(input);
  } catch {
    return null;
  }
}

function getConfig(): RefreshConfig {
  const settingsPath = join(homedir(), ".claude", "settings.json");
  try {
    if (existsSync(settingsPath)) {
      const settings = JSON.parse(readFileSync(settingsPath, "utf-8"));
      return settings[CONFIG_KEY] || { enabled: true, interval: 10 };
    }
  } catch {}
  return { enabled: true, interval: 10 };
}

function getPromptCount(sessionId: string): number {
  mkdirSync(COUNTER_DIR, { recursive: true });
  const counterFile = join(COUNTER_DIR, `${sessionId}.count`);
  try {
    if (existsSync(counterFile)) {
      return parseInt(readFileSync(counterFile, "utf-8").trim(), 10) || 0;
    }
  } catch {}
  return 0;
}

function setPromptCount(sessionId: string, count: number): void {
  mkdirSync(COUNTER_DIR, { recursive: true });
  const counterFile = join(COUNTER_DIR, `${sessionId}.count`);
  writeFileSync(counterFile, String(count));
}

function getContextContent(cwd: string, contextFile?: string): string | null {
  // Try configured context file, then defaults
  const candidates = [
    contextFile ? join(cwd, contextFile) : null,
    join(cwd, ".claude-context"),
    join(cwd, ".claude-refresh"),
  ].filter(Boolean) as string[];

  for (const path of candidates) {
    if (existsSync(path)) {
      try {
        return readFileSync(path, "utf-8").trim();
      } catch {}
    }
  }

  return null;
}

function respond(output: HookOutput): void {
  console.log(JSON.stringify(output));
}

export function run(): void {
  const input = readStdinJson();

  if (!input) {
    respond({ continue: true });
    return;
  }

  const config = getConfig();

  if (!config.enabled) {
    respond({ continue: true });
    return;
  }

  const interval = config.interval || 10;
  const count = getPromptCount(input.session_id) + 1;
  setPromptCount(input.session_id, count);

  // Check if it's time to inject context
  if (count % interval !== 0) {
    respond({ continue: true });
    return;
  }

  const contextContent = getContextContent(input.cwd, config.contextFile);

  if (!contextContent) {
    respond({ continue: true });
    return;
  }

  // Inject context by prepending it to the user's prompt
  const refreshPrefix = `[Context Refresh - Prompt #${count}]\n${contextContent}\n\n---\n\n`;
  const updatedPrompt = input.user_prompt
    ? `${refreshPrefix}${input.user_prompt}`
    : undefined;

  respond({
    continue: true,
    updatedPrompt,
  });
}

if (import.meta.main) {
  run();
}
