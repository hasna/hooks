#!/usr/bin/env bun

/**
 * CLI for hook-gitguard
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { join } from "path";
import { homedir } from "os";

const HOOK_NAME = "hook-gitguard";
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
  console.log("Hook will block destructive git operations");
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

function test(command: string): void {
  const PATTERNS: Array<{ pattern: RegExp; description: string }> = [
    { pattern: /git\s+reset\s+--hard/, description: "git reset --hard" },
    { pattern: /git\s+push\s+.*--force(?!-)/, description: "git push --force" },
    { pattern: /git\s+push\s+.*\s-f\b/, description: "git push -f" },
    { pattern: /git\s+checkout\s+\.\s*$/, description: "git checkout ." },
    { pattern: /git\s+checkout\s+--\s+\./, description: "git checkout -- ." },
    { pattern: /git\s+clean\s+(-[a-zA-Z]*f|--force)/, description: "git clean -f" },
    { pattern: /git\s+branch\s+-D\s/, description: "git branch -D" },
    { pattern: /git\s+stash\s+(drop|clear)/, description: "git stash drop/clear" },
  ];

  for (const { pattern, description } of PATTERNS) {
    if (pattern.test(command)) {
      console.log(`BLOCKED: ${description}`);
      return;
    }
  }
  console.log("ALLOWED");
}

function help(): void {
  console.log(`
${HOOK_NAME} - Block destructive git operations in Claude Code

Usage: ${HOOK_NAME} <command>

Commands:
  install     Install hook to Claude Code settings
  uninstall   Remove hook from Claude Code settings
  status      Check if hook is installed
  test <cmd>  Test if a git command would be blocked
  help        Show this help message

Blocked operations:
  git reset --hard          git push --force / -f
  git checkout .            git checkout -- .
  git clean -f              git branch -D
  git stash drop/clear      git reflog expire/delete
`);
}

const command = process.argv[2];

switch (command) {
  case "install": install(); break;
  case "uninstall": uninstall(); break;
  case "status": status(); break;
  case "test":
    if (process.argv[3]) {
      test(process.argv.slice(3).join(" "));
    } else {
      console.error("Usage: hook-gitguard test <command>");
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
