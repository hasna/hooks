#!/usr/bin/env bun

/**
 * CLI for hook-branchprotect
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { join } from "path";
import { homedir } from "os";

const HOOK_NAME = "hook-branchprotect";
const SETTINGS_PATH = join(homedir(), ".claude", "settings.json");

interface ClaudeSettings {
  hooks?: {
    PreToolUse?: Array<{
      matcher: string;
      hooks: Array<{ type: "command"; command: string }>;
    }>;
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

function install(): void {
  const settings = readSettings();
  if (!settings.hooks) settings.hooks = {};
  if (!settings.hooks.PreToolUse) settings.hooks.PreToolUse = [];

  const existing = settings.hooks.PreToolUse.find((h) =>
    h.hooks.some((hook) => hook.command.includes(HOOK_NAME))
  );

  if (existing) {
    console.log(`${HOOK_NAME} is already installed`);
    return;
  }

  settings.hooks.PreToolUse.push({
    matcher: "Write|Edit|NotebookEdit",
    hooks: [{ type: "command", command: `bunx @hasnaxyz/${HOOK_NAME}` }],
  });

  writeSettings(settings);
  console.log(`${HOOK_NAME} installed successfully`);
  console.log("Hook will prevent file modifications on main/master branch");
}

function uninstall(): void {
  const settings = readSettings();
  if (!settings.hooks?.PreToolUse) {
    console.log(`${HOOK_NAME} is not installed`);
    return;
  }

  const before = settings.hooks.PreToolUse.length;
  settings.hooks.PreToolUse = settings.hooks.PreToolUse.filter(
    (h) => !h.hooks.some((hook) => hook.command.includes(HOOK_NAME))
  );

  if (before === settings.hooks.PreToolUse.length) {
    console.log(`${HOOK_NAME} is not installed`);
    return;
  }

  writeSettings(settings);
  console.log(`${HOOK_NAME} uninstalled successfully`);
}

function status(): void {
  const settings = readSettings();
  const installed = settings.hooks?.PreToolUse?.some((h) =>
    h.hooks.some((hook) => hook.command.includes(HOOK_NAME))
  );
  console.log(`${HOOK_NAME} is ${installed ? "installed" : "not installed"}`);
}

function help(): void {
  console.log(`
${HOOK_NAME} - Prevent file modifications on protected branches

Usage: ${HOOK_NAME} <command>

Commands:
  install     Install hook to Claude Code settings
  uninstall   Remove hook from Claude Code settings
  status      Check if hook is installed
  help        Show this help message

Protected branches: main, master
Blocked tools: Write, Edit, NotebookEdit
`);
}

const command = process.argv[2];

switch (command) {
  case "install": install(); break;
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
