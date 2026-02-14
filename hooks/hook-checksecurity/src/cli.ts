#!/usr/bin/env bun

/**
 * @hasna/hook-checksecurity CLI
 *
 * Usage:
 *   hook-checksecurity install           Auto-detect location, configure options
 *   hook-checksecurity install --global  Force global install
 *   hook-checksecurity install /path     Install to specific path
 *   hook-checksecurity config            Update configuration
 *   hook-checksecurity uninstall         Remove hook
 *   hook-checksecurity run               Execute hook (called by Claude Code)
 *   hook-checksecurity status            Show installation status
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync } from "fs";
import { join, dirname, resolve } from "path";
import { homedir } from "os";
import { execSync } from "child_process";
import * as readline from "readline";

const PACKAGE_NAME = "@hasna/hook-checksecurity";
const CONFIG_KEY = "checkSecurityConfig";

// Colors
const c = {
  red: (s: string) => `\x1b[31m${s}\x1b[0m`,
  green: (s: string) => `\x1b[32m${s}\x1b[0m`,
  yellow: (s: string) => `\x1b[33m${s}\x1b[0m`,
  cyan: (s: string) => `\x1b[36m${s}\x1b[0m`,
  dim: (s: string) => `\x1b[2m${s}\x1b[0m`,
  bold: (s: string) => `\x1b[1m${s}\x1b[0m`,
};

interface CheckSecurityConfig {
  taskListId?: string;
  keywords?: string[];
  enabled?: boolean;
}

interface InstallOptions {
  taskListId?: string;
  keywords?: string[];
  nonInteractive: boolean;
}

function parseInstallArgs(args: string[]): { remainingArgs: string[]; options: InstallOptions } {
  const options: InstallOptions = {
    nonInteractive: false,
  };
  const remainingArgs: string[] = [];

  let i = 0;
  while (i < args.length) {
    const arg = args[i];

    if (arg === "--yes" || arg === "-y") {
      options.nonInteractive = true;
      i++;
    } else if (arg === "--task-list-id" || arg === "-t") {
      if (i + 1 < args.length) {
        options.taskListId = args[i + 1];
        i += 2;
      } else {
        console.error(c.red("X"), `${arg} requires a value`);
        process.exit(1);
      }
    } else if (arg === "--keywords" || arg === "-k") {
      if (i + 1 < args.length) {
        options.keywords = args[i + 1].split(",").map((k) => k.trim().toLowerCase()).filter(Boolean);
        i += 2;
      } else {
        console.error(c.red("X"), `${arg} requires a value`);
        process.exit(1);
      }
    } else {
      remainingArgs.push(arg);
      i++;
    }
  }

  // If any explicit option is provided, enable non-interactive mode
  if (options.taskListId !== undefined || options.keywords !== undefined) {
    options.nonInteractive = true;
  }

  return { remainingArgs, options };
}

function printUsage() {
  console.log(`
${c.bold("hook-checksecurity")} - Runs security checks via Claude and Codex headless agents

${c.bold("USAGE:")}
  hook-checksecurity install [path]     Install the hook
  hook-checksecurity config [path]      Update configuration
  hook-checksecurity uninstall [path]   Remove the hook
  hook-checksecurity status             Show hook status
  hook-checksecurity run                Execute hook ${c.dim("(called by Claude Code)")}

${c.bold("OPTIONS:")}
  ${c.dim("(no args)")}              Auto-detect: if in git repo -> install there, else -> prompt
  --global, -g           Apply to ~/.claude/settings.json
  /path/to/repo          Apply to specific project path

${c.bold("INSTALL OPTIONS:")}
  --task-list-id, -t <id>   Task list ID for dispatching security tasks
  --keywords, -k <k1,k2>    Keywords (comma-separated), only run for matching sessions
  --yes, -y                 Non-interactive mode, use defaults/provided values

${c.bold("EXAMPLES:")}
  hook-checksecurity install              ${c.dim("# Install with config prompts")}
  hook-checksecurity install --global     ${c.dim("# Global install")}
  hook-checksecurity install -y           ${c.dim("# Non-interactive with defaults")}
  hook-checksecurity install -t my-dev -k dev,bugfixes -y  ${c.dim("# Non-interactive with options")}
  hook-checksecurity config               ${c.dim("# Update task list, keywords")}
  hook-checksecurity status               ${c.dim("# Check what's installed")}

${c.bold("CONFIGURATION:")}
  taskListId     Task list for dispatching security tasks (auto-detected if not set)
  keywords       Only run for sessions matching keywords (default: dev)

${c.bold("HOW IT WORKS:")}
  1. Runs on Stop event (before session ends)
  2. Checks if [prefix]-[name] repo pattern
  3. Only runs once per session (prevents re-runs)
  4. Spawns Claude headless for security review
  5. Spawns Codex headless for security review
  6. Both create tasks via service-implementation
  7. hook-checktasks then blocks if tasks exist

${c.bold("REQUIRES:")}
  - claude CLI (for headless agent)
  - codex CLI (for headless agent) - optional
  - service-implementation CLI (for task dispatch)

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

function getConfig(settings: Record<string, unknown>): CheckSecurityConfig {
  return (settings[CONFIG_KEY] as CheckSecurityConfig) || {};
}

function setConfig(settings: Record<string, unknown>, config: CheckSecurityConfig): Record<string, unknown> {
  settings[CONFIG_KEY] = config;
  return settings;
}

function addHook(settings: Record<string, unknown>): Record<string, unknown> {
  const hookConfig = {
    type: "command",
    command: getHookCommand(),
    timeout: 300, // 5 minutes for security scan
  };

  if (!settings.hooks) settings.hooks = {};
  const hooks = settings.hooks as Record<string, unknown[]>;

  if (!hooks.Stop) {
    hooks.Stop = [{ hooks: [hookConfig] }];
  } else {
    const stopHooks = hooks.Stop as Array<{ hooks?: unknown[] }>;
    // Add to first group or create new
    if (stopHooks[0]?.hooks) {
      // Insert at beginning so it runs before checktasks
      stopHooks[0].hooks.unshift(hookConfig);
    } else {
      stopHooks.unshift({ hooks: [hookConfig] });
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

async function promptForConfig(existingConfig: CheckSecurityConfig = {}, projectPath?: string): Promise<CheckSecurityConfig> {
  const config: CheckSecurityConfig = { ...existingConfig };

  console.log(`\n${c.bold("Configuration")}\n`);

  // Task list
  const availableLists = projectPath ? getProjectTaskLists(projectPath) : getAllTaskLists();
  const devLists = availableLists.filter((l) => l.toLowerCase().includes("dev"));

  console.log(c.bold("Task List ID:"));
  if (devLists.length > 0) {
    console.log(c.dim("  Dev lists for this project:"));
    devLists.forEach((list, i) => {
      console.log(c.dim(`    ${i + 1}. ${list}`));
    });
  } else if (availableLists.length > 0) {
    console.log(c.dim("  Available lists:"));
    availableLists.slice(0, 5).forEach((list, i) => {
      console.log(c.dim(`    ${i + 1}. ${list}`));
    });
  }
  console.log(c.dim("  Leave empty to auto-detect (prefers *-dev list)"));

  const currentList = config.taskListId || "(auto-detect)";
  const listInput = await prompt(`Task list ID [${c.cyan(currentList)}]: `);

  if (listInput) {
    const num = parseInt(listInput, 10);
    const selectableLists = devLists.length > 0 ? devLists : availableLists;
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
  console.log(c.dim("  Only run security check for sessions matching these keywords"));
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
  console.log(`\n${c.bold("hook-checksecurity install")}\n`);

  const { remainingArgs, options } = parseInstallArgs(args);

  const target = await resolveTarget(remainingArgs);
  if (!target) return;

  const settingsPath = getSettingsPath(target.path);
  let settings = readSettings(settingsPath);

  if (hookExists(settings)) {
    console.log(c.yellow("!"), `Hook already installed in ${target.label}`);
    if (options.nonInteractive) {
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

  let config: CheckSecurityConfig;
  if (options.nonInteractive) {
    // Non-interactive mode: use provided values or defaults
    config = {
      taskListId: options.taskListId ?? existingConfig.taskListId,
      keywords: options.keywords ?? existingConfig.keywords ?? ["dev"],
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
  console.log(`  Task list:    ${config.taskListId || c.cyan("(auto-detect)")}`);
  console.log(`  Keywords:     ${config.keywords?.join(", ") || "dev"}`);
  console.log(`  Event:        ${c.yellow("Stop")} (blocker)`);
  console.log();
  console.log(c.bold("Requires:"));
  console.log(`  - claude CLI (for headless agent)`);
  console.log(`  - codex CLI (for headless agent) - optional`);
  console.log(`  - service-implementation CLI (for task dispatch)`);
  console.log();
}

async function configure(args: string[]) {
  console.log(`\n${c.bold("hook-checksecurity config")}\n`);

  const target = await resolveTarget(args);
  if (!target) return;

  const settingsPath = getSettingsPath(target.path);

  if (!existsSync(settingsPath)) {
    console.log(c.red("X"), `No settings file at ${settingsPath}`);
    console.log(c.dim("  Run 'hook-checksecurity install' first"));
    return;
  }

  let settings = readSettings(settingsPath);

  if (!hookExists(settings)) {
    console.log(c.red("X"), `Hook not installed in ${target.label}`);
    console.log(c.dim("  Run 'hook-checksecurity install' first"));
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
  console.log(`  Task list:    ${config.taskListId || c.cyan("(auto-detect)")}`);
  console.log(`  Keywords:     ${config.keywords?.join(", ") || "dev"}`);
  console.log();
}

async function uninstall(args: string[]) {
  console.log(`\n${c.bold("hook-checksecurity uninstall")}\n`);

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
  console.log(`\n${c.bold("hook-checksecurity status")}\n`);

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
    console.log(c.dim(`    List: ${globalConfig.taskListId || "(auto)"}, Keywords: ${globalConfig.keywords?.join(", ") || "dev"}`));
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
      console.log(c.dim(`    List: ${projectConfig.taskListId || "(auto)"}, Keywords: ${projectConfig.keywords?.join(", ") || "dev"}`));
    }
  } else {
    console.log(c.dim("."), "Project:", c.dim("No .claude/settings.json"));
  }

  // Check dependencies
  console.log();
  console.log(c.bold("Dependencies:"));

  try {
    execSync("which service-implementation", { stdio: "pipe" });
    console.log(c.green("V"), "service-implementation CLI");
  } catch {
    console.log(c.red("X"), "service-implementation CLI", c.dim("(required for task dispatch)"));
  }

  try {
    execSync("which claude", { stdio: "pipe" });
    console.log(c.green("V"), "claude CLI");
  } catch {
    console.log(c.red("X"), "claude CLI", c.dim("(required for security review)"));
  }

  try {
    execSync("which codex", { stdio: "pipe" });
    console.log(c.green("V"), "codex CLI");
  } catch {
    console.log(c.yellow("!"), "codex CLI", c.dim("(optional, for additional security review)"));
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
