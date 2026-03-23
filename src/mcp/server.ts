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

export function createHooksServer(): McpServer {
  const server = new McpServer({
    name: "@hasna/hooks",
    version: pkg.version,
  });

  // --- Tools ---

  server.tool(
    "hooks_list",
    "List all available hooks, optionally filtered by category. Use compact:true to get minimal output (name+event+matcher only) — saves tokens.",
    {
      category: z.string().optional().describe("Filter by category name (e.g. 'Git Safety', 'Code Quality', 'Security')"),
      compact: z.boolean().default(false).describe("Return minimal fields only: name, event, matcher. Reduces token usage."),
    },
    async ({ category, compact }) => {
      const slim = (hooks: typeof HOOKS) => compact ? hooks.map((h) => ({ name: h.name, event: h.event, matcher: h.matcher })) : hooks;
      if (category) {
        const cat = CATEGORIES.find((c) => c.toLowerCase() === category.toLowerCase());
        if (!cat) {
          return { content: [{ type: "text", text: JSON.stringify({ error: `Unknown category: ${category}`, available: [...CATEGORIES] }) }] };
        }
        return { content: [{ type: "text", text: JSON.stringify(slim(getHooksByCategory(cat))) }] };
      }
      if (compact) {
        return { content: [{ type: "text", text: JSON.stringify(slim(HOOKS)) }] };
      }
      const result: Record<string, any> = {};
      for (const cat of CATEGORIES) {
        result[cat] = getHooksByCategory(cat);
      }
      return { content: [{ type: "text", text: JSON.stringify(result) }] };
    }
  );

  server.tool(
    "hooks_search",
    "Search for hooks by name, description, or tags. Use compact:true for minimal output to save tokens.",
    {
      query: z.string().describe("Search query"),
      compact: z.boolean().default(false).describe("Return minimal fields only: name, event, matcher."),
    },
    async ({ query, compact }) => {
      const results = searchHooks(query);
      const out = compact ? results.map((h) => ({ name: h.name, event: h.event, matcher: h.matcher })) : results;
      return { content: [{ type: "text", text: JSON.stringify(out) }] };
    }
  );

  server.tool(
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

  server.tool(
    "hooks_install",
    "Install one or more hooks by registering them in agent settings",
    {
      hooks: z.array(z.string()).describe("Hook names to install"),
      scope: z.enum(["global", "project"]).default("global").describe("Install scope"),
      overwrite: z.boolean().default(false).describe("Overwrite if already installed"),
      profile: z.string().optional().describe("Agent profile ID to scope hooks to"),
    },
    async ({ hooks, scope, overwrite, profile }) => {
      const results = hooks.map((name) => installHook(name, { scope, overwrite, profile }));
      return formatInstallResults(results, { scope, profile });
    }
  );

  server.tool(
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

  server.tool(
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

  server.tool(
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

  server.tool(
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
                const match = h.command?.match(/^hooks run (\w+)/);
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

  server.tool(
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

  server.tool(
    "hooks_docs",
    "Get documentation — general overview or README for a specific hook",
    { name: z.string().optional().describe("Hook name for specific docs, omit for general docs") },
    async ({ name }) => {
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
        return { content: [{ type: "text", text: JSON.stringify({ ...meta, readme }) }] };
      }

      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            overview: "Hooks are scripts that run at specific points in an AI coding agent session. Install @hasna/hooks globally, then register hooks — no files are copied to your project.",
            events: {
              PreToolUse: "Fires before a tool executes. Can block the operation.",
              PostToolUse: "Fires after a tool executes. Runs asynchronously.",
              Stop: "Fires when a session ends. Useful for notifications.",
              Notification: "Fires on notification events like context compaction.",
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

  server.tool(
    "hooks_registered",
    "Get list of currently registered hooks for a scope",
    {
      scope: z.enum(["global", "project"]).default("global").describe("Scope to check"),
    },
    async ({ scope }) => {
      const registered = getRegisteredHooks(scope);
      const result = registered.map((name) => {
        const meta = getHook(name);
        return { name, event: meta?.event, matcher: meta?.matcher ?? "", version: meta?.version, description: meta?.description };
      });
      return { content: [{ type: "text", text: JSON.stringify(result) }] };
    }
  );

  server.tool(
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

  server.tool(
    "hooks_update",
    "Re-register installed hooks to pick up new package version (reinstalls with overwrite)",
    {
      hooks: z.array(z.string()).optional().describe("Hook names to update (omit to update all installed hooks)"),
      scope: z.enum(["global", "project"]).default("global").describe("Scope to update"),
    },
    async ({ hooks, scope }) => {
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

  server.tool(
    "hooks_context",
    "Get full agent context in one call: installed hooks (with event+matcher), active profile, settings path, and doctor status. Call this once at session start instead of making 4 separate calls.",
    {
      scope: z.enum(["global", "project"]).default("global").describe("Scope to inspect"),
      profile: z.string().optional().describe("Agent profile ID to include in context"),
    },
    async ({ scope, profile }) => {
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
        ctx.profile = p ?? null;
      }

      return { content: [{ type: "text", text: JSON.stringify(ctx) }] };
    }
  );

  server.tool(
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

  server.tool(
    "hooks_setup",
    "Single-shot agent onboarding: create an agent profile + install recommended hooks in one call. Ideal for agents setting up hooks at session start.",
    {
      agent_type: z.enum(["claude", "gemini", "custom"]).default("claude").describe("Type of AI agent"),
      name: z.string().optional().describe("Optional display name for the agent"),
      hooks: z.array(z.string()).optional().describe("Hook names to install (omit for sensible defaults: gitguard, checkpoint, checktests, protectfiles)"),
      scope: z.enum(["global", "project"]).default("global").describe("Install scope"),
    },
    async ({ agent_type, name, hooks, scope }) => {
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

  server.tool(
    "hooks_batch_run",
    "Run multiple hooks in parallel in a single call. Returns all results at once — more efficient than N separate hooks_run calls.",
    {
      hooks: z.array(z.object({
        name: z.string().describe("Hook name"),
        input: z.record(z.string(), z.unknown()).default(() => ({})).describe("Hook input JSON"),
      })).describe("List of hooks to run with their inputs"),
      timeout_ms: z.number().default(10000).describe("Per-hook timeout in milliseconds"),
    },
    async ({ hooks, timeout_ms }) => {
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

  server.tool(
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

  server.tool(
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

  server.tool(
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

  server.tool(
    "hooks_profiles",
    "List all registered agent profiles",
    {},
    async () => {
      const profiles = listProfiles();
      return { content: [{ type: "text", text: JSON.stringify(profiles) }] };
    }
  );

  // --- Log query tools ---

  server.tool(
    "hooks_log_list",
    "List hook events from SQLite (~/.hooks/hooks.db). Filter by hook name, session ID, or time range.",
    {
      hook_name: z.string().optional().describe("Filter by hook name (e.g. 'sessionlog', 'costwatch')"),
      session_id: z.string().optional().describe("Filter by session ID prefix"),
      limit: z.number().default(50).describe("Max number of events to return"),
      since: z.string().optional().describe("ISO timestamp or duration string (e.g. '1h', '30m', '7d') to filter from"),
    },
    async ({ hook_name, session_id, limit, since }) => {
      const { getDb } = await import("../db/index.js");
      const db = getDb();

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
      params.push(limit);

      const rows = db.query(sql).all(...params);
      return { content: [{ type: "text", text: JSON.stringify({ events: rows, count: (rows as any[]).length }) }] };
    }
  );

  server.tool(
    "hooks_log_tail",
    "Show the most recent hook events from SQLite.",
    {
      n: z.number().default(20).describe("Number of most recent events to return"),
    },
    async ({ n }) => {
      const { getDb } = await import("../db/index.js");
      const db = getDb();
      const rows = db.query("SELECT * FROM hook_events ORDER BY timestamp DESC LIMIT ?").all(n);
      return { content: [{ type: "text", text: JSON.stringify({ events: rows, count: (rows as any[]).length }) }] };
    }
  );

  server.tool(
    "hooks_log_errors",
    "Show hook events that contain errors, optionally filtered by time range.",
    {
      since: z.string().default("24h").describe("Duration string (e.g. '1h', '30m', '7d') or ISO timestamp"),
      limit: z.number().default(50).describe("Max number of error events to return"),
    },
    async ({ since, limit }) => {
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
      const rows = db.query(
        "SELECT * FROM hook_events WHERE error IS NOT NULL AND timestamp >= ? ORDER BY timestamp DESC LIMIT ?"
      ).all(ts, limit);
      return { content: [{ type: "text", text: JSON.stringify({ events: rows, count: (rows as any[]).length }) }] };
    }
  );

  server.tool(
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
