/**
 * Hook installer - registers hooks in AI coding agent settings
 *
 * Supports:
 * - Claude Code: ~/.claude/settings.json (PreToolUse, PostToolUse, Stop, Notification, SessionStart, SessionEnd)
 * - Gemini CLI: ~/.gemini/settings.json (BeforeTool, AfterTool, AfterAgent, Notification — no session events)
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

function normalizeHookName(name: string): string {
  return name.startsWith("hook-") ? name : `hook-${name}`;
}

function shortHookName(name: string): string {
  return normalizeHookName(name).replace("hook-", "");
}

function removeHookEntriesByName(entries: any[], hookName: string): any[] {
  return entries.filter(
    (entry: any) => !entry.hooks?.some((h: any) => {
      // [\w-]+ — hook names may contain hyphens (announce-start, fleet-catchup, …)
      const match = h.command?.match(/^hooks run ([\w-]+)/);
      return match && match[1] === hookName;
    })
  );
}

/**
 * Map our internal event names to each target's event names.
 * `null` means the target has no equivalent surface for that event —
 * installs for that target fail with a clear error instead of writing
 * an event key the runtime would silently ignore.
 */
const EVENT_MAP: Record<string, Record<string, string | null>> = {
  claude: {
    PreToolUse: "PreToolUse",
    PostToolUse: "PostToolUse",
    Stop: "Stop",
    Notification: "Notification",
    SessionStart: "SessionStart",
    SessionEnd: "SessionEnd",
  },
  gemini: {
    PreToolUse: "BeforeTool",
    PostToolUse: "AfterTool",
    Stop: "AfterAgent",
    Notification: "Notification",
    SessionStart: null,
    SessionEnd: null,
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
  conflict?: string;
}

export interface InstallOptions {
  scope?: Scope;
  overwrite?: boolean;
  target?: Target;
  profile?: string;
}

export function getSettingsPath(scope: Scope = "global", target: "claude" | "gemini" = "claude"): string {
  const dir = getTargetSettingsDir(target);
  if (scope === "project") {
    return join(process.cwd(), dir, "settings.json");
  }
  return join(homedir(), dir, "settings.json");
}

export function getHookPath(name: string): string {
  return join(HOOKS_DIR, normalizeHookName(name));
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
  } catch (error) {
    console.warn(`[hooks] Failed to read settings at ${path}: ${error instanceof Error ? error.message : String(error)}`);
  }
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

/** Returns the target's event key, or null when the target does not support the event */
function getTargetEventName(internalEvent: string, target: "claude" | "gemini"): string | null {
  const targetMap = EVENT_MAP[target];
  if (!targetMap) return internalEvent;
  if (!(internalEvent in targetMap)) return internalEvent;
  return targetMap[internalEvent];
}

/** Whether a hook's event can be registered for the given target */
export function isEventSupported(internalEvent: string, target: "claude" | "gemini"): boolean {
  return getTargetEventName(internalEvent, target) !== null;
}

/** Check if a hook conflicts with any already-installed hook (same event + overlapping matcher) */
function detectConflict(name: string, scope: Scope, target: "claude" | "gemini"): string | undefined {
  const meta = getHook(name);
  if (!meta || !meta.matcher) return undefined; // hooks with no matcher can't conflict

  const registered = getRegisteredHooksForTarget(scope, target);
  for (const existingName of registered) {
    if (existingName === name) continue;
    const existing = getHook(existingName);
    if (!existing || existing.event !== meta.event || !existing.matcher) continue;
    // Check if matchers overlap (either is a substring/prefix of the other, or identical)
    const a = meta.matcher.toLowerCase();
    const b = existing.matcher.toLowerCase();
    if (a === b || a.includes(b) || b.includes(a)) {
      return `conflicts with '${existingName}' (same event ${meta.event}, overlapping matcher '${existing.matcher}')`;
    }
  }
  return undefined;
}

function installForTarget(name: string, scope: Scope, overwrite: boolean, target: "claude" | "gemini", profile?: string): InstallResult {
  const shortName = shortHookName(name);

  if (!hookExists(shortName)) {
    return { hook: shortName, success: false, error: `Hook '${shortName}' not found`, target };
  }

  const registered = getRegisteredHooksForTarget(scope, target);
  if (registered.includes(shortName) && !overwrite) {
    return { hook: shortName, success: false, error: "Already installed. Use --overwrite to replace.", scope, target };
  }

  // Warn on conflicts (non-blocking — still installs)
  const conflict = detectConflict(shortName, scope, target);

  try {
    registerHook(shortName, scope, target, profile);
    return { hook: shortName, success: true, scope, target, ...(conflict ? { conflict } : {}) };
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
  const { scope = "global", overwrite = false, target = "claude", profile } = options;

  if (target === "all") {
    const shortName = shortHookName(name);
    const meta = getHook(shortName);
    if (meta) {
      const unsupportedTargets = (["claude", "gemini"] as const).filter(
        (agentTarget) => !isEventSupported(meta.event, agentTarget)
      );
      if (unsupportedTargets.length > 0) {
        return {
          hook: shortName,
          success: false,
          error: `Event '${meta.event}' is not supported by target(s): ${unsupportedTargets.join(", ")}`,
          target: "all",
        };
      }
    }

    const claudeResult = installForTarget(name, scope, overwrite, "claude", profile);
    if (!claudeResult.success) {
      return {
        ...claudeResult,
        error: `Failed for target 'claude': ${claudeResult.error}`,
        target: "all",
      };
    }
    const geminiResult = installForTarget(name, scope, overwrite, "gemini", profile);
    if (!geminiResult.success) {
      return {
        ...geminiResult,
        error: `Failed for target 'gemini': ${geminiResult.error}`,
        target: "all",
      };
    }
    return { ...claudeResult, target: "all" };
  }

  return installForTarget(name, scope, overwrite, target as "claude" | "gemini", profile);
}

function registerHook(name: string, scope: Scope = "global", target: "claude" | "gemini" = "claude", profile?: string): void {
  const meta = getHook(name);
  if (!meta) return;

  const eventKey = getTargetEventName(meta.event, target);
  if (eventKey === null) {
    throw new Error(`Event '${meta.event}' is not supported by target '${target}'`);
  }

  const settings = readSettings(scope, target);
  if (!settings.hooks) settings.hooks = {};

  // Remove any existing entries for this hook from ALL event keys —
  // a hook may have been rebound to a different event since it was installed
  // (e.g. announce-start moved from Notification to SessionStart).
  removeHookFromAllEvents(settings, name);

  if (!settings.hooks[eventKey]) settings.hooks[eventKey] = [];

  const hookCommand = profile
    ? `hooks run ${name} --profile ${profile}`
    : `hooks run ${name}`;

  const entry: Record<string, any> = {
    hooks: [{ type: "command", command: hookCommand }],
  };
  if (meta.matcher) {
    entry.matcher = meta.matcher;
  }

  settings.hooks[eventKey].push(entry);
  writeSettings(settings, scope, target);
}

/** Strip a hook's entries from every event key, deleting keys that become empty */
function removeHookFromAllEvents(settings: Record<string, any>, name: string): void {
  if (!settings.hooks) return;
  for (const key of Object.keys(settings.hooks)) {
    settings.hooks[key] = removeHookEntriesByName(settings.hooks[key], name);
    if (settings.hooks[key].length === 0) {
      delete settings.hooks[key];
    }
  }
}

function unregisterHook(name: string, scope: Scope = "global", target: "claude" | "gemini" = "claude"): void {
  const meta = getHook(name);
  if (!meta) return;

  const settings = readSettings(scope, target);
  if (!settings.hooks) return;

  // Remove by hook name across all event keys — works regardless of profile
  // and regardless of which event the hook was bound to when installed.
  removeHookFromAllEvents(settings, name);

  if (Object.keys(settings.hooks).length === 0) {
    delete settings.hooks;
  }

  writeSettings(settings, scope, target);
}

export function installHooks(names: string[], options: InstallOptions = {}): InstallResult[] {
  return names.map((name) => installHook(name, options));
}

export function getRegisteredHooksForTarget(scope: Scope = "global", target: "claude" | "gemini" = "claude"): string[] {
  const settings = readSettings(scope, target);
  if (!settings.hooks) return [];

  const registered: string[] = [];
  for (const eventKey of Object.keys(settings.hooks)) {
    for (const entry of settings.hooks[eventKey]) {
      for (const hook of entry.hooks || []) {
        const newMatch = hook.command?.match(/^hooks run ([\w-]+)(?:\s+--profile\s+[\w-]+)?$/);
        const oldMatch = hook.command?.match(/^hook-([\w-]+)$/);
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

/** @deprecated Use getRegisteredHooks instead */
export const getInstalledHooks = getRegisteredHooks;

export function removeHook(name: string, scope: Scope = "global", target: Target = "claude"): boolean {
  const shortName = shortHookName(name);

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
