/**
 * @hasna/hooks - Open source Claude Code hooks library
 *
 * Install hooks with a single command:
 *   npx @hasna/hooks install gitguard branchprotect
 *
 * Or use the interactive CLI:
 *   npx @hasna/hooks
 */

export {
  HOOKS,
  HOOK_EVENTS,
  CATEGORIES,
  getHook,
  getHookEvents,
  getHooksByCategory,
  searchHooks,
  resolveHookNetworkAccess,
  type HookMeta,
  type HookEvent,
  type Category,
} from "./lib/registry.js";
import type { HookEvent as HookEventType } from "./lib/registry.js";

export {
  installHook,
  installHooks,
  getInstalledHooks,
  getRegisteredHooks,
  getRegisteredHooksForTarget,
  removeHook,
  hookExists,
  buildCodewithTomlFragment,
  getHookPath,
  getSettingsPath,
  isEventSupported,
  type InstallResult,
  type InstallOptions,
  type Scope,
  type ConcreteTarget,
  type Target,
  type CodewithInstallMode,
} from "./lib/installer.js";

// ── Hook runtime types ────────────────────────────────────────────────────────

export interface HookAgentInfo {
  agent_id: string;
  agent_type: "claude" | "gemini" | "codewith" | "custom";
  name?: string;
  preferences?: Record<string, unknown>;
}

/** The JSON object passed to a hook via stdin */
export interface HookInput {
  session_id?: string;
  cwd?: string;
  hook_event_name?: HookEventType | string;
  prompt?: string;
  tool_name?: string;
  tool_input?: Record<string, unknown>;
  agent?: HookAgentInfo;
  dry_run?: boolean;
  [key: string]: unknown;
}

/** The JSON object a PreToolUse hook returns via stdout */
export interface HookOutput {
  decision?: "approve" | "block";
  reason?: string;
  continue?: boolean;
  hookSpecificOutput?: {
    hookEventName: "SessionStart" | "UserPromptSubmit" | "SubagentStart" | "PreToolUse" | "PostToolUse" | "Stop" | "Notification" | "SessionEnd";
    additionalContext?: string;
    permissionDecision?: "allow" | "deny" | "ask";
    permissionDecisionReason?: string;
    updatedInput?: unknown;
  };
  [key: string]: unknown;
}

// ── Project-scoped SDK helpers ────────────────────────────────────────────────

import { installHook as _installHook, installHooks as _installHooks, removeHook as _removeHook, getRegisteredHooks as _getRegisteredHooks } from "./lib/installer.js";
import type { InstallOptions, InstallResult } from "./lib/installer.js";

/** Install a hook scoped to the current project (.claude/settings.json) */
export function installHookForProject(name: string, options: Omit<InstallOptions, "scope"> = {}): InstallResult {
  return _installHook(name, { ...options, scope: "project" });
}

/** Install multiple hooks scoped to the current project */
export function installHooksForProject(names: string[], options: Omit<InstallOptions, "scope"> = {}): InstallResult[] {
  return _installHooks(names, { ...options, scope: "project" });
}

/** List all hooks registered for the current project */
export function listProjectHooks(): string[] {
  return _getRegisteredHooks("project");
}

/** Remove a hook from the current project */
export function removeProjectHook(name: string): boolean {
  return _removeHook(name, "project");
}

// ── runHook — programmatic hook execution ─────────────────────────────────────

import { getHook as _getHook } from "./lib/registry.js";
import { resolveHookNetworkAccess as _resolveHookNetworkAccess } from "./lib/registry.js";
import { getHookPath as _getHookPath, hookExists as _hookExists } from "./lib/installer.js";
import { join } from "path";
import { existsSync } from "fs";
import { runBoundedProcess, type HookNetworkAccess } from "../hooks/bounded-process.js";

