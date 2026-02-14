#!/usr/bin/env bun

/**
 * @hasnaxyz/hook-checktests CLI
 *
 * Usage:
 *   hook-checktests install           Auto-detect location, configure options
 *   hook-checktests install --global  Force global install
 *   hook-checktests install /path     Install to specific path
 *   hook-checktests config            Update configuration
 *   hook-checktests uninstall         Remove hook
 *   hook-checktests run               Execute hook (called by Claude Code)
 *   hook-checktests status            Show installation status
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync } from "fs";
import { join, dirname, resolve } from "path";
import { homedir } from "os";
import * as readline from "readline";

const PACKAGE_NAME = "@hasnaxyz/hook-checktests";
const CONFIG_KEY = "checkTestsConfig";

// Colors
const c = {
  red: (s: string) => `\x1b[31m${s}\x1b[0m`,
  green: (s: string) => `\x1b[32m${s}\x1b[0m`,
  yellow: (s: string) => `\x1b[33m${s}\x1b[0m`,
  cyan: (s: string) => `\x1b[36m${s}\x1b[0m`,
  dim: (s: string) => `\x1b[2m${s}\x1b[0m`,
  bold: (s: string) => `\x1b[1m${s}\x1b[0m`,
};

interface CheckTestsConfig {
  taskListId?: string;
  editThreshold?: number;
  keywords?: string[];
  reviewPrompt?: string;
  enabled?: boolean;
}

interface InstallOptions {
  taskListId?: string;
  keywords?: string[];
  threshold?: number;
  nonInteractive: boolean;
}

function parseInstallArgs(args: string[]): InstallOptions {
  const options: InstallOptions = {
    nonInteractive: false,
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    const nextArg = args[i + 1];

    switch (arg) {
      case "--task-list-id":
      case "-t":
        if (nextArg && !nextArg.startsWith("-")) {
          options.taskListId = nextArg;
          i++;
        }
        break;
      case "--keywords":
      case "-k":
        if (nextArg && !nextArg.startsWith("-")) {
          options.keywords = nextArg.split(",").map((k) => k.trim().toLowerCase()).filter(Boolean);
          i++;
        }
        break;
      case "--threshold":
      case "-n":
        if (nextArg && !nextArg.startsWith("-")) {
          const num = parseInt(nextArg, 10);
          if (!isNaN(num) && num >= 3 && num <= 7) {
            options.threshold = num;
          }
          i++;
        }
        break;
      case "--yes":
      case "-y":
        options.nonInteractive = true;
        break;
    }
  }

  // If any explicit option is provided, enable non-interactive mode
  if (options.taskListId !== undefined || options.keywords !== undefined || options.threshold !== undefined) {
    options.nonInteractive = true;
  }

  return options;
}

function printUsage() {
  console.log(`
${c.bold("hook-checktests")} - Checks for missing tests and creates tasks

${c.bold("USAGE:")}
  hook-checktests install [path]     Install the hook
  hook-checktests config [path]      Update configuration
  hook-checktests uninstall [path]   Remove the hook
  hook-checktests status             Show hook status
  hook-checktests run                Execute hook ${c.dim("(called by Claude Code)")}

${c.bold("OPTIONS:")}
  ${c.dim("(no args)")}      Auto-detect: if in git repo -> install there, else -> prompt
  --global, -g   Apply to ~/.claude/settings.json
  /path/to/repo  Apply to specific project path

${c.bold("INSTALL OPTIONS:")}
  --task-list-id, -t <id>    Task list ID for dispatching tasks
  --keywords, -k <k1,k2>     Keywords (comma-separated, default: dev)
  --threshold, -n <num>      Edit threshold (3-7, default: 3)
  --yes, -y                  Non-interactive mode (use defaults/provided values)

${c.bold("EXAMPLES:")}
  hook-checktests install              ${c.dim("# Install with config prompts")}
  hook-checktests install --global     ${c.dim("# Global install")}
  hook-checktests install -y           ${c.dim("# Install with defaults, no prompts")}
  hook-checktests install -t my-qa -n 5 -y  ${c.dim("# Install with options")}
  hook-checktests config               ${c.dim("# Update threshold, task list")}
  hook-checktests status               ${c.dim("# Check what's installed")}

${c.bold("CONFIGURATION:")}
  editThreshold  Run review after this many edits (3-7, default: 3)
  taskListId     Task list for dispatching tasks (auto-detected if not set)
  keywords       Only run for sessions matching keywords (default: dev)
  reviewPrompt   Custom prompt for the headless agent

${c.bold("HOW IT WORKS:")}
  1. Tracks file edits (Edit, Write, NotebookEdit)
  2. After N edits, spawns headless Claude agent
  3. Agent reviews files and identifies missing tests
  4. Tasks are dispatched to the configured task list (prefers *-qa)

${c.bold("GLOBAL CLI INSTALL:")}
  bun add -g ${PACKAGE_NAME}
`);
}

function isGitRepo(path: string): boolean {
  return existsSync(join(path, ".git"));
}

function getSettingsPath(targetPath: string | "global"): string {
  if (targetPath === "global") {
    return join(homedir(), ".claude", "settings.json");
  }
  return join(targetPath, ".claude", "settings.json");
}

function readSettings(path: string): Record<string, unknown> {
  if (!existsSync(path)) return {};
  try {
    return JSON.parse(readFileSync(path, "utf-8"));
  } catch {
    return {};
  }
}

function writeSettings(path: string, settings: Record<string, unknown>) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(settings, null, 2) + "\n");
}

function getHookCommand(): string {
  return `bunx ${PACKAGE_NAME}@latest run`;
}

function hookExists(settings: Record<string, unknown>): boolean {
  const hooks = settings.hooks as Record<string, unknown[]> | undefined;
  if (!hooks?.PostToolUse) return false;
  const postToolHooks = hooks.PostToolUse as Array<{ hooks?: Array<{ command?: string }> }>;
  return postToolHooks.some((group) =>
    group.hooks?.some((h) => h.command?.includes(PACKAGE_NAME))
  );
}

function getConfig(settings: Record<string, unknown>): CheckTestsConfig {
  return (settings[CONFIG_KEY] as CheckTestsConfig) || {};
}

function setConfig(settings: Record<string, unknown>, config: CheckTestsConfig): Record<string, unknown> {
  settings[CONFIG_KEY] = config;
  return settings;
}

function addHook(settings: Record<string, unknown>): Record<string, unknown> {
  const hookConfig = {
    type: "command",
    command: getHookCommand(),
    timeout: 120,
    async: true, // Run async (non-blocking)
  };

  // Match only Edit, Write, NotebookEdit tools
  const matcher = {
    tool_name: "^(Edit|Write|NotebookEdit)$",
  };

  if (!settings.hooks) settings.hooks = {};
  const hooks = settings.hooks as Record<string, unknown[]>;

  if (!hooks.PostToolUse) {
    hooks.PostToolUse = [{ matcher, hooks: [hookConfig] }];
  } else {
    const postToolHooks = hooks.PostToolUse as Array<{ matcher?: unknown; hooks?: unknown[] }>;
    // Check if there's already a group for our matcher
    const existingGroup = postToolHooks.find((g) =>
      JSON.stringify(g.matcher) === JSON.stringify(matcher)
    );
    if (existingGroup?.hooks) {
      existingGroup.hooks.push(hookConfig);
    } else {
      postToolHooks.push({ matcher, hooks: [hookConfig] });
    }
  }
  return settings;
}

function removeHook(settings: Record<string, unknown>): Record<string, unknown> {
  const hooks = settings.hooks as Record<string, unknown[]> | undefined;
  if (!hooks?.PostToolUse) return settings;

  const postToolHooks = hooks.PostToolUse as Array<{ hooks?: Array<{ command?: string }> }>;
  for (const group of postToolHooks) {
    if (group.hooks) {
      group.hooks = group.hooks.filter((h) => !h.command?.includes(PACKAGE_NAME));
    }
  }
  hooks.PostToolUse = postToolHooks.filter((g) => g.hooks && g.hooks.length > 0);
  if (hooks.PostToolUse.length === 0) delete hooks.PostToolUse;

  // Also remove config
  delete settings[CONFIG_KEY];

  return settings;
}

async function prompt(question: string): Promise<string> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

function getAllTaskLists(): string[] {
  const tasksDir = join(homedir(), ".claude", "tasks");
  if (!existsSync(tasksDir)) return [];
  try {
    return readdirSync(tasksDir, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name);
  } catch {
    return [];
  }
}

function getProjectTaskLists(projectPath: string): string[] {
  const allLists = getAllTaskLists();
  const dirName = projectPath.split("/").filter(Boolean).pop() || "";

  return allLists.filter((list) => {
    const listLower = list.toLowerCase();
    const dirLower = dirName.toLowerCase();
    if (listLower.startsWith(dirLower + "-")) return true;
    if (listLower.includes(dirLower)) return true;
    return false;
  });
}

async function resolveTarget(
  args: string[]
): Promise<{ path: string | "global"; label: string } | null> {
  if (args.includes("--global") || args.includes("-g")) {
    return { path: "global", label: "global (~/.claude/settings.json)" };
  }

  const pathArg = args.find((a) => !a.startsWith("-"));
  if (pathArg) {
    const fullPath = resolve(pathArg);
    if (!existsSync(fullPath)) {
      console.log(c.red("X"), `Path does not exist: ${fullPath}`);
      return null;
    }
    return { path: fullPath, label: `project (${fullPath})` };
  }

  const cwd = process.cwd();
  if (isGitRepo(cwd)) {
    console.log(c.green("V"), `Detected git repo: ${c.cyan(cwd)}`);
    return { path: cwd, label: `project (${cwd})` };
  }

  console.log(c.yellow("!"), `Current directory: ${c.cyan(cwd)}`);
  console.log(c.dim("   (not a git repository)\n"));
  console.log("Where would you like to install?\n");
  console.log("  1. Here", c.dim(`(${cwd})`));
  console.log("  2. Global", c.dim("(~/.claude/settings.json)"));
  console.log("  3. Enter a different path\n");

  const choice = await prompt("Choice (1/2/3): ");

  if (choice === "1") {
    return { path: cwd, label: `project (${cwd})` };
  } else if (choice === "2") {
    return { path: "global", label: "global (~/.claude/settings.json)" };
  } else if (choice === "3") {
    const inputPath = await prompt("Path: ");
    if (!inputPath) {
      console.log(c.red("X"), "No path provided");
      return null;
    }
    const fullPath = resolve(inputPath);
    if (!existsSync(fullPath)) {
      console.log(c.red("X"), `Path does not exist: ${fullPath}`);
      return null;
    }
    return { path: fullPath, label: `project (${fullPath})` };
  } else {
    console.log(c.red("X"), "Invalid choice");
    return null;
  }
}

async function promptForConfig(existingConfig: CheckTestsConfig = {}, projectPath?: string): Promise<CheckTestsConfig> {
  const config: CheckTestsConfig = { ...existingConfig };

  console.log(`\n${c.bold("Configuration")}\n`);

  // Edit threshold
  const currentThreshold = config.editThreshold || 3;
  console.log(c.bold("Edit Threshold:"));
  console.log(c.dim("  Run review after this many file edits (3-7)"));
  const thresholdInput = await prompt(`Threshold [${c.cyan(currentThreshold.toString())}]: `);

  if (thresholdInput) {
    const num = parseInt(thresholdInput, 10);
    if (!isNaN(num) && num >= 3 && num <= 7) {
      config.editThreshold = num;
    } else {
      console.log(c.yellow("!"), "Invalid threshold, using default (3)");
      config.editThreshold = 3;
    }
  } else if (!existingConfig.editThreshold) {
    config.editThreshold = 3;
  }

  // Task list
  const availableLists = projectPath ? getProjectTaskLists(projectPath) : getAllTaskLists();
  const qaLists = availableLists.filter((l) => l.toLowerCase().includes("qa"));

  console.log();
  console.log(c.bold("Task List ID:"));
  if (qaLists.length > 0) {
    console.log(c.dim("  QA lists for this project:"));
    qaLists.forEach((list, i) => {
      console.log(c.dim(`    ${i + 1}. ${list}`));
    });
  } else if (availableLists.length > 0) {
    console.log(c.dim("  Available lists:"));
    availableLists.slice(0, 5).forEach((list, i) => {
      console.log(c.dim(`    ${i + 1}. ${list}`));
    });
  }
  console.log(c.dim("  Leave empty to auto-detect (prefers *-qa list)"));

  const currentList = config.taskListId || "(auto-detect)";
  const listInput = await prompt(`Task list ID [${c.cyan(currentList)}]: `);

  if (listInput) {
    const num = parseInt(listInput, 10);
    const selectableLists = qaLists.length > 0 ? qaLists : availableLists;
    if (!isNaN(num) && num > 0 && num <= selectableLists.length) {
      config.taskListId = selectableLists[num - 1];
    } else {
      config.taskListId = listInput;
    }
  } else if (!existingConfig.taskListId) {
    config.taskListId = undefined;
  }

  // Keywords
  const currentKeywords = config.keywords?.join(", ") || "dev";
  console.log();
  console.log(c.bold("Keywords:"));
  console.log(c.dim("  Only run review for sessions matching these keywords"));
  const keywordsInput = await prompt(`Keywords (comma-separated) [${c.cyan(currentKeywords)}]: `);

  if (keywordsInput) {
    config.keywords = keywordsInput.split(",").map((k) => k.trim().toLowerCase()).filter(Boolean);
  } else if (!existingConfig.keywords) {
    config.keywords = ["dev"];
  }

  config.enabled = true;

  return config;
}

async function install(args: string[]) {
  console.log(`\n${c.bold("hook-checktests install")}\n`);

  const installOptions = parseInstallArgs(args);
  const target = await resolveTarget(args);
  if (!target) return;

  const settingsPath = getSettingsPath(target.path);
  let settings = readSettings(settingsPath);

  if (hookExists(settings)) {
    console.log(c.yellow("!"), `Hook already installed in ${target.label}`);
    if (installOptions.nonInteractive) {
      console.log(c.dim("  Updating configuration (non-interactive mode)"));
    } else {
      const update = await prompt("Update configuration? (y/n): ");
      if (update.toLowerCase() !== "y") return;
    }
  } else {
    settings = addHook(settings);
  }

  // Configure
  const existingConfig = getConfig(settings);
  const projectPath = target.path === "global" ? undefined : target.path;

  let config: CheckTestsConfig;
  if (installOptions.nonInteractive) {
    // Non-interactive mode: use provided options or defaults
    config = {
      ...existingConfig,
      editThreshold: installOptions.threshold ?? existingConfig.editThreshold ?? 3,
      taskListId: installOptions.taskListId ?? existingConfig.taskListId,
      keywords: installOptions.keywords ?? existingConfig.keywords ?? ["dev"],
      enabled: true,
    };
  } else {
    config = await promptForConfig(existingConfig, projectPath);
  }
  settings = setConfig(settings, config);

  writeSettings(settingsPath, settings);

  console.log();
  console.log(c.green("V"), `Installed to ${target.label}`);
  console.log();
  console.log(c.bold("Configuration:"));
  console.log(`  Threshold:    ${config.editThreshold || 3} edits`);
  console.log(`  Task list:    ${config.taskListId || c.cyan("(auto-detect)")}`);
  console.log(`  Keywords:     ${config.keywords?.join(", ") || "dev"}`);
  console.log(`  Async:        ${c.green("yes")} (non-blocking)`);
  console.log();
  console.log(c.bold("Requires:"));
  console.log(`  - service-implementation CLI (for task dispatch)`);
  console.log(`  - claude CLI (for headless agent)`);
  console.log();
}

async function configure(args: string[]) {
  console.log(`\n${c.bold("hook-checktests config")}\n`);

  const target = await resolveTarget(args);
  if (!target) return;

  const settingsPath = getSettingsPath(target.path);

  if (!existsSync(settingsPath)) {
    console.log(c.red("X"), `No settings file at ${settingsPath}`);
    console.log(c.dim("  Run 'hook-checktests install' first"));
    return;
  }

  let settings = readSettings(settingsPath);

  if (!hookExists(settings)) {
    console.log(c.red("X"), `Hook not installed in ${target.label}`);
    console.log(c.dim("  Run 'hook-checktests install' first"));
    return;
  }

  const existingConfig = getConfig(settings);
  const projectPath = target.path === "global" ? undefined : target.path;
  const config = await promptForConfig(existingConfig, projectPath);
  settings = setConfig(settings, config);

  writeSettings(settingsPath, settings);

  console.log();
  console.log(c.green("V"), `Configuration updated`);
  console.log();
  console.log(c.bold("New configuration:"));
  console.log(`  Threshold:    ${config.editThreshold || 3} edits`);
  console.log(`  Task list:    ${config.taskListId || c.cyan("(auto-detect)")}`);
  console.log(`  Keywords:     ${config.keywords?.join(", ") || "dev"}`);
  console.log();
}

async function uninstall(args: string[]) {
  console.log(`\n${c.bold("hook-checktests uninstall")}\n`);

  const target = await resolveTarget(args);
  if (!target) return;

  const settingsPath = getSettingsPath(target.path);

  if (!existsSync(settingsPath)) {
    console.log(c.yellow("!"), `No settings file at ${settingsPath}`);
    return;
  }

  const settings = readSettings(settingsPath);

  if (!hookExists(settings)) {
    console.log(c.yellow("!"), `Hook not found in ${target.label}`);
    return;
  }

  const updated = removeHook(settings);
  writeSettings(settingsPath, updated);

  console.log(c.green("V"), `Removed from ${target.label}`);
}

function status() {
  console.log(`\n${c.bold("hook-checktests status")}\n`);

  // Global
  const globalPath = getSettingsPath("global");
  const globalSettings = readSettings(globalPath);
  const globalInstalled = hookExists(globalSettings);
  const globalConfig = getConfig(globalSettings);

  console.log(
    globalInstalled ? c.green("V") : c.red("X"),
    "Global:",
    globalInstalled ? "Installed" : "Not installed",
    c.dim(`(${globalPath})`)
  );
  if (globalInstalled) {
    console.log(c.dim(`    Threshold: ${globalConfig.editThreshold || 3}, List: ${globalConfig.taskListId || "(auto)"}`));
  }

  // Current directory
  const cwd = process.cwd();
  const projectPath = getSettingsPath(cwd);
  if (existsSync(projectPath)) {
    const projectSettings = readSettings(projectPath);
    const projectInstalled = hookExists(projectSettings);
    const projectConfig = getConfig(projectSettings);

    console.log(
      projectInstalled ? c.green("V") : c.red("X"),
      "Project:",
      projectInstalled ? "Installed" : "Not installed",
      c.dim(`(${projectPath})`)
    );
    if (projectInstalled) {
      console.log(c.dim(`    Threshold: ${projectConfig.editThreshold || 3}, List: ${projectConfig.taskListId || "(auto)"}`));
    }
  } else {
    console.log(c.dim("."), "Project:", c.dim("No .claude/settings.json"));
  }

  // Check dependencies
  console.log();
  console.log(c.bold("Dependencies:"));

  try {
    const { execSync } = require("child_process");
    execSync("which service-implementation", { stdio: "pipe" });
    console.log(c.green("V"), "service-implementation CLI");
  } catch {
    console.log(c.red("X"), "service-implementation CLI", c.dim("(required for task dispatch)"));
  }

  try {
    const { execSync } = require("child_process");
    execSync("which claude", { stdio: "pipe" });
    console.log(c.green("V"), "claude CLI");
  } catch {
    console.log(c.red("X"), "claude CLI", c.dim("(required for headless review)"));
  }

  console.log();
}

// Main
const args = process.argv.slice(2);
const command = args[0];
const commandArgs = args.slice(1);

switch (command) {
  case "install":
    install(commandArgs);
    break;
  case "config":
    configure(commandArgs);
    break;
  case "uninstall":
    uninstall(commandArgs);
    break;
  case "run":
    import("./hook.js").then((m) => m.run());
    break;
  case "status":
    status();
    break;
  case "--help":
  case "-h":
  case undefined:
    printUsage();
    break;
  default:
    console.error(c.red(`Unknown command: ${command}`));
    printUsage();
    process.exit(1);
}
