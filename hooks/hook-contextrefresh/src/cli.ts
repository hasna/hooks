#!/usr/bin/env bun

/**
 * CLI for hook-contextrefresh
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { join } from "path";
import { homedir } from "os";

const HOOK_NAME = "hook-contextrefresh";
const SETTINGS_PATH = join(homedir(), ".claude", "settings.json");

interface ClaudeSettings {
  hooks?: {
    UserPromptSubmit?: Array<{
      matcher?: string;
      hooks: Array<{ type: "command"; command: string }>;
    }>;
  };
  contextRefreshConfig?: {
    enabled?: boolean;
    interval?: number;
    contextFile?: string;
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

function install(interval?: string): void {
  const settings = readSettings();
  if (!settings.hooks) settings.hooks = {};
  if (!settings.hooks.UserPromptSubmit) settings.hooks.UserPromptSubmit = [];

  const existing = settings.hooks.UserPromptSubmit.find((h) =>
    h.hooks.some((hook) => hook.command.includes(HOOK_NAME))
  );

  if (existing) {
    console.log(`${HOOK_NAME} is already installed`);
    return;
  }

  settings.hooks.UserPromptSubmit.push({
    hooks: [{ type: "command", command: `bunx @hasnaxyz/${HOOK_NAME}` }],
  });

  if (!settings.contextRefreshConfig) {
    settings.contextRefreshConfig = {
      enabled: true,
      interval: interval ? parseInt(interval, 10) : 10,
    };
  }

  writeSettings(settings);
  console.log(`${HOOK_NAME} installed successfully`);
  console.log(`Interval: every ${settings.contextRefreshConfig.interval} prompts`);
  console.log(`\nCreate a .claude-context file in your project root with the context to inject.`);
}

function uninstall(): void {
  const settings = readSettings();
  if (!settings.hooks?.UserPromptSubmit) {
    console.log(`${HOOK_NAME} is not installed`);
    return;
  }

  const before = settings.hooks.UserPromptSubmit.length;
  settings.hooks.UserPromptSubmit = settings.hooks.UserPromptSubmit.filter(
    (h) => !h.hooks.some((hook) => hook.command.includes(HOOK_NAME))
  );

  if (before === settings.hooks.UserPromptSubmit.length) {
    console.log(`${HOOK_NAME} is not installed`);
    return;
  }

  writeSettings(settings);
  console.log(`${HOOK_NAME} uninstalled successfully`);
}

function status(): void {
  const settings = readSettings();
  const installed = settings.hooks?.UserPromptSubmit?.some((h) =>
    h.hooks.some((hook) => hook.command.includes(HOOK_NAME))
  );
  console.log(`${HOOK_NAME} is ${installed ? "installed" : "not installed"}`);

  if (settings.contextRefreshConfig) {
    console.log(`\nConfig:`);
    console.log(`  Enabled: ${settings.contextRefreshConfig.enabled !== false}`);
    console.log(`  Interval: every ${settings.contextRefreshConfig.interval || 10} prompts`);
    console.log(`  Context file: ${settings.contextRefreshConfig.contextFile || ".claude-context"}`);
  }

  // Check if context file exists
  const contextFile = join(process.cwd(), ".claude-context");
  console.log(`\nContext file: ${existsSync(contextFile) ? "found" : "not found"} (${contextFile})`);
}

function help(): void {
  console.log(`
${HOOK_NAME} - Re-inject context every N prompts

Usage: ${HOOK_NAME} <command>

Commands:
  install [N]   Install hook (optional: set interval, default 10)
  uninstall     Remove hook from Claude Code settings
  status        Check if hook is installed and show config
  help          Show this help message

Setup:
  1. Run: ${HOOK_NAME} install
  2. Create .claude-context in your project root
  3. Add important context/rules to that file
  4. Context is re-injected every N prompts automatically
`);
}

const command = process.argv[2];

switch (command) {
  case "install": install(process.argv[3]); break;
  case "uninstall": uninstall(); break;
  case "status": status(); break;
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
