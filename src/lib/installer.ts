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
import type { HookEvent } from "./registry.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const HOOKS_DIR = existsSync(join(__dirname, "..", "..", "hooks", "hook-gitguard"))
  ? join(__dirname, "..", "..", "hooks")
  : join(__dirname, "..", "hooks");

export type Scope = "global" | "project";
export type Target = "claude" | "gemini" | "codewith" | "all";
type WritableJsonTarget = "claude" | "gemini";
type SingleTarget = Exclude<Target, "all">;
export type CodewithInstallMode = "fragment" | "write";

function normalizeHookName(name: string): string {
  return name.startsWith("hook-") ? name : `hook-${name}`;
}

function shortHookName(name: string): string {
  return name.startsWith("hook-") ? name.slice("hook-".length) : name;
}

function removeHookEntriesByName(entries: any[], hookName: string): any[] {
  return entries.filter(
    (entry: any) => !entry.hooks?.some((h: any) => {
      const match = h.command?.match(/^hooks run ([\w-]+)/);
      return match && match[1] === hookName;
    })
  );
}

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
  codewith: {
    SessionStart: "SessionStart",
    UserPromptSubmit: "UserPromptSubmit",
    PreToolUse: "PreToolUse",
    PostToolUse: "PostToolUse",
    Stop: "Stop",
  },
};

/** Settings file paths per target */
function getTargetSettingsDir(target: SingleTarget): string {
  if (target === "codewith") return ".codewith";
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
  fragment?: string;
  applied?: boolean;
  note?: string;
  configPath?: string;
}

export interface InstallOptions {
  scope?: Scope;
  overwrite?: boolean;
  target?: Target;
  profile?: string;
  /**
   * Codewith installs default to "fragment" so @hasna/hooks does not blindly
   * mutate managed ~/.codewith/config.toml. Use "write" only with an explicit
   * config path or in tests/local experiments.
   */
  codewithMode?: CodewithInstallMode;
  /** Explicit Codewith config path for the direct-write mode and tests. */
  codewithConfigPath?: string;
}

export function getSettingsPath(scope: Scope = "global", target: SingleTarget = "claude", codewithConfigPath?: string): string {
  if (target === "codewith" && codewithConfigPath) return codewithConfigPath;
  if (target === "codewith" && process.env.HASNA_HOOKS_CODEWITH_CONFIG_PATH) {
    return process.env.HASNA_HOOKS_CODEWITH_CONFIG_PATH;
  }
  const dir = getTargetSettingsDir(target);
  if (scope === "project") {
    return target === "codewith" ? join(process.cwd(), dir, "config.toml") : join(process.cwd(), dir, "settings.json");
  }
  return target === "codewith" ? join(homedir(), dir, "config.toml") : join(homedir(), dir, "settings.json");
}

export function getHookPath(name: string): string {
  const shortName = shortHookName(name);
  const direct = join(HOOKS_DIR, shortName);
  if (existsSync(direct)) return direct;
  return join(HOOKS_DIR, normalizeHookName(shortName));
}

export function hookExists(name: string): boolean {
  return existsSync(getHookPath(name));
}

