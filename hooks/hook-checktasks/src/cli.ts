#!/usr/bin/env bun

/**
 * @hasna/hook-checktasks CLI
 *
 * Usage:
 *   hook-checktasks install           Auto-detect location, configure task list
 *   hook-checktasks install --global  Force global install
 *   hook-checktasks install /path     Install to specific path
 *   hook-checktasks config            Update configuration
 *   hook-checktasks uninstall         Remove hook
 *   hook-checktasks run               Execute hook (called by Claude Code)
 *   hook-checktasks status            Show installation status
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync } from "fs";
import { join, dirname, resolve } from "path";
import { homedir } from "os";
import * as readline from "readline";

const PACKAGE_NAME = "@hasna/hook-checktasks";
const CONFIG_KEY = "checkTasksConfig";

// Colors
const c = {
  red: (s: string) => `\x1b[31m${s}\x1b[0m`,
  green: (s: string) => `\x1b[32m${s}\x1b[0m`,
  yellow: (s: string) => `\x1b[33m${s}\x1b[0m`,
  cyan: (s: string) => `\x1b[36m${s}\x1b[0m`,
  dim: (s: string) => `\x1b[2m${s}\x1b[0m`,
  bold: (s: string) => `\x1b[1m${s}\x1b[0m`,
};

interface CheckTasksConfig {
  taskListId?: string; // specific list, or undefined = check all
  keywords?: string[]; // keywords to match (default: ["dev"])
  enabled?: boolean; // enable/disable hook
}

function printUsage() {
  console.log(`
${c.bold("hook-checktasks")} - Prevents Claude from stopping with pending tasks

${c.bold("USAGE:")}
  hook-checktasks install [path]     Install the hook
  hook-checktasks config [path]      Update configuration
  hook-checktasks uninstall [path]   Remove the hook
  hook-checktasks status             Show hook status
  hook-checktasks run                Execute hook ${c.dim("(called by Claude Code)")}

${c.bold("OPTIONS:")}
  ${c.dim("(no args)")}      Auto-detect: if in git repo → install there, else → prompt
  --global, -g            Apply to ~/.claude/settings.json
  --task-list-id, -t <id> Task list ID (non-interactive)
  --keywords, -k <k1,k2>  Keywords, comma-separated (non-interactive)
  --yes, -y               Non-interactive mode, use defaults
  /path/to/repo           Apply to specific project path

${c.bold("EXAMPLES:")}
  hook-checktasks install              ${c.dim("# Install with config prompts")}
  hook-checktasks install --global     ${c.dim("# Global install")}
  hook-checktasks install -t myproject-dev -y  ${c.dim("# Non-interactive")}
  hook-checktasks config               ${c.dim("# Update task list ID, keywords")}
  hook-checktasks status               ${c.dim("# Check what's installed")}

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
  if (!hooks?.Stop) return false;
  const stopHooks = hooks.Stop as Array<{ hooks?: Array<{ command?: string }> }>;
  return stopHooks.some((group) =>
    group.hooks?.some((h) => h.command?.includes(PACKAGE_NAME))
  );
}

function getConfig(settings: Record<string, unknown>): CheckTasksConfig {
  return (settings[CONFIG_KEY] as CheckTasksConfig) || {};
}

function setConfig(settings: Record<string, unknown>, config: CheckTasksConfig): Record<string, unknown> {
  settings[CONFIG_KEY] = config;
  return settings;
}

function addHook(settings: Record<string, unknown>): Record<string, unknown> {
  const hookConfig = {
    type: "command",
    command: getHookCommand(),
    timeout: 120,
  };

  if (!settings.hooks) settings.hooks = {};
  const hooks = settings.hooks as Record<string, unknown[]>;

  if (!hooks.Stop) {
    hooks.Stop = [{ hooks: [hookConfig] }];
  } else {
    const stopHooks = hooks.Stop as Array<{ hooks?: unknown[] }>;
    if (stopHooks[0]?.hooks) {
      stopHooks[0].hooks.push(hookConfig);
    } else {
      stopHooks.push({ hooks: [hookConfig] });
    }
  }
  return settings;
}

function removeHook(settings: Record<string, unknown>): Record<string, unknown> {
  const hooks = settings.hooks as Record<string, unknown[]> | undefined;
  if (!hooks?.Stop) return settings;

  const stopHooks = hooks.Stop as Array<{ hooks?: Array<{ command?: string }> }>;
  for (const group of stopHooks) {
    if (group.hooks) {
      group.hooks = group.hooks.filter((h) => !h.command?.includes(PACKAGE_NAME));
    }
  }
  hooks.Stop = stopHooks.filter((g) => g.hooks && g.hooks.length > 0);
  if (hooks.Stop.length === 0) delete hooks.Stop;

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

  // Get the directory name as project identifier
  const dirName = projectPath.split("/").filter(Boolean).pop() || "";

  // Filter lists that match the project name
  // Match patterns like: project-dev, project-plan, project-bugfixes, etc.
  const projectLists = allLists.filter((list) => {
    const listLower = list.toLowerCase();
    const dirLower = dirName.toLowerCase();

    // Exact prefix match (e.g., "connect-x" matches "connect-x-dev")
    if (listLower.startsWith(dirLower + "-")) return true;

    // Also match if the list contains the dir name as a segment
    // e.g., "iapp-copypine-dev" matches if we're in "iapp-copypine"
    if (listLower.includes(dirLower)) return true;

    return false;
  });

  return projectLists;
}

interface InstallOptions {
  global?: boolean;
  taskListId?: string;
  keywords?: string[];
  yes?: boolean;
  path?: string;
}

function parseInstallArgs(args: string[]): InstallOptions {
  const options: InstallOptions = {};

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];

    if (arg === "--global" || arg === "-g") {
      options.global = true;
    } else if (arg === "--yes" || arg === "-y") {
      options.yes = true;
    } else if (arg === "--task-list-id" || arg === "-t") {
      options.taskListId = args[++i];
    } else if (arg === "--keywords" || arg === "-k") {
      options.keywords = args[++i]?.split(",").map(k => k.trim().toLowerCase()).filter(Boolean);
    } else if (!arg.startsWith("-")) {
      options.path = arg;
    }
  }

  return options;
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
      console.log(c.red("✗"), `Path does not exist: ${fullPath}`);
      return null;
    }
    return { path: fullPath, label: `project (${fullPath})` };
  }

  const cwd = process.cwd();
  if (isGitRepo(cwd)) {
    console.log(c.green("✓"), `Detected git repo: ${c.cyan(cwd)}`);
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
      console.log(c.red("✗"), "No path provided");
      return null;
    }
    const fullPath = resolve(inputPath);
    if (!existsSync(fullPath)) {
      console.log(c.red("✗"), `Path does not exist: ${fullPath}`);
      return null;
    }
    return { path: fullPath, label: `project (${fullPath})` };
  } else {
    console.log(c.red("✗"), "Invalid choice");
    return null;
  }
}

async function promptForConfig(existingConfig: CheckTasksConfig = {}, projectPath?: string): Promise<CheckTasksConfig> {
  const config: CheckTasksConfig = { ...existingConfig };

  // Show available task lists for this project
  const availableLists = projectPath ? getProjectTaskLists(projectPath) : getAllTaskLists();

  console.log(`\n${c.bold("Configuration")}\n`);

  // Task list selection
  console.log(c.bold("Task List ID:"));
  if (availableLists.length > 0) {
    console.log(c.dim("  Available lists for this project:"));
    availableLists.forEach((list, i) => {
      console.log(c.dim(`    ${i + 1}. ${list}`));
    });
  } else {
    console.log(c.dim("  No task lists found for this project"));
  }
  console.log(c.dim("  Leave empty to check all matching lists\n"));

  const currentList = config.taskListId || "(all lists)";
  const listInput = await prompt(`Task list ID [${c.cyan(currentList)}]: `);

  if (listInput) {
    // Check if user entered a number (selecting from list)
    const num = parseInt(listInput, 10);
    if (!isNaN(num) && num > 0 && num <= availableLists.length) {
      config.taskListId = availableLists[num - 1];
    } else {
      config.taskListId = listInput;
    }
  } else if (!existingConfig.taskListId) {
    // Empty input + no existing = check all
    config.taskListId = undefined;
  }

  // Keywords
  const currentKeywords = config.keywords?.join(", ") || "dev";
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
  console.log(`\n${c.bold("hook-checktasks install")}\n`);

  const options = parseInstallArgs(args);

  // Resolve target path
  let target: { path: string | "global"; label: string } | null = null;

  if (options.global) {
    target = { path: "global", label: "global (~/.claude/settings.json)" };
  } else if (options.path) {
    const fullPath = resolve(options.path);
    if (!existsSync(fullPath)) {
      console.log(c.red("✗"), `Path does not exist: ${fullPath}`);
      return;
    }
    target = { path: fullPath, label: `project (${fullPath})` };
  } else if (options.yes) {
    // Non-interactive mode: use current directory
    const cwd = process.cwd();
    target = { path: cwd, label: `project (${cwd})` };
  } else {
    target = await resolveTarget(args);
  }

  if (!target) return;

  const settingsPath = getSettingsPath(target.path);
  let settings = readSettings(settingsPath);

  if (hookExists(settings)) {
    console.log(c.yellow("!"), `Hook already installed in ${target.label}`);
    if (!options.yes) {
      const update = await prompt("Update configuration? (y/n): ");
      if (update.toLowerCase() !== "y") return;
    }
  } else {
    settings = addHook(settings);
  }

  // Configure
  const existingConfig = getConfig(settings);
  let config: CheckTasksConfig;

  if (options.yes || options.taskListId || options.keywords) {
    // Non-interactive mode
    config = {
      ...existingConfig,
      taskListId: options.taskListId || existingConfig.taskListId,
      keywords: options.keywords || existingConfig.keywords || ["dev"],
      enabled: true,
    };
  } else {
    // Interactive mode
    const projectPath = target.path === "global" ? undefined : target.path;
    config = await promptForConfig(existingConfig, projectPath);
  }

  settings = setConfig(settings, config);
  writeSettings(settingsPath, settings);

  console.log();
  console.log(c.green("✓"), `Installed to ${target.label}`);
  console.log();
  console.log(c.bold("Configuration:"));
  console.log(`  Task list: ${config.taskListId || c.cyan("(all lists)")}`);
  console.log(`  Keywords:  ${config.keywords?.join(", ") || "dev"}`);
  console.log();
}

async function configure(args: string[]) {
  console.log(`\n${c.bold("hook-checktasks config")}\n`);

  const target = await resolveTarget(args);
  if (!target) return;

  const settingsPath = getSettingsPath(target.path);

  if (!existsSync(settingsPath)) {
    console.log(c.red("✗"), `No settings file at ${settingsPath}`);
    console.log(c.dim("  Run 'hook-checktasks install' first"));
    return;
  }

  let settings = readSettings(settingsPath);

  if (!hookExists(settings)) {
    console.log(c.red("✗"), `Hook not installed in ${target.label}`);
    console.log(c.dim("  Run 'hook-checktasks install' first"));
    return;
  }

  const existingConfig = getConfig(settings);
  const projectPath = target.path === "global" ? undefined : target.path;
  const config = await promptForConfig(existingConfig, projectPath);
  settings = setConfig(settings, config);

  writeSettings(settingsPath, settings);

  console.log();
  console.log(c.green("✓"), `Configuration updated`);
  console.log();
  console.log(c.bold("New configuration:"));
  console.log(`  Task list: ${config.taskListId || c.cyan("(all lists)")}`);
  console.log(`  Keywords:  ${config.keywords?.join(", ") || "dev"}`);
  console.log();
}

async function uninstall(args: string[]) {
  console.log(`\n${c.bold("hook-checktasks uninstall")}\n`);

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

  console.log(c.green("✓"), `Removed from ${target.label}`);
}

function status() {
  console.log(`\n${c.bold("hook-checktasks status")}\n`);

  // Global
  const globalPath = getSettingsPath("global");
  const globalSettings = readSettings(globalPath);
  const globalInstalled = hookExists(globalSettings);
  const globalConfig = getConfig(globalSettings);

  console.log(
    globalInstalled ? c.green("✓") : c.red("✗"),
    "Global:",
    globalInstalled ? "Installed" : "Not installed",
    c.dim(`(${globalPath})`)
  );
  if (globalInstalled) {
    console.log(c.dim(`    List: ${globalConfig.taskListId || "(all)"}, Keywords: ${globalConfig.keywords?.join(", ") || "dev"}`));
  }

  // Current directory
  const cwd = process.cwd();
  const projectPath = getSettingsPath(cwd);
  if (existsSync(projectPath)) {
    const projectSettings = readSettings(projectPath);
    const projectInstalled = hookExists(projectSettings);
    const projectConfig = getConfig(projectSettings);

    console.log(
      projectInstalled ? c.green("✓") : c.red("✗"),
      "Project:",
      projectInstalled ? "Installed" : "Not installed",
      c.dim(`(${projectPath})`)
    );
    if (projectInstalled) {
      console.log(c.dim(`    List: ${projectConfig.taskListId || "(all)"}, Keywords: ${projectConfig.keywords?.join(", ") || "dev"}`));
    }
  } else {
    console.log(c.dim("·"), "Project:", c.dim("No .claude/settings.json"));
  }

  // Available task lists for current directory
  const projectLists = getProjectTaskLists(cwd);
  if (projectLists.length > 0) {
    console.log();
    console.log(c.bold("Task lists for this project:"));
    projectLists.forEach((list) => console.log(c.dim(`  - ${list}`)));
  } else {
    const allLists = getAllTaskLists();
    if (allLists.length > 0) {
      console.log();
      console.log(c.bold("All task lists:"), c.dim("(none match this project)"));
      allLists.slice(0, 10).forEach((list) => console.log(c.dim(`  - ${list}`)));
      if (allLists.length > 10) {
        console.log(c.dim(`  ... and ${allLists.length - 10} more`));
      }
    }
  }

  // Environment (legacy)
  const envTaskList = process.env.CLAUDE_CODE_TASK_LIST_ID;
  if (envTaskList) {
    console.log();
    console.log(c.bold("Environment (legacy):"));
    console.log(`  CLAUDE_CODE_TASK_LIST_ID: ${envTaskList}`);
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
