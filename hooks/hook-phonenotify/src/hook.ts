#!/usr/bin/env bun

/**
 * Claude Code Hook: phonenotify
 *
 * Stop/Notification hook that sends push notifications to your phone
 * via ntfy.sh when Claude finishes a task or needs your attention.
 *
 * Configure via ~/.claude/settings.json:
 * {
 *   "phoneNotifyConfig": {
 *     "enabled": true,
 *     "topic": "claude-code-YOUR_SECRET",
 *     "server": "https://ntfy.sh",
 *     "priority": 3
 *   }
 * }
 */

import { readFileSync, existsSync } from "fs";
import { join } from "path";
import { homedir } from "os";

interface HookInput {
  session_id: string;
  cwd: string;
  hook_event_name: string;
  notification_type?: string;
  message?: string;
}

interface HookOutput {
  continue?: boolean;
}

interface PhoneNotifyConfig {
  enabled?: boolean;
  topic?: string;
  server?: string;
  priority?: number;
}

const CONFIG_KEY = "phoneNotifyConfig";

function readStdinJson(): HookInput | null {
  try {
    const input = readFileSync(0, "utf-8").trim();
    if (!input) return null;
    return JSON.parse(input);
  } catch {
    return null;
  }
}

function getConfig(): PhoneNotifyConfig {
  const settingsPath = join(homedir(), ".claude", "settings.json");
  try {
    if (existsSync(settingsPath)) {
      const settings = JSON.parse(readFileSync(settingsPath, "utf-8"));
      return settings[CONFIG_KEY] || {};
    }
  } catch {}
  return {};
}

async function sendNotification(
  config: PhoneNotifyConfig,
  title: string,
  message: string
): Promise<void> {
  const server = config.server || "https://ntfy.sh";
  const topic = config.topic;

  if (!topic) {
    console.error("[hook-phonenotify] No topic configured. Set phoneNotifyConfig.topic in settings.");
    return;
  }

  const url = `${server}/${topic}`;

  try {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        Title: title,
        Priority: String(config.priority || 3),
        Tags: "robot",
      },
      body: message,
    });

    if (!response.ok) {
      console.error(`[hook-phonenotify] Failed to send: ${response.status}`);
    }
  } catch (error) {
    console.error(`[hook-phonenotify] Send failed: ${error}`);
  }
}

function respond(output: HookOutput): void {
  console.log(JSON.stringify(output));
}

export async function run(): Promise<void> {
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

  let title = "Claude Code";
  let message = "";

  if (input.hook_event_name === "Stop") {
    title = "Claude Code - Done";
    message = "Claude has finished and is waiting for your response.";
  } else if (input.hook_event_name === "Notification") {
    title = "Claude Code - Attention";
    message = input.message || "Claude Code requires your attention.";
  } else {
    respond({ continue: true });
    return;
  }

  await sendNotification(config, title, message);
  respond({ continue: true });
}

if (import.meta.main) {
  run();
}
