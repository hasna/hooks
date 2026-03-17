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
  CATEGORIES,
  getHook,
  getHooksByCategory,
  searchHooks,
  type HookMeta,
  type Category,
} from "./lib/registry.js";

export {
  installHook,
  installHooks,
  getInstalledHooks,
  getRegisteredHooks,
  getRegisteredHooksForTarget,
  removeHook,
  hookExists,
  getHookPath,
  getSettingsPath,
  type InstallResult,
  type InstallOptions,
  type Scope,
  type Target,
} from "./lib/installer.js";

// ── Hook runtime types ────────────────────────────────────────────────────────

export interface HookAgentInfo {
  agent_id: string;
  agent_type: "claude" | "gemini" | "custom";
  name?: string;
  preferences?: Record<string, unknown>;
}

/** The JSON object passed to a hook via stdin */
export interface HookInput {
  session_id?: string;
  cwd?: string;
  tool_name?: string;
  tool_input?: Record<string, unknown>;
  agent?: HookAgentInfo;
  [key: string]: unknown;
}

/** The JSON object a PreToolUse hook returns via stdout */
export interface HookOutput {
  decision?: "approve" | "block";
  reason?: string;
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
import { getHookPath as _getHookPath, hookExists as _hookExists } from "./lib/installer.js";
import { join } from "path";
import { existsSync } from "fs";

export interface RunHookOptions {
  /** Agent profile ID to inject into hook input */
  profile?: string;
  /** Timeout in milliseconds (default: 10000) */
  timeout?: number;
}

export interface RunHookResult {
  output: HookOutput;
  stderr: string;
  exitCode: number;
}

/**
 * Programmatically execute a hook with the given input.
 * Spawns the hook's src/hook.ts via bun, passes input as stdin JSON,
 * and returns the parsed stdout JSON.
 */
export async function runHook(name: string, input: HookInput, options: RunHookOptions = {}): Promise<RunHookResult> {
  const meta = _getHook(name);
  if (!meta) throw new Error(`Hook '${name}' not found`);

  const hookDir = _getHookPath(name);
  const hookScript = join(hookDir, "src", "hook.ts");
  if (!existsSync(hookScript)) throw new Error(`Hook script not found: ${hookScript}`);

  let hookInput = { ...input };
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

  const proc = Bun.spawn(["bun", "run", hookScript], {
    stdin: new Response(JSON.stringify(hookInput)),
    stdout: "pipe",
    stderr: "pipe",
    env: process.env,
  });

  const [stdoutText, stderrText, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);

  let output: HookOutput = {};
  try {
    output = JSON.parse(stdoutText);
  } catch {
    output = { raw: stdoutText } as HookOutput;
  }

  return { output, stderr: stderrText, exitCode };
}

export {
  createProfile,
  getProfile,
  listProfiles,
  updateProfile,
  deleteProfile,
  touchProfile,
  getProfilesDir,
  type AgentProfile,
  type CreateProfileInput,
} from "./lib/profiles.js";
