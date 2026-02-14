/**
 * Hook installer - registers hooks in AI coding agent settings
 *
 * Supports:
 * - Claude Code: ~/.claude/settings.json (PreToolUse, PostToolUse, Stop, Notification)
 * - Gemini CLI: ~/.gemini/settings.json (BeforeTool, AfterTool, AfterAgent, Notification)
 *
 * Hooks run directly from the globally installed @hasna/hooks package.
 * No files are copied. The settings entry points to `hooks run <name>`.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { join, dirname } from "path";
import { homedir } from "os";
import { fileURLToPath } from "url";
import { getHook } from "./registry.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const HOOKS_DIR = existsSync(join(__dirname, "..", "..", "hooks", "hook-gitguard"))
  ? join(__dirname, "..", "..", "hooks")
  : join(__dirname, "..", "hooks");

export type Scope = "global" | "project";
export type Target = "claude" | "gemini" | "all";

/** Map our internal event names to each target's event names */
const EVENT_MAP: Record<string, Record<string, string>> = {
  claude: {
    PreToolUse: "PreToolUse",
    PostToolUse: "PostToolUse",
    Stop: "Stop",
    Notification: "Notification",
  },
  gemini: {
    PreToolUse: "BeforeTool",
    PostToolUse: "AfterTool",
    Stop: "AfterAgent",
    Notification: "Notification",
  },
};

/** Settings file paths per target */
function getTargetSettingsDir(target: "claude" | "gemini"): string {
  if (target === "gemini") return ".gemini";
  return ".claude";
}

export interface InstallResult {
  hook: string;
  success: boolean;
  error?: string;
  scope?: Scope;
  target?: Target;
}

export interface InstallOptions {
  scope?: Scope;
  overwrite?: boolean;
  target?: Target;
}

export function getSettingsPath(scope: Scope = "global", target: "claude" | "gemini" = "claude"): string {
  const dir = getTargetSettingsDir(target);
  if (scope === "project") {
    return join(process.cwd(), dir, "settings.json");
  }
  return join(homedir(), dir, "settings.json");
}

export function getHookPath(name: string): string {
  const hookName = name.startsWith("hook-") ? name : `hook-${name}`;
  return join(HOOKS_DIR, hookName);
}

export function hookExists(name: string): boolean {
  return existsSync(getHookPath(name));
}

function readSettings(scope: Scope = "global", target: "claude" | "gemini" = "claude"): Record<string, any> {
  const path = getSettingsPath(scope, target);
  try {
    if (existsSync(path)) {
      return JSON.parse(readFileSync(path, "utf-8"));
    }
  } catch {}
  return {};
}

function writeSettings(settings: Record<string, any>, scope: Scope = "global", target: "claude" | "gemini" = "claude"): void {
  const path = getSettingsPath(scope, target);
  const dir = dirname(path);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  writeFileSync(path, JSON.stringify(settings, null, 2) + "\n");
}

function getTargetEventName(internalEvent: string, target: "claude" | "gemini"): string {
  return EVENT_MAP[target]?.[internalEvent] || internalEvent;
}

function installForTarget(name: string, scope: Scope, overwrite: boolean, target: "claude" | "gemini"): InstallResult {
  const hookName = name.startsWith("hook-") ? name : `hook-${name}`;
  const shortName = hookName.replace("hook-", "");

  if (!hookExists(shortName)) {
    return { hook: shortName, success: false, error: `Hook '${shortName}' not found`, target };
  }

  const registered = getRegisteredHooksForTarget(scope, target);
  if (registered.includes(shortName) && !overwrite) {
    return { hook: shortName, success: false, error: "Already installed. Use --overwrite to replace.", scope, target };
  }

  try {
    registerHook(shortName, scope, target);
    return { hook: shortName, success: true, scope, target };
  } catch (error) {
    return {
      hook: shortName,
      success: false,
      error: error instanceof Error ? error.message : "Unknown error",
      target,
    };
  }
}

