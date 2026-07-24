/**
 * MCP server for @hasna/hooks
 *
 * Exposes hook management as MCP tools for AI agents.
 * Runs on port 39427 (SSE) or stdio transport.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { createServer } from "http";
import { existsSync, readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
let pkg = { name: "@hasna/hooks", version: "0.0.0" };
try {
  // Try multiple paths — bundled vs source layout differ
  for (const rel of ["../../package.json", "../package.json", "../../../package.json"]) {
    const p = join(__dirname, rel);
    if (existsSync(p)) { pkg = JSON.parse(readFileSync(p, "utf-8")); break; }
  }
} catch { /* use defaults */ }

import {
  HOOKS,
  CATEGORIES,
  getHooksByCategory,
  searchHooks,
  getHook,
  type Category,
  type HookMeta,
} from "../lib/registry.js";
import {
  installHook,
  installHooks,
  getInstalledHooks,
  getRegisteredHooks,
  removeHook,
  hookExists,
  getHookPath,
  getSettingsPath,
  type Scope,
  type InstallResult,
} from "../lib/installer.js";
import {
  createProfile,
  getProfile,
  listProfiles,
  type AgentProfile,
} from "../lib/profiles.js";
import {
  getStorageStatus,
  storagePull,
  storagePush,
  storageSync,
} from "../storage.js";

export const MCP_PORT = 39427;

function formatInstallResults(results: InstallResult[], extra?: Record<string, any>) {
  const installed = results.filter((r) => r.success).map((r) => r.hook);
  const failed = results.filter((r) => !r.success).map((r) => ({ hook: r.hook, error: r.error }));
  return {
    content: [{
      type: "text" as const,
      text: JSON.stringify({ installed, failed, total: results.length, success: installed.length, ...extra }),
    }],
  };
}

function truncateText(value: unknown, max = 160): string {
  const text = String(value ?? "").replace(/\s+/g, " ").trim();
  if (text.length <= max) return text;
  return `${text.slice(0, Math.max(0, max - 3))}...`;
}

function boundedLimit(value: number | undefined, fallback: number, max: number): number {
  if (!Number.isFinite(value) || !value || value <= 0) return fallback;
  return Math.min(Math.floor(value), max);
}

function compactHook(hook: HookMeta) {
  return {
    name: hook.name,
    event: hook.event,
    matcher: hook.matcher,
    category: hook.category,
  };
}

function compactHookResult(hooks: HookMeta[], limit: number, detail: string) {
  const visible = hooks.slice(0, limit).map(compactHook);
  const omitted = Math.max(0, hooks.length - visible.length);
  return {
    hooks: visible,
    count: visible.length,
    total: hooks.length,
    omitted,
    hint: omitted > 0
      ? `Use limit, compact:false, or ${detail} for more detail.`
      : `Use compact:false or ${detail} for full details.`,
  };
}

function compactEvent(row: any) {
  return {
    id: row.id,
    timestamp: row.timestamp,
    hook_name: row.hook_name,
    tool_name: row.tool_name ?? undefined,
    session_id: row.session_id ? String(row.session_id).slice(0, 12) : undefined,
    error: row.error ? truncateText(row.error, 180) : undefined,
    tool_input_preview: row.tool_input ? truncateText(row.tool_input, 180) : undefined,
  };
}

// --- in-memory agent registry ---
interface _HooksAgent { id: string; name: string; session_id?: string; last_seen_at: string; project_id?: string; }
const _hooksAgents = new Map<string, _HooksAgent>();

