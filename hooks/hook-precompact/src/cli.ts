#!/usr/bin/env bun

/**
 * CLI for hook-precompact
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync } from "fs";
import { join } from "path";
import { homedir } from "os";

const HOOK_NAME = "hook-precompact";
const SETTINGS_PATH = join(homedir(), ".claude", "settings.json");
const HANDOFF_DIR = ".claude-handoffs";

interface ClaudeSettings {
  hooks?: {
    PreCompact?: Array<{
      matcher?: string;
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
  if (!settings.hooks.PreCompact) settings.hooks.PreCompact = [];

  const existing = settings.hooks.PreCompact.find((h) =>
    h.hooks.some((hook) => hook.command.includes(HOOK_NAME))
  );

  if (existing) {
    console.log(`${HOOK_NAME} is already installed`);
    return;
  }

  settings.hooks.PreCompact.push({
    hooks: [{ type: "command", command: `bunx @hasna/${HOOK_NAME}` }],
  });

  writeSettings(settings);
  console.log(`${HOOK_NAME} installed successfully`);
  console.log("Hook will save session state before context compaction");
}

function uninstall(): void {
  const settings = readSettings();
  if (!settings.hooks?.PreCompact) {
    console.log(`${HOOK_NAME} is not installed`);
    return;
  }

  const before = settings.hooks.PreCompact.length;
  settings.hooks.PreCompact = settings.hooks.PreCompact.filter(
    (h) => !h.hooks.some((hook) => hook.command.includes(HOOK_NAME))
  );

  if (before === settings.hooks.PreCompact.length) {
    console.log(`${HOOK_NAME} is not installed`);
    return;
  }

  writeSettings(settings);
  console.log(`${HOOK_NAME} uninstalled successfully`);
}

function status(): void {
  const settings = readSettings();
  const installed = settings.hooks?.PreCompact?.some((h) =>
    h.hooks.some((hook) => hook.command.includes(HOOK_NAME))
  );
  console.log(`${HOOK_NAME} is ${installed ? "installed" : "not installed"}`);
}

function list(): void {
  const handoffDir = join(process.cwd(), HANDOFF_DIR);
  if (!existsSync(handoffDir)) {
    console.log("No handoffs found in current directory");
    return;
  }

  const files = readdirSync(handoffDir)
    .filter((f) => f.startsWith("handoff-") && f.endsWith(".json"))
    .sort()
    .reverse();

  if (files.length === 0) {
    console.log("No handoffs found");
    return;
  }

  console.log(`Recent handoffs (${files.length} total):\n`);
  for (const file of files.slice(0, 10)) {
    try {
      const data = JSON.parse(readFileSync(join(handoffDir, file), "utf-8"));
      console.log(`  ${data.timestamp} | session: ${data.session_id} | branch: ${data.git?.branch || "?"}`);
    } catch {
      console.log(`  ${file} (unreadable)`);
    }
  }
}

function latest(): void {
  const latestPath = join(process.cwd(), HANDOFF_DIR, "latest.json");
  if (!existsSync(latestPath)) {
    console.log("No handoffs found");
    return;
  }

  const data = JSON.parse(readFileSync(latestPath, "utf-8"));
  console.log(JSON.stringify(data, null, 2));
}

function help(): void {
  console.log(`
${HOOK_NAME} - Save session state before context compaction

Usage: ${HOOK_NAME} <command>

Commands:
  install     Install hook to Claude Code settings
  uninstall   Remove hook from Claude Code settings
  status      Check if hook is installed
  list        Show recent handoffs in current directory
  latest      Show the latest handoff data
  help        Show this help message

Handoff files are saved in .claude-handoffs/ (gitignored).
`);
}

const command = process.argv[2];

switch (command) {
  case "install": install(); break;
  case "uninstall": uninstall(); break;
  case "status": status(); break;
  case "list": list(); break;
  case "latest": latest(); break;
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
