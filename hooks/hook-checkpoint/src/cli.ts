#!/usr/bin/env bun

/**
 * CLI for hook-checkpoint
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { execSync } from "child_process";
import { join } from "path";
import { homedir } from "os";

const HOOK_NAME = "hook-checkpoint";
const SETTINGS_PATH = join(homedir(), ".claude", "settings.json");
const CHECKPOINT_DIR = ".claude-checkpoints";

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
  console.log("Hook will create shadow git snapshots before Write/Edit/NotebookEdit");
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

function list(): void {
  const checkpointDir = join(process.cwd(), CHECKPOINT_DIR);
  if (!existsSync(checkpointDir)) {
    console.log("No checkpoints found in current directory");
    return;
  }

  try {
    const log = execSync("git log --oneline -20", {
      cwd: checkpointDir,
      encoding: "utf-8",
    });
    console.log("Recent checkpoints:");
    console.log(log);
  } catch {
    console.log("No checkpoints found");
  }
}

function restore(ref: string): void {
  const checkpointDir = join(process.cwd(), CHECKPOINT_DIR);
  if (!existsSync(checkpointDir)) {
    console.log("No checkpoints found in current directory");
    return;
  }

  try {
    const files = execSync(`git show ${ref} --name-only --pretty=format:""`, {
      cwd: checkpointDir,
      encoding: "utf-8",
    }).trim().split("\n").filter((f) => f.startsWith("files/"));

    for (const file of files) {
      const relativePath = file.replace("files/", "");
      try {
        const content = execSync(`git show ${ref}:${file}`, {
          cwd: checkpointDir,
        });
        const targetPath = join(process.cwd(), relativePath);
        writeFileSync(targetPath, content);
        console.log(`Restored: ${relativePath}`);
      } catch {
        console.error(`Failed to restore: ${relativePath}`);
      }
    }
  } catch (error) {
    console.error(`Failed to restore from ${ref}:`, error);
  }
}

function help(): void {
  console.log(`
${HOOK_NAME} - Shadow git snapshots for Claude Code file modifications

Usage: ${HOOK_NAME} <command>

Commands:
  install       Install hook to Claude Code settings
  uninstall     Remove hook from Claude Code settings
  status        Check if hook is installed
  list          Show recent checkpoints in current directory
  restore <ref> Restore files from a checkpoint (git ref)
  help          Show this help message

How it works:
  Before any Write/Edit/NotebookEdit, the hook copies the original file
  into a shadow git repo (.claude-checkpoints/) and commits it. This gives
  you a full history of every file before Claude modified it.
`);
}

const command = process.argv[2];

switch (command) {
  case "install": install(); break;
  case "uninstall": uninstall(); break;
  case "status": status(); break;
  case "list": list(); break;
  case "restore":
    if (process.argv[3]) {
      restore(process.argv[3]);
    } else {
      console.error("Usage: hook-checkpoint restore <git-ref>");
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