export function createHooksServer(): McpServer {
  const server = new McpServer({
    name: "@hasna/hooks",
    version: pkg.version,
  });
  const defineTool = (
    name: string,
    description: string,
    schema: Record<string, any>,
    handler: (params: any) => any,
  ) => (server.tool as any)(name, description, schema, handler);

  // --- Tools ---

  defineTool(
    "hooks_list",
    "List available hooks. Compact by default; pass compact:false for full HookMeta objects.",
    {
      category: z.string().optional().describe("Filter by category name (e.g. 'Git Safety', 'Code Quality', 'Security')"),
      compact: z.boolean().default(true).describe("Return compact summaries by default. Set false for full fields."),
      limit: z.number().default(25).describe("Max compact rows to return"),
    },
    async ({ category, compact, limit }) => {
      const maxRows = boundedLimit(limit, 25, 100);
      if (category) {
        const cat = CATEGORIES.find((c) => c.toLowerCase() === category.toLowerCase());
        if (!cat) {
          return { content: [{ type: "text", text: JSON.stringify({ error: `Unknown category: ${category}`, available: [...CATEGORIES] }) }] };
        }
        const hooks = getHooksByCategory(cat);
        return { content: [{ type: "text", text: JSON.stringify(compact ? compactHookResult(hooks, maxRows, "hooks_info") : hooks) }] };
      }
      const result: Record<string, any> = {};
      for (const cat of CATEGORIES) {
        result[cat] = getHooksByCategory(cat);
      }
      return { content: [{ type: "text", text: JSON.stringify(compact ? compactHookResult(HOOKS, maxRows, "hooks_info") : result) }] };
    }
  );

  defineTool(
    "hooks_search",
    "Search hooks. Compact by default; pass compact:false for full HookMeta objects.",
    {
      query: z.string().describe("Search query"),
      compact: z.boolean().default(true).describe("Return compact summaries by default. Set false for full fields."),
      limit: z.number().default(10).describe("Max compact rows to return"),
    },
    async ({ query, compact, limit }) => {
      const results = searchHooks(query);
      const out = compact ? compactHookResult(results, boundedLimit(limit, 10, 100), "hooks_info") : results;
      return { content: [{ type: "text", text: JSON.stringify(out) }] };
    }
  );

  defineTool(
    "hooks_info",
    "Get detailed information about a specific hook including install status",
    { name: z.string().describe("Hook name (e.g. 'gitguard', 'checkpoint')") },
    async ({ name }) => {
      const meta = getHook(name);
      if (!meta) {
        return { content: [{ type: "text", text: JSON.stringify({ error: `Hook '${name}' not found` }) }] };
      }
      const globalInstalled = getRegisteredHooks("global").includes(meta.name);
      const projectInstalled = getRegisteredHooks("project").includes(meta.name);
      return { content: [{ type: "text", text: JSON.stringify({ ...meta, global: globalInstalled, project: projectInstalled }) }] };
    }
  );

  defineTool(
    "hooks_install",
    "Install one or more hooks by registering them in agent settings",
    {
      hooks: z.array(z.string()).describe("Hook names to install"),
      scope: z.enum(["global", "project"]).default("global").describe("Install scope"),
      overwrite: z.boolean().default(false).describe("Overwrite if already installed"),
      profile: z.string().optional().describe("Agent profile ID to scope hooks to"),
    },
    async ({ hooks, scope, overwrite, profile }: { hooks: string[]; scope: Scope; overwrite: boolean; profile?: string }) => {
      const results = hooks.map((name) => installHook(name, { scope, overwrite, profile }));
      return formatInstallResults(results, { scope, profile });
    }
  );

  defineTool(
    "hooks_install_category",
    "Install all hooks in a category",
    {
      category: z.string().describe("Category name"),
      scope: z.enum(["global", "project"]).default("global").describe("Install scope"),
      overwrite: z.boolean().default(false).describe("Overwrite if already installed"),
    },
    async ({ category, scope, overwrite }) => {
      const cat = CATEGORIES.find((c) => c.toLowerCase() === category.toLowerCase());
      if (!cat) {
        return { content: [{ type: "text", text: JSON.stringify({ error: `Unknown category: ${category}`, available: [...CATEGORIES] }) }] };
      }
      const hooks = getHooksByCategory(cat).map((h) => h.name);
      const results = hooks.map((name) => installHook(name, { scope, overwrite }));
      return formatInstallResults(results, { category: cat, scope });
    }
  );

  defineTool(
    "hooks_install_all",
    "Install all available hooks",
    {
      scope: z.enum(["global", "project"]).default("global").describe("Install scope"),
      overwrite: z.boolean().default(false).describe("Overwrite if already installed"),
    },
    async ({ scope, overwrite }) => {
      const results = HOOKS.map((h) => installHook(h.name, { scope, overwrite }));
      return formatInstallResults(results, { scope });
    }
  );

  defineTool(
    "hooks_remove",
    "Remove (unregister) a hook from agent settings",
    {
      name: z.string().describe("Hook name to remove"),
      scope: z.enum(["global", "project"]).default("global").describe("Scope to remove from"),
    },
    async ({ name, scope }) => {
      const removed = removeHook(name, scope);
      return { content: [{ type: "text", text: JSON.stringify({ hook: name, removed, scope }) }] };
    }
  );

  defineTool(
    "hooks_doctor",
    "Check health of installed hooks — verifies hook source exists, settings are correct",
    {
      scope: z.enum(["global", "project"]).default("global").describe("Scope to check"),
    },
    async ({ scope }) => {
      const settingsPath = getSettingsPath(scope);
      const issues: { hook: string; issue: string; severity: string }[] = [];
      const healthy: string[] = [];

      const settingsExist = existsSync(settingsPath);
      if (!settingsExist) {
        issues.push({ hook: "(settings)", issue: `${settingsPath} not found`, severity: "warning" });
      }

      const registered = getRegisteredHooks(scope);
      for (const name of registered) {
        const meta = getHook(name);
        let hookHealthy = true;

        if (!hookExists(name)) {
          issues.push({ hook: name, issue: "Hook not found in @hasna/hooks package", severity: "error" });
          continue;
        }

        const hookDir = getHookPath(name);
        if (!existsSync(join(hookDir, "src", "hook.ts"))) {
          issues.push({ hook: name, issue: "Missing src/hook.ts in package", severity: "error" });
          hookHealthy = false;
        }

        if (meta && settingsExist) {
          try {
            const settings = JSON.parse(readFileSync(settingsPath, "utf-8"));
            const eventHooks = settings.hooks?.[meta.event] || [];
            const found = eventHooks.some((entry: any) =>
              entry.hooks?.some((h: any) => {
                const match = h.command?.match(/^hooks run ([\w-]+)/);
                return match && match[1] === name;
              })
            );
            if (!found) {
              issues.push({ hook: name, issue: `Not registered under correct event (${meta.event})`, severity: "error" });
              hookHealthy = false;
            }
          } catch {}
        }

        if (hookHealthy) healthy.push(name);
      }

      return { content: [{ type: "text", text: JSON.stringify({ healthy: issues.length === 0, healthy_hooks: healthy, issues, registered, scope }) }] };
    }
  );

  defineTool(
    "hooks_categories",
    "List all hook categories with counts",
    {},
    async () => {
      const result = CATEGORIES.map((cat) => ({
        name: cat,
        count: getHooksByCategory(cat).length,
      }));
      return { content: [{ type: "text", text: JSON.stringify(result) }] };
    }
  );

  defineTool(
    "hooks_docs",
    "Get documentation. Hook README content is summarized by default; pass verbose:true for the full README.",
    {
      name: z.string().optional().describe("Hook name for specific docs, omit for general docs"),
      verbose: z.boolean().default(false).describe("Return full hook README when true"),
    },
    async ({ name, verbose }) => {
      if (name) {
        const meta = getHook(name);
        if (!meta) {
          return { content: [{ type: "text", text: JSON.stringify({ error: `Hook '${name}' not found` }) }] };
        }
        const hookPath = getHookPath(name);
        const readmePath = join(hookPath, "README.md");
        let readme = "";
        if (existsSync(readmePath)) {
          readme = readFileSync(readmePath, "utf-8");
        }
        if (verbose) {
          return { content: [{ type: "text", text: JSON.stringify({ ...meta, readme }) }] };
        }
        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              ...compactHook(meta),
              displayName: meta.displayName,
              version: meta.version,
              description: truncateText(meta.description, 220),
              readme_preview: truncateText(readme, 500),
              readme_lines: readme ? readme.split("\n").length : 0,
              hint: "Call hooks_docs with verbose:true for the full README or hooks_info for metadata.",
            }),
          }],
        };
      }

      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            overview: "Hooks are scripts that run at specific points in an AI coding agent session. Install @hasna/hooks globally, then register hooks — no files are copied to your project.",
            events: {
              PreToolUse: "Fires before a tool executes. Can block the operation.",
              PostToolUse: "Fires after a tool executes. Runs asynchronously.",
              Stop: "Fires when the agent finishes responding. Useful for notifications.",
              Notification: "Fires on notification events like context compaction.",
              SessionStart: "Fires when a session starts or resumes. Can inject context.",
              SessionEnd: "Fires when a session terminates. Useful for cleanup and final announcements.",
            },
            commands: {
              install: "hooks install <name>",
              installProject: "hooks install <name> --project",
              installAll: "hooks install --all",
              remove: "hooks remove <name>",
              list: "hooks list",
              search: "hooks search <query>",
              doctor: "hooks doctor",
            },
          }),
        }],
      };
    }
  );

  defineTool(
    "hooks_registered",
    "Get currently registered hooks for a scope. Compact by default.",
    {
      scope: z.enum(["global", "project"]).default("global").describe("Scope to check"),
      compact: z.boolean().default(true).describe("Return compact summaries by default. Set false for descriptions."),
      limit: z.number().default(25).describe("Max compact rows to return"),
    },
    async ({ scope, compact, limit }) => {
      const registered = getRegisteredHooks(scope);
      const result = registered.map((name) => {
        const meta = getHook(name);
        return { name, event: meta?.event, matcher: meta?.matcher ?? "", version: meta?.version, description: meta?.description };
      });
      if (!compact) return { content: [{ type: "text", text: JSON.stringify(result) }] };
      const maxRows = boundedLimit(limit, 25, 100);
      const visible = result.slice(0, maxRows).map((hook) => ({
        name: hook.name,
        event: hook.event,
        matcher: hook.matcher,
        version: hook.version,
      }));
      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            hooks: visible,
            count: visible.length,
            total: result.length,
            omitted: Math.max(0, result.length - visible.length),
            hint: "Use compact:false for descriptions or hooks_info for one hook.",
          }),
        }],
      };
    }
  );

  defineTool(
    "hooks_run",
    "Execute a hook programmatically with the given input and return its output",
    {
      name: z.string().describe("Hook name (e.g. 'gitguard', 'checkpoint')"),
      input: z.record(z.string(), z.unknown()).default(() => ({})).describe("Hook input as JSON object (HookInput)"),
      profile: z.string().optional().describe("Agent profile ID to inject into hook input"),
      timeout_ms: z.number().default(10000).describe("Timeout in milliseconds (default: 10000)"),
    },
    async ({ name, input, profile, timeout_ms }) => {
      const meta = getHook(name);
      if (!meta) {
        return { content: [{ type: "text", text: JSON.stringify({ error: `Hook '${name}' not found` }) }] };
      }

      const hookDir = getHookPath(name);
      const hookScript = join(hookDir, "src", "hook.ts");
      if (!existsSync(hookScript)) {
        return { content: [{ type: "text", text: JSON.stringify({ error: `Hook script not found: ${hookScript}` }) }] };
      }

      let hookInput = { ...input };
      if (profile) {
        const p = getProfile(profile);
        if (p) {
          (hookInput as any).agent = {
            agent_id: p.agent_id,
            agent_type: p.agent_type,
            name: p.name,
            preferences: p.preferences,
          };
        }
      }

      const proc = Bun.spawn(["bun", "run", hookScript], {
        stdin: new Response(JSON.stringify(hookInput)),
        stdout: "pipe",
        stderr: "pipe",
        env: process.env,
      });

      const timeoutPromise = new Promise<null>((resolve) => setTimeout(() => resolve(null), timeout_ms));

      const result = await Promise.race([
        Promise.all([
          new Response(proc.stdout).text(),
          new Response(proc.stderr).text(),
          proc.exited,
        ]).then(([stdout, stderr, exitCode]) => ({ stdout, stderr, exitCode, timedOut: false })),
        timeoutPromise.then(() => { proc.kill(); return { stdout: "", stderr: "", exitCode: -1, timedOut: true }; }),
      ]);

      let output: unknown = {};
      try { output = JSON.parse(result.stdout); } catch { output = result.stdout ? { raw: result.stdout } : {}; }

      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({
            hook: name,
            output,
            stderr: result.stderr || undefined,
            exitCode: result.exitCode,
            ...(result.timedOut ? { timedOut: true, timeout_ms } : {}),
          }),
        }],
      };
    }
  );

  defineTool(
    "hooks_update",
    "Re-register installed hooks to pick up new package version (reinstalls with overwrite)",
    {
      hooks: z.array(z.string()).optional().describe("Hook names to update (omit to update all installed hooks)"),
      scope: z.enum(["global", "project"]).default("global").describe("Scope to update"),
    },
    async ({ hooks, scope }: { hooks?: string[]; scope: Scope }) => {
      const installed = getRegisteredHooks(scope);
      const toUpdate = hooks && hooks.length > 0 ? hooks : installed;

      if (toUpdate.length === 0) {
        return { content: [{ type: "text", text: JSON.stringify({ updated: [], error: "No hooks installed" }) }] };
      }

      const results = toUpdate.map((name) => {
        if (!installed.includes(name)) {
          return { hook: name, success: false, error: "Not installed" };
        }
        return installHook(name, { scope, overwrite: true });
      });

      const updated = results.filter((r) => r.success).map((r) => r.hook);
      const failed = results.filter((r) => !r.success).map((r) => ({ hook: r.hook, error: r.error }));
      return { content: [{ type: "text", text: JSON.stringify({ updated, failed, total: results.length }) }] };
    }
  );

  defineTool(
    "hooks_context",
    "Get compact agent context in one call: installed hooks, active profile summary, settings path, and doctor status.",
    {
      scope: z.enum(["global", "project"]).default("global").describe("Scope to inspect"),
      profile: z.string().optional().describe("Agent profile ID to include in context"),
      verbose: z.boolean().default(false).describe("Include full profile preferences/details when true"),
    },
    async ({ scope, profile, verbose }) => {
      const settingsPath = getSettingsPath(scope);
      const registered = getRegisteredHooks(scope);
      const hooks = registered.map((name) => {
        const meta = getHook(name);
        return { name, event: meta?.event, matcher: meta?.matcher ?? "", version: meta?.version };
      });

      // Doctor check
      const issues: { hook: string; issue: string; severity: string }[] = [];
      for (const name of registered) {
        if (!hookExists(name)) {
          issues.push({ hook: name, issue: "Hook not found in package", severity: "error" });
        }
      }
      const healthy = issues.length === 0;

      const ctx: Record<string, any> = {
        scope,
        settings_path: settingsPath,
        settings_exists: existsSync(settingsPath),
        registered_hooks: hooks,
        hook_count: hooks.length,
        healthy,
        issues,
        version: pkg.version,
      };

      if (profile) {
        const p = getProfile(profile);
        ctx.profile = p && !verbose
          ? { agent_id: p.agent_id, agent_type: p.agent_type, name: p.name }
          : p ?? null;
        if (p && !verbose) ctx.profile_hint = "Use verbose:true for profile preferences.";
      }

      return { content: [{ type: "text", text: JSON.stringify(ctx) }] };
    }
  );

  defineTool(
    "hooks_preview",
    "Simulate which installed PreToolUse hooks would fire for a given tool call and what decision each returns. Use this to understand your hook environment before taking an action.",
    {
      tool_name: z.string().describe("Tool name to simulate (e.g. 'Bash', 'Write', 'Edit')"),
      tool_input: z.record(z.string(), z.unknown()).default(() => ({})).describe("Tool input to pass to matching hooks"),
      scope: z.enum(["global", "project"]).default("global").describe("Scope to check"),
      timeout_ms: z.number().default(5000).describe("Per-hook timeout in milliseconds"),
    },
    async ({ tool_name, tool_input, scope, timeout_ms }) => {
      const registered = getRegisteredHooks(scope);
      const matchingHooks = registered.filter((name) => {
        const meta = getHook(name);
        if (!meta || meta.event !== "PreToolUse") return false;
        if (!meta.matcher) return true;
        try { return new RegExp(meta.matcher).test(tool_name); } catch { return false; }
      });

      if (matchingHooks.length === 0) {
        return { content: [{ type: "text", text: JSON.stringify({ tool_name, matching_hooks: [], result: "no_hooks_match", decision: "approve" }) }] };
      }

      const input = { tool_name, tool_input };
      const results = await Promise.all(matchingHooks.map(async (name) => {
        const hookDir = getHookPath(name);
        const hookScript = join(hookDir, "src", "hook.ts");
        if (!existsSync(hookScript)) return { name, decision: "approve", error: "script not found" };

        const proc = Bun.spawn(["bun", "run", hookScript], {
          stdin: new Response(JSON.stringify(input)),
          stdout: "pipe", stderr: "pipe", env: process.env,
        });
        const timeout = new Promise<null>((r) => setTimeout(() => r(null), timeout_ms));
        const res = await Promise.race([
          Promise.all([new Response(proc.stdout).text(), proc.exited])
            .then(([stdout]) => ({ stdout, timedOut: false })),
          timeout.then(() => { proc.kill(); return { stdout: "", timedOut: true }; }),
        ]);

        if (res.timedOut) return { name, decision: "approve", timedOut: true };
        let output: any = {};
        try { output = JSON.parse(res.stdout); } catch {}
        return { name, decision: output.decision ?? "approve", reason: output.reason, raw: output };
      }));

      const blocked = results.find((r) => r.decision === "block");
      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({
            tool_name,
            matching_hooks: matchingHooks,
            results,
            decision: blocked ? "block" : "approve",
            blocked_by: blocked?.name ?? null,
            blocked_reason: blocked?.reason ?? null,
          }),
        }],
      };
    }
  );

  defineTool(
    "hooks_setup",
    "Single-shot agent onboarding: create an agent profile + install recommended hooks in one call. Ideal for agents setting up hooks at session start.",
    {
      agent_type: z.enum(["claude", "gemini", "custom"]).default("claude").describe("Type of AI agent"),
      name: z.string().optional().describe("Optional display name for the agent"),
      hooks: z.array(z.string()).optional().describe("Hook names to install (omit for sensible defaults: gitguard, checkpoint, checktests, protectfiles)"),
      scope: z.enum(["global", "project"]).default("global").describe("Install scope"),
    },
    async ({ agent_type, name, hooks, scope }: { agent_type: "claude" | "gemini" | "custom"; name?: string; hooks?: string[]; scope: Scope }) => {
      const profile = createProfile({ agent_type, name });
      const toInstall = hooks && hooks.length > 0
        ? hooks
        : ["gitguard", "checkpoint", "checktests", "protectfiles"];
      const results = toInstall.map((h) => installHook(h, { scope, overwrite: false, profile: profile.agent_id }));
      const installed = results.filter((r) => r.success).map((r) => r.hook);
      const failed = results.filter((r) => !r.success).map((r) => ({ hook: r.hook, error: r.error }));
      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({ profile, installed, failed, scope, run_with: `hooks run <name> --profile ${profile.agent_id}` }),
        }],
      };
    }
  );

  defineTool(
    "hooks_batch_run",
    "Run multiple hooks in parallel in a single call. Returns all results at once — more efficient than N separate hooks_run calls.",
    {
      hooks: z.array(z.object({
        name: z.string().describe("Hook name"),
        input: z.record(z.string(), z.unknown()).default(() => ({})).describe("Hook input JSON"),
      })).describe("List of hooks to run with their inputs"),
      timeout_ms: z.number().default(10000).describe("Per-hook timeout in milliseconds"),
    },
    async ({ hooks, timeout_ms }: { hooks: Array<{ name: string; input: Record<string, unknown> }>; timeout_ms: number }) => {
      const results = await Promise.all(hooks.map(async ({ name, input }) => {
        const meta = getHook(name);
        if (!meta) return { name, error: `Hook '${name}' not found` };
        const hookScript = join(getHookPath(name), "src", "hook.ts");
        if (!existsSync(hookScript)) return { name, error: "script not found" };

        const proc = Bun.spawn(["bun", "run", hookScript], {
          stdin: new Response(JSON.stringify(input)),
          stdout: "pipe", stderr: "pipe", env: process.env,
        });
        const timeout = new Promise<null>((r) => setTimeout(() => r(null), timeout_ms));
        const res = await Promise.race([
          Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited])
            .then(([stdout, stderr, exitCode]) => ({ stdout, stderr, exitCode, timedOut: false })),
          timeout.then(() => { proc.kill(); return { stdout: "", stderr: "", exitCode: -1, timedOut: true }; }),
        ]);

        let output: any = {};
        try { output = JSON.parse(res.stdout); } catch { output = res.stdout ? { raw: res.stdout } : {}; }
        return { name, output, exitCode: res.exitCode, ...(res.timedOut ? { timedOut: true } : {}) };
      }));

      return { content: [{ type: "text", text: JSON.stringify({ results, count: results.length }) }] };
    }
  );

  defineTool(
    "hooks_disable",
    "Temporarily disable a registered hook without removing it. Stores disabled list in settings under hooks.__disabled.",
    {
      name: z.string().describe("Hook name to disable"),
      scope: z.enum(["global", "project"]).default("global").describe("Scope"),
    },
    async ({ name, scope }) => {
      const settingsPath = getSettingsPath(scope);
      let settings: Record<string, any> = {};
      try { if (existsSync(settingsPath)) settings = JSON.parse(readFileSync(settingsPath, "utf-8")); } catch {}
      if (!settings.hooks) settings.hooks = {};
      const disabled: string[] = settings.hooks.__disabled ?? [];
      if (!disabled.includes(name)) disabled.push(name);
      settings.hooks.__disabled = disabled;
      const { writeFileSync, mkdirSync } = await import("fs");
      const { dirname } = await import("path");
      mkdirSync(dirname(settingsPath), { recursive: true });
      writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + "\n");
      return { content: [{ type: "text", text: JSON.stringify({ hook: name, disabled: true, scope }) }] };
    }
  );

  defineTool(
    "hooks_enable",
    "Re-enable a previously disabled hook.",
    {
      name: z.string().describe("Hook name to enable"),
      scope: z.enum(["global", "project"]).default("global").describe("Scope"),
    },
    async ({ name, scope }) => {
      const settingsPath = getSettingsPath(scope);
      let settings: Record<string, any> = {};
      try { if (existsSync(settingsPath)) settings = JSON.parse(readFileSync(settingsPath, "utf-8")); } catch {}
      if (settings.hooks?.__disabled) {
        settings.hooks.__disabled = settings.hooks.__disabled.filter((n: string) => n !== name);
        if (settings.hooks.__disabled.length === 0) delete settings.hooks.__disabled;
        const { writeFileSync } = await import("fs");
        writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + "\n");
      }
      return { content: [{ type: "text", text: JSON.stringify({ hook: name, disabled: false, scope }) }] };
    }
  );

  defineTool(
    "hooks_init",
    "Register a new agent profile — returns a unique agent_id for use with hook installation and execution",
    {
      agent_type: z.enum(["claude", "gemini", "custom"]).default("claude").describe("Type of AI agent"),
      name: z.string().optional().describe("Optional display name for the agent"),
    },
    async ({ agent_type, name }) => {
      const profile = createProfile({ agent_type, name });
      return { content: [{ type: "text", text: JSON.stringify(profile) }] };
    }
  );

  defineTool(
    "hooks_profiles",
    "List registered agent profiles. Compact by default.",
    {
      compact: z.boolean().default(true).describe("Return compact summaries by default. Set false for full profiles."),
      limit: z.number().default(25).describe("Max compact rows to return"),
    },
    async ({ compact, limit }) => {
      const profiles = listProfiles();
      if (!compact) return { content: [{ type: "text", text: JSON.stringify(profiles) }] };
      const maxRows = boundedLimit(limit, 25, 100);
      const visible = profiles.slice(0, maxRows).map((profile) => ({
        agent_id: profile.agent_id,
        agent_type: profile.agent_type,
        name: profile.name,
        last_seen_at: profile.last_seen_at,
      }));
      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            profiles: visible,
            count: visible.length,
            total: profiles.length,
            omitted: Math.max(0, profiles.length - visible.length),
            hint: "Use compact:false for full profile preferences.",
          }),
        }],
      };
    }
  );

  // --- Log query tools ---

  defineTool(
    "hooks_log_list",
    "List hook events from SQLite. Compact summaries by default; set compact:false for full event rows.",
    {
      hook_name: z.string().optional().describe("Filter by hook name (e.g. 'sessionlog', 'costwatch')"),
      session_id: z.string().optional().describe("Filter by session ID prefix"),
      limit: z.number().optional().describe("Max number of events to return. Defaults to 20 compact rows or 50 full rows."),
      since: z.string().optional().describe("ISO timestamp or duration string (e.g. '1h', '30m', '7d') to filter from"),
      compact: z.boolean().default(true).describe("Return compact event summaries by default. Set false for full rows."),
    },
    async ({ hook_name, session_id, limit, since, compact }) => {
      const { getDb } = await import("../db/index.js");
      const db = getDb();
      const maxRows = boundedLimit(limit, compact ? 20 : 50, compact ? 100 : 500);

      function parseDuration(s: string): string | null {
        const m = s.match(/^(\d+)(s|m|h|d)$/);
        if (!m) return null;
        const n = parseInt(m[1]);
        const ms = { s: 1000, m: 60000, h: 3600000, d: 86400000 }[m[2] as "s"|"m"|"h"|"d"]!;
        return new Date(Date.now() - n * ms).toISOString();
      }

      let sql = "SELECT * FROM hook_events WHERE 1=1";
      const params: (string | number)[] = [];

      if (hook_name) { sql += " AND hook_name = ?"; params.push(hook_name); }
      if (session_id) { sql += " AND session_id LIKE ?"; params.push(`${session_id}%`); }
      if (since) {
        const ts = since.match(/^\d{4}/) ? since : parseDuration(since);
        if (ts) { sql += " AND timestamp >= ?"; params.push(ts); }
      }
      sql += " ORDER BY timestamp DESC LIMIT ?";
      params.push(maxRows);

      const rows = db.query(sql).all(...params) as any[];
      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            events: compact ? rows.map(compactEvent) : rows,
            count: rows.length,
            compact,
            hint: compact ? "Use compact:false for full tool_input/output fields." : undefined,
          }),
        }],
      };
    }
  );

  defineTool(
    "hooks_log_tail",
    "Show recent hook events from SQLite. Compact summaries by default.",
    {
      n: z.number().default(20).describe("Number of most recent events to return"),
      compact: z.boolean().default(true).describe("Return compact event summaries by default. Set false for full rows."),
    },
    async ({ n, compact }) => {
      const { getDb } = await import("../db/index.js");
      const db = getDb();
      const maxRows = boundedLimit(n, 20, compact ? 100 : 500);
      const rows = db.query("SELECT * FROM hook_events ORDER BY timestamp DESC LIMIT ?").all(maxRows) as any[];
      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            events: compact ? rows.map(compactEvent) : rows,
            count: rows.length,
            compact,
            hint: compact ? "Use compact:false for full tool_input/output fields." : undefined,
          }),
        }],
      };
    }
  );

  defineTool(
    "hooks_log_errors",
    "Show hook events that contain errors. Compact summaries by default.",
    {
      since: z.string().default("24h").describe("Duration string (e.g. '1h', '30m', '7d') or ISO timestamp"),
      limit: z.number().optional().describe("Max number of error events to return. Defaults to 20 compact rows or 50 full rows."),
      compact: z.boolean().default(true).describe("Return compact event summaries by default. Set false for full rows."),
    },
    async ({ since, limit, compact }) => {
      const { getDb } = await import("../db/index.js");
      const db = getDb();
      const maxRows = boundedLimit(limit, compact ? 20 : 50, compact ? 100 : 500);

      function parseDuration(s: string): string {
        const m = s.match(/^(\d+)(s|m|h|d)$/);
        if (!m) return s;
        const n = parseInt(m[1]);
        const ms = { s: 1000, m: 60000, h: 3600000, d: 86400000 }[m[2] as "s"|"m"|"h"|"d"]!;
        return new Date(Date.now() - n * ms).toISOString();
      }

      const ts = since.match(/^\d{4}/) ? since : parseDuration(since);
      const rows = db.query(
        "SELECT * FROM hook_events WHERE error IS NOT NULL AND timestamp >= ? ORDER BY timestamp DESC LIMIT ?"
      ).all(ts, maxRows) as any[];
      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            events: compact ? rows.map(compactEvent) : rows,
            count: rows.length,
            compact,
            hint: compact ? "Use compact:false for full tool_input/output fields." : undefined,
          }),
        }],
      };
    }
  );

  defineTool(
    "hooks_log_summary",
    "Summarize hook execution: counts per hook, error rates, and recent activity.",
    {
      since: z.string().default("24h").describe("Duration string (e.g. '1h', '24h', '7d') or ISO timestamp"),
    },
    async ({ since }) => {
      const { getDb } = await import("../db/index.js");
      const db = getDb();

      function parseDuration(s: string): string {
        const m = s.match(/^(\d+)(s|m|h|d)$/);
        if (!m) return s;
        const n = parseInt(m[1]);
        const ms = { s: 1000, m: 60000, h: 3600000, d: 86400000 }[m[2] as "s"|"m"|"h"|"d"]!;
        return new Date(Date.now() - n * ms).toISOString();
      }

      const ts = since.match(/^\d{4}/) ? since : parseDuration(since);

      const totals = db.query(
        "SELECT hook_name, COUNT(*) as total, SUM(CASE WHEN error IS NOT NULL THEN 1 ELSE 0 END) as errors FROM hook_events WHERE timestamp >= ? GROUP BY hook_name ORDER BY total DESC"
      ).all(ts) as { hook_name: string; total: number; errors: number }[];

      const summary = totals.map((r) => ({
        hook_name: r.hook_name,
        total: r.total,
        errors: r.errors,
        error_rate: r.total > 0 ? ((r.errors / r.total) * 100).toFixed(1) + "%" : "0%",
      }));

      const grandTotal = totals.reduce((s, r) => s + r.total, 0);
      const grandErrors = totals.reduce((s, r) => s + r.errors, 0);

      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            since: ts,
            hooks: summary,
            totals: { events: grandTotal, errors: grandErrors, hooks_active: totals.length },
          }),
        }],
      };
    }
  );

  defineTool(
    "storage_status",
    "Show hooks storage sync configuration and local sync history.",
    {},
    async () => ({ content: [{ type: "text" as const, text: JSON.stringify(getStorageStatus()) }] }),
  );

  defineTool(
    "storage_push",
    "Push local hook data to storage PostgreSQL.",
    { tables: z.array(z.string()).optional() },
    async (params) => ({ content: [{ type: "text" as const, text: JSON.stringify(await storagePush(params.tables ? { tables: params.tables } : undefined)) }] }),
  );

  defineTool(
    "storage_pull",
    "Pull hook data from storage PostgreSQL to local SQLite.",
    { tables: z.array(z.string()).optional() },
    async (params) => ({ content: [{ type: "text" as const, text: JSON.stringify(await storagePull(params.tables ? { tables: params.tables } : undefined)) }] }),
  );

  defineTool(
    "storage_sync",
    "Bidirectional hooks storage sync: pull then push.",
    { tables: z.array(z.string()).optional() },
    async (params) => ({ content: [{ type: "text" as const, text: JSON.stringify(await storageSync(params.tables ? { tables: params.tables } : undefined)) }] }),
  );

  defineTool(
    "send_feedback",
    "Send feedback about this service",
    {
      message: z.string(),
      email: z.string().optional(),
      category: z.enum(["bug", "feature", "general"]).optional(),
    },
    async (params) => {
      try {
        const { getDb } = await import("../db/index.js");
        const db = getDb();
        db.run("INSERT INTO feedback (message, email, category, version) VALUES (?, ?, ?, ?)", [
          params.message, params.email || null, params.category || "general", pkg.version,
        ]);
        return { content: [{ type: "text" as const, text: "Feedback saved. Thank you!" }] };
      } catch (e) {
        return { content: [{ type: "text" as const, text: String(e) }], isError: true };
      }
    },
  );

  // --- Standard Agent Tools ---

  defineTool("register_agent", "Register an agent session. Returns agent_id. Auto-triggers a heartbeat.", {
    name: z.string(),
    session_id: z.string().optional(),
  }, async (params) => {
    const existing = [..._hooksAgents.values()].find(a => a.name === params.name);
    if (existing) { existing.last_seen_at = new Date().toISOString(); if (params.session_id) existing.session_id = params.session_id; return { content: [{ type: "text" as const, text: JSON.stringify(existing) }] }; }
    const id = Math.random().toString(36).slice(2, 10);
    const ag: _HooksAgent = { id, name: params.name, session_id: params.session_id, last_seen_at: new Date().toISOString() };
    _hooksAgents.set(id, ag);
    return { content: [{ type: "text" as const, text: JSON.stringify(ag) }] };
  });

  defineTool("heartbeat", "Update last_seen_at to signal agent is active.", {
    agent_id: z.string(),
  }, async (params) => {
    const ag = _hooksAgents.get(params.agent_id);
    if (!ag) return { content: [{ type: "text" as const, text: `Agent not found: ${params.agent_id}` }], isError: true };
    ag.last_seen_at = new Date().toISOString();
    return { content: [{ type: "text" as const, text: JSON.stringify({ agent_id: ag.id, last_seen_at: ag.last_seen_at }) }] };
  });

  defineTool("set_focus", "Set active project context for this agent session.", {
    agent_id: z.string(),
    project_id: z.string().optional(),
  }, async (params) => {
    const ag = _hooksAgents.get(params.agent_id);
    if (!ag) return { content: [{ type: "text" as const, text: `Agent not found: ${params.agent_id}` }], isError: true };
    ag.project_id = params.project_id;
    return { content: [{ type: "text" as const, text: JSON.stringify({ agent_id: ag.id, project_id: ag.project_id ?? null }) }] };
  });

  defineTool("list_agents", "List registered agents. Compact by default.", {
    compact: z.boolean().default(true).describe("Return compact agent summaries by default. Set false for full records."),
    limit: z.number().default(25).describe("Max compact rows to return"),
  }, async ({ compact, limit }) => {
    const agents = [..._hooksAgents.values()];
    if (!compact) return { content: [{ type: "text" as const, text: JSON.stringify(agents) }] };
    const maxRows = boundedLimit(limit, 25, 100);
    const visible = agents.slice(0, maxRows).map((agent) => ({
      id: agent.id,
      name: agent.name,
      project_id: agent.project_id,
      last_seen_at: agent.last_seen_at,
    }));
    return {
      content: [{
        type: "text" as const,
        text: JSON.stringify({
          agents: visible,
          count: visible.length,
          total: agents.length,
          omitted: Math.max(0, agents.length - visible.length),
          hint: "Use compact:false for session_id and full records.",
        }),
      }],
    };
  });

  return server;
}