function readSettings(scope: Scope = "global", target: WritableJsonTarget = "claude"): Record<string, any> {
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

function writeSettings(settings: Record<string, any>, scope: Scope = "global", target: WritableJsonTarget = "claude"): void {
  const path = getSettingsPath(scope, target);
  const dir = dirname(path);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  writeFileSync(path, JSON.stringify(settings, null, 2) + "\n");
}

function getTargetEventName(internalEvent: HookEvent, target: SingleTarget): string | undefined {
  return EVENT_MAP[target]?.[internalEvent];
}

function tomlString(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function codewithMatcher(matcher: string): string | undefined {
  if (!matcher) return undefined;
  if (matcher.startsWith("^")) return matcher;
  if (matcher.includes("|")) return `^(${matcher})$`;
  return `^${matcher}$`;
}

function codewithTimeout(name: string): number {
  switch (name) {
    case "session-start":
      return 8;
    case "pre-bash":
      return 20;
    case "prompt-guard":
      return 3;
    case "worktree-guard":
    case "stop-sync":
      return 5;
    default:
      return 10;
  }
}

function codewithStatusMessage(name: string): string {
  switch (name) {
    case "session-start":
      return "Checking Hasna session context";
    case "pre-bash":
      return "Checking Bash safety";
    case "prompt-guard":
      return "Checking prompt safety";
    case "worktree-guard":
      return "Checking worktree safety";
    case "stop-sync":
      return "Syncing turn-end heartbeat";
    default:
      return `Running ${name}`;
  }
}

export function buildCodewithTomlFragment(name: string, profile?: string): string {
  const shortName = shortHookName(name);
  const meta = getHook(shortName);
  if (!meta) throw new Error(`Hook '${shortName}' not found`);
  const eventKey = getTargetEventName(meta.event, "codewith");
  if (!eventKey) {
    throw new Error(`Hook '${shortName}' uses event '${meta.event}', which is not supported by the Codewith target`);
  }

  const command = profile ? `hooks run ${shortName} --profile ${profile}` : `hooks run ${shortName}`;
  const matcher = codewithMatcher(meta.matcher);
  const lines: string[] = [
    `[[hooks.${eventKey}]]`,
  ];
  if (matcher) lines.push(`matcher = ${tomlString(matcher)}`);
  lines.push(
    "",
    `[[hooks.${eventKey}.hooks]]`,
    `type = "command"`,
    `command = ${tomlString(command)}`,
    `timeout = ${codewithTimeout(shortName)}`,
    `statusMessage = ${tomlString(codewithStatusMessage(shortName))}`,
  );
  return `${lines.join("\n")}\n`;
}

function readCodewithConfig(scope: Scope, configPath?: string): string {
  const path = getSettingsPath(scope, "codewith", configPath);
  try {
    return existsSync(path) ? readFileSync(path, "utf-8") : "";
  } catch {
    return "";
  }
}

function appendCodewithFragment(fragment: string, scope: Scope, configPath?: string): string {
  const path = getSettingsPath(scope, "codewith", configPath);
  const dir = dirname(path);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const existing = existsSync(path) ? readFileSync(path, "utf-8") : "";
  const sep = existing.trim() ? "\n\n" : "";
  writeFileSync(path, `${existing.replace(/\s*$/, "")}${sep}${fragment}`);
  return path;
}

/** Check if a hook conflicts with any already-installed hook (same event + overlapping matcher) */
function detectConflict(name: string, scope: Scope, target: SingleTarget): string | undefined {
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

function installForTarget(
  name: string,
  scope: Scope,
  overwrite: boolean,
  target: SingleTarget,
  profile?: string,
  codewithMode: CodewithInstallMode = "fragment",
  codewithConfigPath?: string,
): InstallResult {
  const shortName = shortHookName(name);

  if (!hookExists(shortName)) {
    return { hook: shortName, success: false, error: `Hook '${shortName}' not found`, target };
  }

  if (target === "codewith") {
    try {
      const fragment = buildCodewithTomlFragment(shortName, profile);
      if (codewithMode !== "write") {
        return {
          hook: shortName,
          success: true,
          scope,
          target,
          fragment,
          applied: false,
          note: "Codewith install is fragment-only by default; open-configs should own applying this TOML.",
        };
      }

      const existing = readCodewithConfig(scope, codewithConfigPath);
      if (!overwrite && new RegExp(`command\\s*=\\s*["']hooks run ${shortName}(?:\\s|["'])`).test(existing)) {
        return { hook: shortName, success: false, error: "Already installed. Use --overwrite to append another fragment.", scope, target };
      }
      const path = appendCodewithFragment(fragment, scope, codewithConfigPath);
      return {
        hook: shortName,
        success: true,
        scope,
        target,
        fragment,
        applied: true,
        configPath: path,
        note: "Direct Codewith config write was explicitly requested; prefer open-configs for managed machines.",
      };
    } catch (error) {
      return {
        hook: shortName,
        success: false,
        error: error instanceof Error ? error.message : "Unknown error",
        target,
      };
    }
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
  const { scope = "global", overwrite = false, target = "claude", profile, codewithMode = "fragment", codewithConfigPath } = options;

  if (target === "all") {
    const claudeResult = installForTarget(name, scope, overwrite, "claude", profile);
    installForTarget(name, scope, overwrite, "gemini", profile);
    installForTarget(name, scope, overwrite, "codewith", profile, codewithMode, codewithConfigPath);
    return { ...claudeResult, target: "all" };
  }

  return installForTarget(name, scope, overwrite, target as SingleTarget, profile, codewithMode, codewithConfigPath);
}

function registerHook(name: string, scope: Scope = "global", target: WritableJsonTarget = "claude", profile?: string): void {
  const meta = getHook(name);
  if (!meta) return;

  const settings = readSettings(scope, target);
  if (!settings.hooks) settings.hooks = {};

  const eventKey = getTargetEventName(meta.event, target);
  if (!eventKey) throw new Error(`Event '${meta.event}' is not supported by target '${target}'`);
  if (!settings.hooks[eventKey]) settings.hooks[eventKey] = [];

  // Remove any existing entries for this hook (with or without profile)
  settings.hooks[eventKey] = removeHookEntriesByName(settings.hooks[eventKey], name);

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

function unregisterHook(name: string, scope: Scope = "global", target: WritableJsonTarget = "claude"): void {
  const meta = getHook(name);
  if (!meta) return;

  const settings = readSettings(scope, target);
  if (!settings.hooks) return;

  const eventKey = getTargetEventName(meta.event, target);
  if (!eventKey) return;
  if (!settings.hooks[eventKey]) return;

  // Remove by hook name — works regardless of whether profile was used
  settings.hooks[eventKey] = removeHookEntriesByName(settings.hooks[eventKey], name);

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

export function getRegisteredHooksForTarget(scope: Scope = "global", target: SingleTarget = "claude"): string[] {
  if (target === "codewith") {
    const config = readCodewithConfig(scope);
    const registered: string[] = [];
    const re = /command\s*=\s*["']hooks run ([\w-]+)(?:\s+--profile\s+[\w-]+)?["']/g;
    let match: RegExpExecArray | null;
    while ((match = re.exec(config))) {
      registered.push(match[1]);
    }
    return [...new Set(registered)];
  }

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

  if (target === "codewith") {
    // Codewith config is TOML and usually managed by open-configs. Avoid
    // attempting lossy TOML edits here; emit fragments for install instead.
    return false;
  }

  return removeHookForTarget(shortName, scope, target as WritableJsonTarget);
}

function removeHookForTarget(name: string, scope: Scope, target: WritableJsonTarget): boolean {
  const registered = getRegisteredHooksForTarget(scope, target);
  if (!registered.includes(name)) {
    return false;
  }
  unregisterHook(name, scope, target);
  return true;
}
