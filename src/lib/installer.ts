/**
 * Hook installer - registers hooks in AI coding agent settings
 *
 * Supports:
 * - Claude Code: ~/.claude/settings.json (PreToolUse, PostToolUse, Stop, Notification, SessionStart, SessionEnd)
 * - Gemini CLI: ~/.gemini/settings.json (BeforeTool, AfterTool, AfterAgent, Notification — no session events)
 * - Codewith: emits TOML fragments by default; direct writes require explicit opt-in
 *
 * Hooks run directly from the globally installed @hasna/hooks package.
 * No files are copied. The settings entry points to `hooks run <name>`.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { join, dirname } from "path";
import { homedir } from "os";
import { fileURLToPath } from "url";
import { getHook, getHookEvents, type HookEvent } from "./registry.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const HOOKS_DIR = existsSync(join(__dirname, "..", "..", "hooks", "hook-gitguard"))
  ? join(__dirname, "..", "..", "hooks")
  : join(__dirname, "..", "hooks");

export type Scope = "global" | "project";
export type Target = "claude" | "gemini" | "codewith" | "all";
type WritableJsonTarget = "claude" | "gemini";
type SingleTarget = Exclude<Target, "all">;
export type ConcreteTarget = SingleTarget;
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
const EVENT_MAP: Record<SingleTarget, Record<HookEvent, string | null>> = {
  claude: {
    PreToolUse: "PreToolUse",
    PostToolUse: "PostToolUse",
    Stop: "Stop",
    Notification: "Notification",
    SessionStart: "SessionStart",
    SessionEnd: "SessionEnd",
    UserPromptSubmit: null,
    SubagentStart: null,
  },
  gemini: {
    PreToolUse: "BeforeTool",
    PostToolUse: "AfterTool",
    Stop: "AfterAgent",
    Notification: "Notification",
    SessionStart: null,
    SessionEnd: null,
    UserPromptSubmit: null,
    SubagentStart: null,
  },
  codewith: {
    PreToolUse: "PreToolUse",
    PostToolUse: "PostToolUse",
    Stop: "Stop",
    Notification: null,
    SessionStart: "SessionStart",
    SessionEnd: null,
    UserPromptSubmit: "UserPromptSubmit",
    SubagentStart: "SubagentStart",
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

function getTargetEventName(internalEvent: HookEvent, target: SingleTarget): string | null {
  return EVENT_MAP[target]?.[internalEvent] ?? null;
}

/** Whether a hook's event can be registered for the given target */
export function isEventSupported(internalEvent: HookEvent, target: SingleTarget): boolean {
  return getTargetEventName(internalEvent, target) !== null;
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
    case "knowledge-context":
      return 2;
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
    case "knowledge-context":
      return "Loading Knowledge context";
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

  const command = profile ? `hooks run ${shortName} --profile ${profile}` : `hooks run ${shortName}`;
  const matcher = codewithMatcher(meta.matcher);
  const fragments: string[] = [];

  for (const event of getHookEvents(meta)) {
    const eventKey = getTargetEventName(event, "codewith");
    if (!eventKey) {
      throw new Error(`Hook '${shortName}' uses event '${event}', which is not supported by the Codewith target`);
    }

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
    fragments.push(lines.join("\n"));
  }

  return `${fragments.join("\n\n")}\n`;
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
  const events = new Set(getHookEvents(meta));

  const registered = getRegisteredHooksForTarget(scope, target);
  for (const existingName of registered) {
    if (existingName === name) continue;
    const existing = getHook(existingName);
    if (!existing || !existing.matcher) continue;
    if (!getHookEvents(existing).some((event) => events.has(event))) continue;
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

      if (!codewithConfigPath) {
        return {
          hook: shortName,
          success: false,
          error: "Direct Codewith writes require an explicit --codewith-config path; refusing to write default ~/.codewith/config.toml.",
          scope,
          target,
          fragment,
          applied: false,
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
    const shortName = shortHookName(name);
    const meta = getHook(shortName);
    if (meta) {
      const unsupportedTargets = (["claude", "codewith"] as const).filter(
        (agentTarget) => getHookEvents(meta).some((event) => !isEventSupported(event, agentTarget))
      );
      if (unsupportedTargets.length > 0) {
        return {
          hook: shortName,
          success: false,
          error: `Event(s) '${getHookEvents(meta).join(", ")}' are not supported by target(s): ${unsupportedTargets.join(", ")}`,
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
    const codewithResult = installForTarget(name, scope, overwrite, "codewith", profile, codewithMode, codewithConfigPath);
    if (!codewithResult.success) {
      return {
        ...codewithResult,
        error: `Failed for target 'codewith': ${codewithResult.error}`,
        target: "all",
      };
    }
    return { ...claudeResult, target: "all" };
  }

  return installForTarget(name, scope, overwrite, target as SingleTarget, profile, codewithMode, codewithConfigPath);
}

function registerHook(name: string, scope: Scope = "global", target: WritableJsonTarget = "claude", profile?: string): void {
  const meta = getHook(name);
  if (!meta) return;

  const eventKeys = getHookEvents(meta).map((event) => {
    const eventKey = getTargetEventName(event, target);
    if (eventKey === null) {
      throw new Error(`Event '${event}' is not supported by target '${target}'`);
    }
    return eventKey;
  });
  const uniqueEventKeys = [...new Set(eventKeys)];
  if (uniqueEventKeys.length === 0) {
    throw new Error(`Hook '${name}' has no installable events for target '${target}'`);
  }

  const settings = readSettings(scope, target);
  if (!settings.hooks) settings.hooks = {};

  // Remove any existing entries for this hook from ALL event keys —
  // a hook may have been rebound to a different event since it was installed
  // (e.g. announce-start moved from Notification to SessionStart).
  removeHookFromAllEvents(settings, name);

  const hookCommand = profile
    ? `hooks run ${name} --profile ${profile}`
    : `hooks run ${name}`;

  for (const eventKey of uniqueEventKeys) {
    if (!settings.hooks[eventKey]) settings.hooks[eventKey] = [];

    const entry: Record<string, any> = {
      hooks: [{ type: "command", command: hookCommand }],
    };
    if (meta.matcher) {
      entry.matcher = meta.matcher;
    }
    settings.hooks[eventKey].push(entry);
  }
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

function unregisterHook(name: string, scope: Scope = "global", target: WritableJsonTarget = "claude"): void {
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