/**
 * Start the MCP server with SSE transport on the configured port
 */
export async function startSSEServer(port: number = MCP_PORT): Promise<void> {
  const server = createHooksServer();
  const transports = new Map<string, SSEServerTransport>();

  const httpServer = createServer(async (req, res) => {
    const url = new URL(req.url || "/", `http://localhost:${port}`);

    if (url.pathname === "/sse") {
      const transport = new SSEServerTransport("/messages", res);
      transports.set(transport.sessionId, transport);
      res.on("close", () => transports.delete(transport.sessionId));
      await server.connect(transport);
    } else if (url.pathname === "/messages") {
      const sessionId = url.searchParams.get("sessionId");
      if (!sessionId || !transports.has(sessionId)) {
        res.writeHead(400);
        res.end("Invalid session");
        return;
      }
      const transport = transports.get(sessionId)!;
      let body = "";
      for await (const chunk of req) body += chunk;
      await transport.handlePostMessage(req, res, body);
    } else {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ name: "@hasna/hooks", version: pkg.version, transport: "sse", port }));
    }
  });

  httpServer.listen(port, () => {
    console.error(`@hasna/hooks MCP server running on http://localhost:${port}`);
    console.error(`SSE endpoint: http://localhost:${port}/sse`);
  });
}

/**
 * Start the MCP server with stdio transport
 */
export async function startStdioServer(): Promise<void> {
  try {
    const server = createHooksServer();
    const transport = new StdioServerTransport();
    await server.connect(transport);
  } catch (err) {
    process.stderr.write(`[hooks-mcp] Failed to start: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  }
}