export function installHook(name: string, options: InstallOptions = {}): InstallResult {
  const { scope = "global", overwrite = false, target = "claude" } = options;

  if (target === "all") {
    // Install to both targets, return the first result (they should match)
    const claudeResult = installForTarget(name, scope, overwrite, "claude");
    installForTarget(name, scope, overwrite, "gemini");
    return { ...claudeResult, target: "all" };
  }

  return installForTarget(name, scope, overwrite, target as "claude" | "gemini");
}

function registerHook(name: string, scope: Scope = "global", target: "claude" | "gemini" = "claude"): void {
  const meta = getHook(name);
  if (!meta) return;

  const settings = readSettings(scope, target);
  if (!settings.hooks) settings.hooks = {};

  const eventKey = getTargetEventName(meta.event, target);
  if (!settings.hooks[eventKey]) settings.hooks[eventKey] = [];

  const hookCommand = `hooks run ${name}`;

  settings.hooks[eventKey] = settings.hooks[eventKey].filter(
    (entry: any) => !entry.hooks?.some((h: any) => h.command === hookCommand)
  );

  const entry: Record<string, any> = {
    hooks: [{ type: "command", command: hookCommand }],
  };
  if (meta.matcher) {
    entry.matcher = meta.matcher;
  }

  settings.hooks[eventKey].push(entry);
  writeSettings(settings, scope, target);
}

function unregisterHook(name: string, scope: Scope = "global", target: "claude" | "gemini" = "claude"): void {
  const meta = getHook(name);
  if (!meta) return;

  const settings = readSettings(scope, target);
  if (!settings.hooks) return;

  const eventKey = getTargetEventName(meta.event, target);
  if (!settings.hooks[eventKey]) return;

  const hookCommand = `hooks run ${name}`;
  settings.hooks[eventKey] = settings.hooks[eventKey].filter(
    (entry: any) => !entry.hooks?.some((h: any) => h.command === hookCommand)
  );

  if (settings.hooks[eventKey].length === 0) {
    delete settings.hooks[eventKey];
  }
  if (Object.keys(settings.hooks).length === 0) {
    delete settings.hooks;
  }

  writeSettings(settings, scope, target);
}

export function installHooks(names: string[], options: InstallOptions = {}): InstallResult[] {
  return names.map((name) => installHook(name, options));
}

function getRegisteredHooksForTarget(scope: Scope = "global", target: "claude" | "gemini" = "claude"): string[] {
  const settings = readSettings(scope, target);
  if (!settings.hooks) return [];

  const registered: string[] = [];
  for (const eventKey of Object.keys(settings.hooks)) {
    for (const entry of settings.hooks[eventKey]) {
      for (const hook of entry.hooks || []) {
        const newMatch = hook.command?.match(/^hooks run (\w+)$/);
        const oldMatch = hook.command?.match(/^hook-(\w+)$/);
        const match = newMatch || oldMatch;
        if (match) {
          registered.push(match[1]);
        }
      }
    }
  }
  return [...new Set(registered)];
}

export function getRegisteredHooks(scope: Scope = "global"): string[] {
  return getRegisteredHooksForTarget(scope, "claude");
}

export function getInstalledHooks(scope: Scope = "global"): string[] {
  return getRegisteredHooks(scope);
}

export function removeHook(name: string, scope: Scope = "global", target: Target = "claude"): boolean {
  const hookName = name.startsWith("hook-") ? name : `hook-${name}`;
  const shortName = hookName.replace("hook-", "");

  if (target === "all") {
    const claudeRemoved = removeHookForTarget(shortName, scope, "claude");
    const geminiRemoved = removeHookForTarget(shortName, scope, "gemini");
    return claudeRemoved || geminiRemoved;
  }

  return removeHookForTarget(shortName, scope, target as "claude" | "gemini");
}

function removeHookForTarget(name: string, scope: Scope, target: "claude" | "gemini"): boolean {
  const registered = getRegisteredHooksForTarget(scope, target);
  if (!registered.includes(name)) {
    return false;
  }
  unregisterHook(name, scope, target);
  return true;
}