export interface RunHookOptions {
  /** Agent profile ID to inject into hook input */
  profile?: string;
  /** Timeout in milliseconds (default: 10000) */
  timeout?: number;
  /** Propagate a no-write dry-run marker. Unsupported hooks are rejected. */
  dryRun?: boolean;
  /** Further restrict an allow-declared hook. A deny-declared hook cannot be elevated. */
  network?: HookNetworkAccess;
  /** Source environment; only the runner's strict allowlist is forwarded. */
  env?: NodeJS.ProcessEnv;
  /** Additional explicit environment names to forward, excluding unsafe loaders. */
  envAllowlist?: readonly string[];
  maxInputBytes?: number;
  maxStdoutBytes?: number;
  maxStderrBytes?: number;
}

export interface RunHookResult {
  output: HookOutput;
  stderr: string;
  exitCode: number;
  timedOut: boolean;
  error: string | null;
}

/**
 * Programmatically execute a hook with the given input.
 * Spawns the hook's src/hook.ts via bun, passes input as stdin JSON,
 * and returns the parsed stdout JSON.
 */
export async function runHook(name: string, input: HookInput, options: RunHookOptions = {}): Promise<RunHookResult> {
  const meta = _getHook(name);
  if (!meta) throw new Error(`Hook '${name}' not found`);

  const dryRun = options.dryRun === true || input.dry_run === true;
  if (dryRun && meta.dryRun !== true) {
    throw new Error(`Hook '${name}' does not declare native dry-run support`);
  }

  const hookDir = _getHookPath(name);
  const hookScript = join(hookDir, "src", "hook.ts");
  if (!existsSync(hookScript)) throw new Error(`Hook script not found: ${hookScript}`);

  let hookInput: HookInput = { ...input, ...(dryRun ? { dry_run: true } : {}) };
  if (options.profile) {
    const { getProfile } = await import("./lib/profiles.js");
    const profile = getProfile(options.profile);
    if (profile) {
      hookInput.agent = {
        agent_id: profile.agent_id,
        agent_type: profile.agent_type,
        name: profile.name,
        preferences: profile.preferences,
      };
    }
  }

  const result = await runBoundedProcess([process.execPath, "run", hookScript], {
    input: JSON.stringify(hookInput),
    timeoutMs: options.timeout,
    network: _resolveHookNetworkAccess(meta, options.network),
    env: options.env ?? process.env,
    envAllowlist: options.envAllowlist,
    maxInputBytes: options.maxInputBytes,
    maxStdoutBytes: options.maxStdoutBytes,
    maxStderrBytes: options.maxStderrBytes,
  });

  let output: HookOutput = {};
  try {
    output = JSON.parse(result.stdout);
  } catch {
    output = { raw: result.stdout } as HookOutput;
  }

  return {
    output,
    stderr: result.stderr,
    exitCode: result.error ? 1 : (result.exitCode ?? 1),
    timedOut: result.timedOut,
    error: result.error,
  };
}

export {
  createProfile,
  getProfile,
  listProfiles,
  updateProfile,
  deleteProfile,
  touchProfile,
  getProfilesDir,
  exportProfiles,
  importProfiles,
  type AgentProfile,
  type CreateProfileInput,
} from "./lib/profiles.js";

export {
  HOOKS_STORAGE_ENV,
  HOOKS_STORAGE_FALLBACK_ENV,
  HOOKS_STORAGE_MODE_ENV,
  HOOKS_STORAGE_MODE_FALLBACK_ENV,
  HOOKS_STORAGE_TABLES,
  STORAGE_DATABASE_ENV,
  STORAGE_MODE_ENV,
  STORAGE_TABLES,
  getStorageDatabaseEnv,
  getStorageDatabaseEnvName,
  getStorageDatabaseUrl,
  getStorageMode,
  getStoragePg,
  getStorageStatus,
  getSyncMetaAll,
  parseStorageTables,
  resolveTables,
  runStorageMigrations,
  storagePull,
  storagePush,
  storageSync,
} from "./storage.js";
export type { StorageEnv, StorageMode, StorageStatus, SyncMeta, SyncResult } from "./storage.js";
