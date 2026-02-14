#!/usr/bin/env bun

/**
 * Claude Code Hook: slacknotify
 *
 * Stop hook that sends a Slack webhook notification when Claude Code
 * finishes working in a project.
 *
 * Configuration:
 * - Environment variable: SLACK_WEBHOOK_URL
 * - Or ~/.claude/settings.json key: slackNotifyConfig.webhookUrl
 */

import { readFileSync, existsSync } from "fs";
import { join } from "path";
import { homedir } from "os";

interface HookInput {
  session_id: string;
  cwd: string;
  hook_event_name: string;
  transcript_path?: string;
}

interface HookOutput {
  continue: boolean;
}

interface SlackNotifyConfig {
  webhookUrl?: string;
  enabled?: boolean;
}

const CONFIG_KEY = "slackNotifyConfig";

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

function getConfig(): SlackNotifyConfig {
  // Try global settings
  const settingsPath = join(homedir(), ".claude", "settings.json");
  try {
    if (existsSync(settingsPath)) {
      const settings = JSON.parse(readFileSync(settingsPath, "utf-8"));
      if (settings[CONFIG_KEY]) {
        return settings[CONFIG_KEY] as SlackNotifyConfig;
      }
    }
  } catch {
    // Settings file unreadable, fall through
  }
  return {};
}

function getWebhookUrl(): string | null {
  // Priority 1: environment variable
  const envUrl = process.env.SLACK_WEBHOOK_URL;
  if (envUrl) return envUrl;

  // Priority 2: settings.json config
  const config = getConfig();
  if (config.webhookUrl) return config.webhookUrl;

  return null;
}

async function sendSlackNotification(webhookUrl: string, cwd: string): Promise<void> {
  const projectName = cwd.split("/").filter(Boolean).pop() || cwd;

  const payload = {
    text: `Claude Code finished in ${projectName}`,
    blocks: [
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: `*Claude Code* finished working in \`${cwd}\``,
        },
      },
    ],
  };

  try {
    const response = await fetch(webhookUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      console.error(
        `[hook-slacknotify] Slack webhook returned ${response.status}: ${response.statusText}`
      );
    }
  } catch (error) {
    const errMsg = error instanceof Error ? error.message : String(error);
    console.error(`[hook-slacknotify] Failed to send Slack notification: ${errMsg}`);
  }
}

export async function run(): Promise<void> {
  const input = readStdinJson();

  if (!input) {
    respond({ continue: true });
    return;
  }

  // Check if hook is explicitly disabled
  const config = getConfig();
  if (config.enabled === false) {
    respond({ continue: true });
    return;
  }

  const webhookUrl = getWebhookUrl();

  if (!webhookUrl) {
    console.error(
      "[hook-slacknotify] No Slack webhook URL configured. " +
        "Set SLACK_WEBHOOK_URL env var or add slackNotifyConfig.webhookUrl to ~/.claude/settings.json"
    );
    respond({ continue: true });
    return;
  }

  await sendSlackNotification(webhookUrl, input.cwd);
  respond({ continue: true });
}

if (import.meta.main) {
  run();
}
