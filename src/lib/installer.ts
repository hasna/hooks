/**
 * Hook installer - registers hooks in Claude settings
 *
 * Hooks run directly from the globally installed @hasna/hooks package.
 * No files are copied. The settings.json entry points to `hooks run <name>`.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { join, dirname } from "path";
import { homedir } from "os";
import { fileURLToPath } from "url";
import { getHook } from "./registry.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
// Resolve hooks dir: works both in dev (src/lib/) and bundled (bin/)
const HOOKS_DIR = existsSync(join(__dirname, "..", "..", "hooks", "hook-gitguard"))
  ? join(__dirname, "..", "..", "hooks")
  : join(__dirname, "..", "hooks");

export type Scope = "global" | "project";

export interface InstallResult {
  hook: string;
  success: boolean;
  error?: string;
  scope?: Scope;
}

export interface InstallOptions {
  scope?: Scope;
  overwrite?: boolean;
}

/**
 * Get the settings.json path for a scope
 */
export function getSettingsPath(scope: Scope = "global"): string {
  if (scope === "project") {
    return join(process.cwd(), ".claude", "settings.json");
  }
  return join(homedir(), ".claude", "settings.json");
}

/**
 * Get the path to a hook's source in the package
 */
export function getHookPath(name: string): string {
  const hookName = name.startsWith("hook-") ? name : `hook-${name}`;
  return join(HOOKS_DIR, hookName);
}

/**
 * Check if a hook exists in the package
 */
export function hookExists(name: string): boolean {
  return existsSync(getHookPath(name));
}

/**
 * Read Claude settings.json for a given scope
 */
function readSettings(scope: Scope = "global"): Record<string, any> {
  const path = getSettingsPath(scope);
  try {
    if (existsSync(path)) {
      return JSON.parse(readFileSync(path, "utf-8"));
    }
  } catch {}
  return {};
}

/**
 * Write Claude settings.json for a given scope
 */
function writeSettings(settings: Record<string, any>, scope: Scope = "global"): void {
  const path = getSettingsPath(scope);
  const dir = dirname(path);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  writeFileSync(path, JSON.stringify(settings, null, 2) + "\n");
}

/**
 * Install a hook by registering it in settings.json
 * No files are copied — hooks run from the global @hasna/hooks package.
 */
export function installHook(
  name: string,
  options: InstallOptions = {}
): InstallResult {
  const { scope = "global", overwrite = false } = options;
  const hookName = name.startsWith("hook-") ? name : `hook-${name}`;
  const shortName = hookName.replace("hook-", "");

  // Check hook exists in package
  if (!hookExists(shortName)) {
    return { hook: shortName, success: false, error: `Hook '${shortName}' not found` };
  }

  // Check if already registered
  const registered = getRegisteredHooks(scope);
  if (registered.includes(shortName) && !overwrite) {
    return { hook: shortName, success: false, error: "Already installed. Use --overwrite to replace.", scope };
  }

  try {
    registerHook(shortName, scope);
    return { hook: shortName, success: true, scope };
  } catch (error) {
    return {
      hook: shortName,
      success: false,
      error: error instanceof Error ? error.message : "Unknown error",
    };
  }
}

/**
 * Register a hook in settings.json
 */
function registerHook(name: string, scope: Scope = "global"): void {
  const meta = getHook(name);
  if (!meta) return;

  const settings = readSettings(scope);
  if (!settings.hooks) settings.hooks = {};

  const eventKey = meta.event;
  if (!settings.hooks[eventKey]) settings.hooks[eventKey] = [];

  const hookCommand = `hooks run ${name}`;

  // Remove existing entry if present (for overwrite/update)
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
  writeSettings(settings, scope);
}

/**
 * Unregister a hook from settings.json
 */
function unregisterHook(name: string, scope: Scope = "global"): void {
  const meta = getHook(name);
  if (!meta) return;

  const settings = readSettings(scope);
  if (!settings.hooks) return;

  const eventKey = meta.event;
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

  writeSettings(settings, scope);
}

/**
 * Install multiple hooks
 */
export function installHooks(
  names: string[],
  options: InstallOptions = {}
): InstallResult[] {
  return names.map((name) => installHook(name, options));
}

/**
 * Get hooks registered in settings.json for a given scope
 */
export function getRegisteredHooks(scope: Scope = "global"): string[] {
  const settings = readSettings(scope);
  if (!settings.hooks) return [];

  const registered: string[] = [];
  for (const eventKey of Object.keys(settings.hooks)) {
    for (const entry of settings.hooks[eventKey]) {
      for (const hook of entry.hooks || []) {
        // Match both old format (hook-<name>) and new format (hooks run <name>)
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

/**
 * Alias: get installed hooks = get registered hooks
 */
export function getInstalledHooks(scope: Scope = "global"): string[] {
  return getRegisteredHooks(scope);
}

/**
 * Remove (unregister) a hook
 */
export function removeHook(name: string, scope: Scope = "global"): boolean {
  const hookName = name.startsWith("hook-") ? name : `hook-${name}`;
  const shortName = hookName.replace("hook-", "");

  const registered = getRegisteredHooks(scope);
  if (!registered.includes(shortName)) {
    return false;
  }

  unregisterHook(shortName, scope);
  return true;
}
