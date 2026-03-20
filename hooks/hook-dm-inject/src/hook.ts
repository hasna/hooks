#!/usr/bin/env bun

/**
 * Claude Code Hook: dm-inject
 *
 * Notification hook that injects unread DMs into agent context.
 * On each Notification event, checks for unread messages via the `conversations`
 * CLI and injects them as context so the agent can respond.
 */

import { readFileSync } from "fs";
import { execSync } from "child_process";

interface HookInput {
  session_id: string;
  cwd: string;
  hook_event_name: string;
  notification_type?: string;
  message?: string;
}

interface HookOutput {
  continue: boolean;
  suppressOutput?: boolean;
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

interface DmMessage {
  id: string;
  from: string;
  content: string;
  created_at: string;
}

function fetchUnreadDms(): DmMessage[] {
  try {
    const output = execSync("conversations read --unread --json", {
      encoding: "utf-8",
      timeout: 10_000,
      stdio: ["pipe", "pipe", "pipe"],
    });
    const data = JSON.parse(output.trim());
    if (Array.isArray(data)) return data as DmMessage[];
    if (data.messages && Array.isArray(data.messages)) return data.messages as DmMessage[];
    return [];
  } catch {
    return [];
  }
}

function markRead(ids: string[]): void {
  if (ids.length === 0) return;
  try {
    execSync(`conversations mark-read ${ids.join(" ")}`, {
      encoding: "utf-8",
      timeout: 5_000,
      stdio: ["pipe", "pipe", "pipe"],
    });
  } catch {}
}

export function run(): void {
  const input = readStdinJson();

  if (!input) {
    respond({ continue: true });
    return;
  }

  const dms = fetchUnreadDms();

  if (dms.length === 0) {
    respond({ continue: true });
    return;
  }

  // Format DMs for injection into context
  const lines = [
    `[hook-dm-inject] You have ${dms.length} unread DM(s):`,
    "",
    ...dms.map((dm, i) => {
      const from = dm.from || "unknown";
      const time = dm.created_at ? new Date(dm.created_at).toLocaleTimeString() : "";
      return `${i + 1}. From ${from}${time ? ` at ${time}` : ""}: ${dm.content}`;
    }),
    "",
    "Please acknowledge these messages when appropriate.",
  ];

  // Inject into stderr so it appears in Claude's context
  process.stderr.write(lines.join("\n") + "\n");

  // Mark messages as read
  const ids = dms.map((m) => m.id).filter(Boolean);
  markRead(ids);

  respond({ continue: true });
}

if (import.meta.main) {
  run();
}
