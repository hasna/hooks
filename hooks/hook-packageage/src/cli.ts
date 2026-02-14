#!/usr/bin/env bun

/**
 * CLI for hook-packageage
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { join } from "path";
import { homedir } from "os";

const HOOK_NAME = "hook-packageage";
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
    matcher: "Bash",
    hooks: [{ type: "command", command: `bunx @hasnaxyz/${HOOK_NAME}` }],
  });

  writeSettings(settings);
  console.log(`${HOOK_NAME} installed successfully`);
  console.log("Hook will check package age before npm/bun install commands");
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

async function check(packageName: string): Promise<void> {
  console.log(`Checking ${packageName}...`);
  try {
    const response = await fetch(`https://registry.npmjs.org/${encodeURIComponent(packageName)}`);
    if (!response.ok) {
      console.error(`Package not found: ${packageName}`);
      return;
    }
    const data = await response.json() as Record<string, unknown>;
    const time = data.time as Record<string, string> | undefined;
    const modified = time?.modified;
    if (modified) {
      const days = Math.floor((Date.now() - new Date(modified).getTime()) / (1000 * 60 * 60 * 24));
      const status = days > 730 ? "ABANDONED" : days > 365 ? "STALE" : "ACTIVE";
      console.log(`  Last updated: ${modified} (${days} days ago) — ${status}`);
    }

    const distTags = data["dist-tags"] as Record<string, string> | undefined;
    const latestVersion = distTags?.latest;
    const versions = data.versions as Record<string, Record<string, unknown>> | undefined;
    if (latestVersion && versions?.[latestVersion]?.deprecated) {
      console.log(`  DEPRECATED: ${versions[latestVersion].deprecated}`);
    }
  } catch (error) {
    console.error(`Error checking ${packageName}:`, error);
  }
}

function help(): void {
  console.log(`
${HOOK_NAME} - Check package age before install

Usage: ${HOOK_NAME} <command>

Commands:
  install         Install hook to Claude Code settings
  uninstall       Remove hook from Claude Code settings
  status          Check if hook is installed
  check <pkg>     Manually check a package's age
  help            Show this help message

Thresholds:
  > 1 year since last publish: STALE warning
  > 2 years since last publish: ABANDONED warning
  Deprecated packages: always warned
`);
}

const command = process.argv[2];

switch (command) {
  case "install": install(); break;
  case "uninstall": uninstall(); break;
  case "status": status(); break;
  case "check":
    if (process.argv[3]) {
      check(process.argv[3]);
    } else {
      console.error("Usage: hook-packageage check <package-name>");
      process.exit(1);
    }
    break;
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
