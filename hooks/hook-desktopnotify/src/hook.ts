#!/usr/bin/env bun

/**
 * Claude Code Hook: desktopnotify
 *
 * Stop hook that sends a native desktop notification when Claude stops.
 *
 * Platform support:
 * - macOS: osascript (display notification)
 * - Linux: notify-send
 */

import { readFileSync } from "fs";
import { execSync } from "child_process";
import { basename } from "path";

interface HookInput {
  session_id: string;
  cwd: string;
  hook_event_name?: string;
  stop_hook_active?: boolean;
}

interface HookOutput {
  continue: boolean;
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

function escapeForShell(str: string): string {
  return str.replace(/'/g, "'\\''");
}

function sendMacNotification(title: string, message: string): void {
  const escapedTitle = escapeForShell(title);
  const escapedMessage = escapeForShell(message);
  const script = `display notification "${escapedMessage}" with title "${escapedTitle}" sound name "Glass"`;

  try {
    execSync(`osascript -e '${script}'`, {
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
      timeout: 5000,
    });
    console.error("[hook-desktopnotify] macOS notification sent");
  } catch (error: unknown) {
    const execError = error as { message?: string };
    console.error(`[hook-desktopnotify] macOS notification failed: ${execError.message}`);
  }
}

function sendLinuxNotification(title: string, message: string): void {
  const escapedTitle = escapeForShell(title);
  const escapedMessage = escapeForShell(message);

  try {
    execSync(`notify-send '${escapedTitle}' '${escapedMessage}' --urgency=normal --expire-time=5000`, {
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
      timeout: 5000,
    });
    console.error("[hook-desktopnotify] Linux notification sent");
  } catch (error: unknown) {
    const execError = error as { message?: string };
    console.error(`[hook-desktopnotify] Linux notification failed: ${execError.message}`);
  }
}

function sendNotification(title: string, message: string): void {
  const platform = process.platform;

  if (platform === "darwin") {
    sendMacNotification(title, message);
  } else if (platform === "linux") {
    sendLinuxNotification(title, message);
  } else {
    console.error(`[hook-desktopnotify] Unsupported platform: ${platform}`);
  }
}

export function run(): void {
  const input = readStdinJson();

  if (!input) {
    respond({ continue: true });
    return;
  }

  const projectName = input.cwd ? basename(input.cwd) : "unknown";
  const title = "Claude Code — Done";
  const message = `Claude has finished working on ${projectName} and is waiting for your input.`;

  sendNotification(title, message);

  respond({ continue: true });
}

if (import.meta.main) {
  run();
}
