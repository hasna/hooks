#!/usr/bin/env bun

/**
 * CLI for hook-phonenotify
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { join } from "path";
import { homedir } from "os";

const HOOK_NAME = "hook-phonenotify";
const SETTINGS_PATH = join(homedir(), ".claude", "settings.json");

interface ClaudeSettings {
  hooks?: {
    Stop?: Array<{ matcher?: string; hooks: Array<{ type: "command"; command: string }> }>;
    Notification?: Array<{ matcher?: string; hooks: Array<{ type: "command"; command: string }> }>;
  };
  phoneNotifyConfig?: {
    enabled?: boolean;
    topic?: string;
    server?: string;
    priority?: number;
  };
  [key: string]: unknown;
}

function readSettings(): ClaudeSettings {
  try {
    if (existsSync(SETTINGS_PATH)) {
      return JSON.parse(readFileSync(SETTINGS_PATH, "utf-8"));
    }
  } catch {}
  return {};
}

function writeSettings(settings: ClaudeSettings): void {
  const dir = join(homedir(), ".claude");
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(SETTINGS_PATH, JSON.stringify(settings, null, 2));
}

function install(topic?: string): void {
  const settings = readSettings();
  if (!settings.hooks) settings.hooks = {};
  if (!settings.hooks.Stop) settings.hooks.Stop = [];
  if (!settings.hooks.Notification) settings.hooks.Notification = [];

  const hookCommand = `bunx @hasnaxyz/${HOOK_NAME}`;

  const existing = settings.hooks.Stop.find((h) =>
    h.hooks.some((hook) => hook.command.includes(HOOK_NAME))
  );

  if (existing) {
    console.log(`${HOOK_NAME} is already installed`);
    return;
  }

  settings.hooks.Stop.push({
    hooks: [{ type: "command", command: hookCommand }],
  });
  settings.hooks.Notification.push({
    hooks: [{ type: "command", command: hookCommand }],
  });

  if (!settings.phoneNotifyConfig) {
    settings.phoneNotifyConfig = {
      enabled: true,
      topic: topic || "claude-code",
      server: "https://ntfy.sh",
      priority: 3,
    };
  }

  writeSettings(settings);
  console.log(`${HOOK_NAME} installed successfully`);
  console.log(`Topic: ${settings.phoneNotifyConfig.topic}`);
  console.log(`\nTo receive notifications, subscribe to your topic in the ntfy app:`);
  console.log(`  https://ntfy.sh/${settings.phoneNotifyConfig.topic}`);
}

function uninstall(): void {
  const settings = readSettings();
  let removed = false;

  if (settings.hooks?.Stop) {
    const before = settings.hooks.Stop.length;
    settings.hooks.Stop = settings.hooks.Stop.filter(
      (h) => !h.hooks.some((hook) => hook.command.includes(HOOK_NAME))
    );
    if (before !== settings.hooks.Stop.length) removed = true;
  }

  if (settings.hooks?.Notification) {
    const before = settings.hooks.Notification.length;
    settings.hooks.Notification = settings.hooks.Notification.filter(
      (h) => !h.hooks.some((hook) => hook.command.includes(HOOK_NAME))
    );
    if (before !== settings.hooks.Notification.length) removed = true;
  }

  if (!removed) {
    console.log(`${HOOK_NAME} is not installed`);
    return;
  }

  writeSettings(settings);
  console.log(`${HOOK_NAME} uninstalled successfully`);
}

function status(): void {
  const settings = readSettings();
  const installed = settings.hooks?.Stop?.some((h) =>
    h.hooks.some((hook) => hook.command.includes(HOOK_NAME))
  );
  console.log(`${HOOK_NAME} is ${installed ? "installed" : "not installed"}`);

  if (settings.phoneNotifyConfig) {
    console.log(`\nConfig:`);
    console.log(`  Enabled: ${settings.phoneNotifyConfig.enabled !== false}`);
    console.log(`  Topic: ${settings.phoneNotifyConfig.topic || "(not set)"}`);
    console.log(`  Server: ${settings.phoneNotifyConfig.server || "https://ntfy.sh"}`);
    console.log(`  Priority: ${settings.phoneNotifyConfig.priority || 3}`);
  }
}

async function test(): Promise<void> {
  console.log("Sending test notification...");
  const settings = readSettings();
  const config = settings.phoneNotifyConfig;

  if (!config?.topic) {
    console.error("No topic configured. Run: hook-phonenotify install <topic>");
    process.exit(1);
  }

  const server = config.server || "https://ntfy.sh";
  const url = `${server}/${config.topic}`;

  const response = await fetch(url, {
    method: "POST",
    headers: {
      Title: "Claude Code - Test",
      Priority: String(config.priority || 3),
      Tags: "robot,test_tube",
    },
    body: "This is a test notification from hook-phonenotify.",
  });

  if (response.ok) {
    console.log("Test notification sent!");
  } else {
    console.error(`Failed: ${response.status} ${response.statusText}`);
  }
}

function help(): void {
  console.log(`
${HOOK_NAME} - Push notifications to phone via ntfy.sh

Usage: ${HOOK_NAME} <command>

Commands:
  install [topic]  Install hook (optional: set ntfy topic)
  uninstall        Remove hook from Claude Code settings
  status           Check if hook is installed and show config
  test             Send a test notification
  help             Show this help message

Setup:
  1. Install the ntfy app on your phone (iOS/Android)
  2. Subscribe to your chosen topic
  3. Run: ${HOOK_NAME} install my-secret-topic
`);
}

const command = process.argv[2];

switch (command) {
  case "install": install(process.argv[3]); break;
  case "uninstall": uninstall(); break;
  case "status": status(); break;
  case "test": test(); break;
  case "help":
  case "--help":
  case "-h": help(); break;
  default:
    if (!command) {
      import("./hook.ts").then((m) => m.run());
    } else {
      console.error(`Unknown command: ${command}`);
      help();
      process.exit(1);
    }
}
