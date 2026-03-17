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
const pkg = JSON.parse(readFileSync(join(__dirname, "..", "..", "package.json"), "utf-8"));

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
    "List all available hooks, optionally filtered by category",
    { category: z.string().optional().describe("Filter by category name (e.g. 'Git Safety', 'Code Quality', 'Security', 'Notifications', 'Context Management')") },
    async ({ category }) => {
      if (category) {
        const cat = CATEGORIES.find((c) => c.toLowerCase() === category.toLowerCase());
        if (!cat) {
          return { content: [{ type: "text", text: JSON.stringify({ error: `Unknown category: ${category}`, available: [...CATEGORIES] }) }] };
        }
        return { content: [{ type: "text", text: JSON.stringify(getHooksByCategory(cat)) }] };
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
    "Search for hooks by name, description, or tags",
    { query: z.string().describe("Search query") },
    async ({ query }) => {
      const results = searchHooks(query);
      return { content: [{ type: "text", text: JSON.stringify(results) }] };
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

      return { content: [{ type: "text", text: JSON.stringify({ healthy, issues, registered, scope }) }] };
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
        return { name, event: meta?.event, version: meta?.version, description: meta?.description };
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
  const server = createHooksServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
}
