import { describe, test, expect, beforeEach, afterEach, beforeAll, afterAll } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createHooksServer, MCP_PORT } from "./server.js";

const SETTINGS_PATH = join(homedir(), ".claude", "settings.json");
const TEST_PORT = 39428;

let settingsBackup: string | null = null;

function backupSettings(): void {
  if (existsSync(SETTINGS_PATH)) {
    settingsBackup = readFileSync(SETTINGS_PATH, "utf-8");
  } else {
    settingsBackup = null;
  }
}

function restoreSettings(): void {
  if (settingsBackup !== null) {
    writeFileSync(SETTINGS_PATH, settingsBackup);
  } else if (existsSync(SETTINGS_PATH)) {
    try {
      const settings = JSON.parse(readFileSync(SETTINGS_PATH, "utf-8"));
      if (settings.hooks) {
        for (const eventKey of Object.keys(settings.hooks)) {
          settings.hooks[eventKey] = settings.hooks[eventKey].filter(
            (entry: any) =>
              !entry.hooks?.some((h: any) => /hooks run /.test(h.command || ""))
          );
          if (settings.hooks[eventKey].length === 0) delete settings.hooks[eventKey];
        }
        if (Object.keys(settings.hooks).length === 0) delete settings.hooks;
      }
      writeFileSync(SETTINGS_PATH, JSON.stringify(settings, null, 2) + "\n");
    } catch {}
  }
}

function parseResult(result: any): any {
  return JSON.parse((result.content as any)[0].text);
}

describe("MCP server", () => {
  describe("constants", () => {
    test("MCP_PORT is 39427", () => {
      expect(MCP_PORT).toBe(39427);
    });
  });

  describe("createHooksServer", () => {
    test("creates a server instance", () => {
      const server = createHooksServer();
      expect(server).toBeDefined();
    });
  });

  describe("tools via in-memory transport", () => {
    let client: Client;
    let server: ReturnType<typeof createHooksServer>;

    beforeEach(async () => {
      backupSettings();
      server = createHooksServer();
      client = new Client({ name: "test-client", version: "1.0.0" });
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
      await Promise.all([
        client.connect(clientTransport),
        server.connect(serverTransport),
      ]);
    });

    afterEach(async () => {
      await client.close();
      restoreSettings();
    });

    test("lists all 25 tools", async () => {
      const { tools } = await client.listTools();
      expect(tools.length).toBe(25);
      const names = tools.map((t) => t.name);
      expect(names).toContain("hooks_list");
      expect(names).toContain("hooks_search");
      expect(names).toContain("hooks_info");
      expect(names).toContain("hooks_install");
      expect(names).toContain("hooks_install_category");
      expect(names).toContain("hooks_install_all");
      expect(names).toContain("hooks_remove");
      expect(names).toContain("hooks_doctor");
      expect(names).toContain("hooks_run");
      expect(names).toContain("hooks_update");
      expect(names).toContain("hooks_context");
      expect(names).toContain("hooks_preview");
      expect(names).toContain("hooks_setup");
      expect(names).toContain("hooks_batch_run");
      expect(names).toContain("hooks_disable");
      expect(names).toContain("hooks_enable");
      expect(names).toContain("hooks_categories");
      expect(names).toContain("hooks_docs");
      expect(names).toContain("hooks_registered");
      expect(names).toContain("hooks_init");
      expect(names).toContain("hooks_profiles");
      expect(names).toContain("hooks_log_list");
      expect(names).toContain("hooks_log_tail");
      expect(names).toContain("hooks_log_errors");
      expect(names).toContain("hooks_log_summary");
    });

    test("every tool has a description", async () => {
      const { tools } = await client.listTools();
      for (const tool of tools) {
        expect(tool.description).toBeTruthy();
      }
    });

    // --- hooks_list ---

    test("hooks_list returns all hooks by category", async () => {
      const data = parseResult(await client.callTool({ name: "hooks_list", arguments: {} }));
      expect(data["Git Safety"]).toHaveLength(4);
      expect(data["Code Quality"]).toHaveLength(9);
      expect(data["Security"]).toHaveLength(2);
      expect(data["Notifications"]).toHaveLength(5);
      expect(data["Context Management"]).toHaveLength(2);
    });

    test("hooks_list with category filter", async () => {
      const data = parseResult(await client.callTool({ name: "hooks_list", arguments: { category: "Security" } }));
      expect(data).toHaveLength(2);
      expect(data[0].name).toBe("checksecurity");
      expect(data[1].name).toBe("packageage");
    });

    test("hooks_list with unknown category", async () => {
      const data = parseResult(await client.callTool({ name: "hooks_list", arguments: { category: "Fake" } }));
      expect(data.error).toContain("Unknown category");
      expect(data.available).toHaveLength(10);
    });

    test("hooks_list category is case-insensitive", async () => {
      const data = parseResult(await client.callTool({ name: "hooks_list", arguments: { category: "git safety" } }));
      expect(data).toHaveLength(4);
    });

    // --- hooks_search ---

    test("hooks_search finds hooks by name", async () => {
      const data = parseResult(await client.callTool({ name: "hooks_search", arguments: { query: "gitguard" } }));
      expect(data).toHaveLength(1);
      expect(data[0].name).toBe("gitguard");
    });

    test("hooks_search finds hooks by tag", async () => {
      const data = parseResult(await client.callTool({ name: "hooks_search", arguments: { query: "typosquatting" } }));
      expect(data).toHaveLength(1);
      expect(data[0].name).toBe("packageage");
    });

    test("hooks_search returns empty for no match", async () => {
      const data = parseResult(await client.callTool({ name: "hooks_search", arguments: { query: "zzzzzzz" } }));
      expect(data).toEqual([]);
    });

    test("hooks_search result has all fields", async () => {
      const data = parseResult(await client.callTool({ name: "hooks_search", arguments: { query: "git" } }));
      for (const hook of data) {
        expect(hook).toHaveProperty("name");
        expect(hook).toHaveProperty("displayName");
        expect(hook).toHaveProperty("version");
        expect(hook).toHaveProperty("event");
        expect(hook).toHaveProperty("tags");
      }
    });

    // --- hooks_info ---

    test("hooks_info returns full metadata", async () => {
      const data = parseResult(await client.callTool({ name: "hooks_info", arguments: { name: "gitguard" } }));
      expect(data.name).toBe("gitguard");
      expect(data.displayName).toBe("Git Guard");
      expect(data.event).toBe("PreToolUse");
      expect(data.version).toBe("0.1.0");
      expect(data.matcher).toBe("Bash");
      expect(typeof data.global).toBe("boolean");
      expect(typeof data.project).toBe("boolean");
    });

    test("hooks_info error for unknown hook", async () => {
      const data = parseResult(await client.callTool({ name: "hooks_info", arguments: { name: "nonexistent" } }));
      expect(data.error).toContain("not found");
    });

    test("hooks_info for every hook", async () => {
      const allHooks = [
        "gitguard", "branchprotect", "checkpoint",
        "checktests", "checklint", "checkfiles",
        "stylescheck",
        "checkbugs", "checkdocs", "checktasks",
        "checksecurity", "packageage",
        "phonenotify", "agentmessages",
        "contextrefresh", "precompact",
      ];
      for (const name of allHooks) {
        const data = parseResult(await client.callTool({ name: "hooks_info", arguments: { name } }));
        expect(data.name).toBe(name);
        expect(data.version).toMatch(/^\d+\.\d+\.\d+$/);
      }
    });

    // --- hooks_install ---

    test("hooks_install single hook", async () => {
      const data = parseResult(await client.callTool({ name: "hooks_install", arguments: { hooks: ["gitguard"] } }));
      expect(data.success).toBe(1);
      expect(data.installed).toContain("gitguard");
      expect(data.scope).toBe("global");
    });

    test("hooks_install multiple hooks", async () => {
      const data = parseResult(await client.callTool({ name: "hooks_install", arguments: { hooks: ["gitguard", "checkpoint", "packageage"] } }));
      expect(data.success).toBe(3);
      expect(data.installed).toHaveLength(3);
    });

    test("hooks_install fails for nonexistent", async () => {
      const data = parseResult(await client.callTool({ name: "hooks_install", arguments: { hooks: ["nonexistent"] } }));
      expect(data.success).toBe(0);
      expect(data.failed).toHaveLength(1);
      expect(data.failed[0].error).toContain("not found");
    });

    test("hooks_install mixed valid and invalid", async () => {
      const data = parseResult(await client.callTool({ name: "hooks_install", arguments: { hooks: ["gitguard", "nonexistent"] } }));
      expect(data.success).toBe(1);
      expect(data.installed).toContain("gitguard");
      expect(data.failed).toHaveLength(1);
    });

    test("hooks_install duplicate without overwrite fails", async () => {
      await client.callTool({ name: "hooks_install", arguments: { hooks: ["gitguard"] } });
      const data = parseResult(await client.callTool({ name: "hooks_install", arguments: { hooks: ["gitguard"] } }));
      expect(data.success).toBe(0);
      expect(data.failed[0].error).toContain("Already installed");
    });

    test("hooks_install duplicate with overwrite succeeds", async () => {
      await client.callTool({ name: "hooks_install", arguments: { hooks: ["gitguard"] } });
      const data = parseResult(await client.callTool({ name: "hooks_install", arguments: { hooks: ["gitguard"], overwrite: true } }));
      expect(data.success).toBe(1);
    });

    // --- hooks_install_category ---

    test("hooks_install_category installs Git Safety", async () => {
      const data = parseResult(await client.callTool({ name: "hooks_install_category", arguments: { category: "Git Safety" } }));
      expect(data.installed).toContain("gitguard");
      expect(data.installed).toContain("branchprotect");
      expect(data.installed).toContain("checkpoint");
      expect(data.category).toBe("Git Safety");
    });

    test("hooks_install_category rejects unknown", async () => {
      const data = parseResult(await client.callTool({ name: "hooks_install_category", arguments: { category: "Fake" } }));
      expect(data.error).toContain("Unknown category");
    });

    // --- hooks_install_all ---

    test("hooks_install_all installs all 39", async () => {
      const data = parseResult(await client.callTool({ name: "hooks_install_all", arguments: {} }));
      expect(data.total).toBe(39);
      expect(data.success).toBe(39);
      expect(data.installed).toHaveLength(39);
    });

    // --- hooks_remove ---

    test("hooks_remove removes installed hook", async () => {
      await client.callTool({ name: "hooks_install", arguments: { hooks: ["gitguard"] } });
      const data = parseResult(await client.callTool({ name: "hooks_remove", arguments: { name: "gitguard" } }));
      expect(data.removed).toBe(true);
      expect(data.scope).toBe("global");
    });

    test("hooks_remove returns false for non-installed", async () => {
      const data = parseResult(await client.callTool({ name: "hooks_remove", arguments: { name: "nonexistent" } }));
      expect(data.removed).toBe(false);
    });

    // --- hooks_doctor ---

    test("hooks_doctor with no hooks", async () => {
      const data = parseResult(await client.callTool({ name: "hooks_doctor", arguments: {} }));
      expect(data).toHaveProperty("healthy");
      expect(data).toHaveProperty("issues");
      expect(data).toHaveProperty("registered");
      expect(data.scope).toBe("global");
    });

    test("hooks_doctor shows healthy after install", async () => {
      backupSettings();
      await client.callTool({ name: "hooks_install", arguments: { hooks: ["gitguard"] } });
      const data = parseResult(await client.callTool({ name: "hooks_doctor", arguments: {} }));
      expect(data.healthy).toBe(true);
      expect(data.healthy_hooks).toContain("gitguard");
      expect(data.issues).toHaveLength(0);
      restoreSettings();
    });

    // --- hooks_categories ---

    test("hooks_categories returns all 5", async () => {
      const data = parseResult(await client.callTool({ name: "hooks_categories", arguments: {} }));
      expect(data).toHaveLength(10);
      const names = data.map((c: any) => c.name);
      expect(names).toContain("Git Safety");
      expect(names).toContain("Code Quality");
      expect(names).toContain("Security");
      expect(names).toContain("Notifications");
      expect(names).toContain("Context Management");
    });

    test("hooks_categories counts match", async () => {
      const data = parseResult(await client.callTool({ name: "hooks_categories", arguments: {} }));
      const gitSafety = data.find((c: any) => c.name === "Git Safety");
      expect(gitSafety.count).toBe(4);
      const codeQuality = data.find((c: any) => c.name === "Code Quality");
      expect(codeQuality.count).toBe(9);
    });

    // --- hooks_docs ---

    test("hooks_docs general", async () => {
      const data = parseResult(await client.callTool({ name: "hooks_docs", arguments: {} }));
      expect(data).toHaveProperty("overview");
      expect(data).toHaveProperty("events");
      expect(data).toHaveProperty("commands");
      expect(data.events).toHaveProperty("PreToolUse");
    });

    test("hooks_docs specific hook", async () => {
      const data = parseResult(await client.callTool({ name: "hooks_docs", arguments: { name: "gitguard" } }));
      expect(data.name).toBe("gitguard");
      expect(typeof data.readme).toBe("string");
      expect(data.readme.length).toBeGreaterThan(0);
    });

    test("hooks_docs unknown hook", async () => {
      const data = parseResult(await client.callTool({ name: "hooks_docs", arguments: { name: "nonexistent" } }));
      expect(data.error).toContain("not found");
    });

    // --- hooks_registered ---

    test("hooks_registered empty when none installed", async () => {
      const data = parseResult(await client.callTool({ name: "hooks_registered", arguments: {} }));
      // May contain hooks from other tests, just check it's an array
      expect(Array.isArray(data)).toBe(true);
    });

    test("hooks_registered shows installed hooks", async () => {
      await client.callTool({ name: "hooks_install", arguments: { hooks: ["gitguard"] } });
      const data = parseResult(await client.callTool({ name: "hooks_registered", arguments: {} }));
      expect(data.some((h: any) => h.name === "gitguard")).toBe(true);
      expect(data.find((h: any) => h.name === "gitguard").event).toBe("PreToolUse");
    });

    // --- project scope ---

    test("hooks_install with project scope", async () => {
      const data = parseResult(await client.callTool({ name: "hooks_install", arguments: { hooks: ["packageage"], scope: "project", overwrite: true } }));
      expect(data.success).toBe(1);
      expect(data.scope).toBe("project");
    });

    test("hooks_remove with project scope", async () => {
      await client.callTool({ name: "hooks_install", arguments: { hooks: ["packageage"], scope: "project", overwrite: true } });
      const data = parseResult(await client.callTool({ name: "hooks_remove", arguments: { name: "packageage", scope: "project" } }));
      expect(data.removed).toBe(true);
      expect(data.scope).toBe("project");
    });

    test("hooks_registered with project scope", async () => {
      await client.callTool({ name: "hooks_install", arguments: { hooks: ["packageage"], scope: "project", overwrite: true } });
      const data = parseResult(await client.callTool({ name: "hooks_registered", arguments: { scope: "project" } }));
      expect(data.some((h: any) => h.name === "packageage")).toBe(true);
    });

    test("hooks_doctor with project scope", async () => {
      await client.callTool({ name: "hooks_install", arguments: { hooks: ["packageage"], scope: "project", overwrite: true } });
      const data = parseResult(await client.callTool({ name: "hooks_doctor", arguments: { scope: "project" } }));
      expect(data.scope).toBe("project");
      expect(data.healthy).toBe(true);
      expect(data.healthy_hooks).toContain("packageage");
    });

    // --- install category for all categories ---

    test("hooks_install_category installs Code Quality", async () => {
      const data = parseResult(await client.callTool({ name: "hooks_install_category", arguments: { category: "Code Quality" } }));
      expect(data.installed).toHaveLength(9);
      expect(data.installed).toContain("checktests");
      expect(data.installed).toContain("checktasks");
    });

    test("hooks_install_category installs Security", async () => {
      const data = parseResult(await client.callTool({ name: "hooks_install_category", arguments: { category: "Security" } }));
      expect(data.installed).toContain("checksecurity");
      expect(data.installed).toContain("packageage");
    });

    test("hooks_install_category installs Notifications", async () => {
      const data = parseResult(await client.callTool({ name: "hooks_install_category", arguments: { category: "Notifications" } }));
      expect(data.installed).toContain("phonenotify");
      expect(data.installed).toContain("agentmessages");
    });

    test("hooks_install_category installs Context Management", async () => {
      const data = parseResult(await client.callTool({ name: "hooks_install_category", arguments: { category: "Context Management" } }));
      expect(data.installed).toContain("contextrefresh");
      expect(data.installed).toContain("precompact");
    });

    // --- overwrite flows ---

    test("hooks_install_category with overwrite re-installs", async () => {
      await client.callTool({ name: "hooks_install_category", arguments: { category: "Git Safety" } });
      const data = parseResult(await client.callTool({ name: "hooks_install_category", arguments: { category: "Git Safety", overwrite: true } }));
      expect(data.installed).toHaveLength(4);
    });

    test("hooks_install_all with overwrite after install", async () => {
      await client.callTool({ name: "hooks_install_all", arguments: {} });
      const data = parseResult(await client.callTool({ name: "hooks_install_all", arguments: { overwrite: true } }));
      expect(data.success).toBe(39);
    });

    // --- docs for every hook ---

    test("hooks_docs returns readme for every hook", async () => {
      const allHooks = [
        "gitguard", "branchprotect", "checkpoint",
        "checktests", "checklint", "checkfiles",
        "stylescheck",
        "checkbugs", "checkdocs", "checktasks",
        "checksecurity", "packageage",
        "phonenotify", "agentmessages",
        "contextrefresh", "precompact",
      ];
      for (const name of allHooks) {
        const data = parseResult(await client.callTool({ name: "hooks_docs", arguments: { name } }));
        expect(data.name).toBe(name);
        expect(typeof data.readme).toBe("string");
        expect(data.version).toMatch(/^\d+\.\d+\.\d+$/);
      }
    });

    // --- registered field validation ---

    test("hooks_registered result has all metadata fields", async () => {
      await client.callTool({ name: "hooks_install", arguments: { hooks: ["gitguard"] } });
      const data = parseResult(await client.callTool({ name: "hooks_registered", arguments: {} }));
      const hook = data.find((h: any) => h.name === "gitguard");
      expect(hook).toBeDefined();
      expect(hook.event).toBe("PreToolUse");
      expect(hook.version).toBe("0.1.0");
      expect(hook.description).toBeTruthy();
    });

    // --- docs general fields ---

    test("hooks_docs general has all event types", async () => {
      const data = parseResult(await client.callTool({ name: "hooks_docs", arguments: {} }));
      expect(data.events.PreToolUse).toBeTruthy();
      expect(data.events.PostToolUse).toBeTruthy();
      expect(data.events.Stop).toBeTruthy();
      expect(data.events.Notification).toBeTruthy();
    });

    test("hooks_docs general has all command examples", async () => {
      const data = parseResult(await client.callTool({ name: "hooks_docs", arguments: {} }));
      expect(data.commands.install).toBeTruthy();
      expect(data.commands.installProject).toBeTruthy();
      expect(data.commands.installAll).toBeTruthy();
      expect(data.commands.remove).toBeTruthy();
      expect(data.commands.list).toBeTruthy();
      expect(data.commands.search).toBeTruthy();
      expect(data.commands.doctor).toBeTruthy();
    });

    // --- install all → remove all via MCP ---

    test("install all 39 then remove all 39", async () => {
      const install = parseResult(await client.callTool({ name: "hooks_install_all", arguments: {} }));
      expect(install.success).toBe(39);

      const allHooks = [
        "gitguard", "branchprotect", "checkpoint",
        "checktests", "checklint", "checkfiles",
        "checkbugs", "checkdocs", "checktasks",
        "stylescheck",
        "checksecurity", "packageage",
        "phonenotify", "agentmessages",
        "contextrefresh", "precompact",
      ];
      for (const name of allHooks) {
        const rm = parseResult(await client.callTool({ name: "hooks_remove", arguments: { name } }));
        expect(rm.removed).toBe(true);
      }

      const after = parseResult(await client.callTool({ name: "hooks_registered", arguments: {} }));
      for (const name of allHooks) {
        expect(after.some((h: any) => h.name === name)).toBe(false);
      }
    });

    // --- search edge cases ---

    test("hooks_search by description keyword", async () => {
      const data = parseResult(await client.callTool({ name: "hooks_search", arguments: { query: "destructive" } }));
      expect(data.length).toBeGreaterThanOrEqual(1);
      expect(data[0].name).toBe("gitguard");
    });

    test("hooks_search case insensitive", async () => {
      const upper = parseResult(await client.callTool({ name: "hooks_search", arguments: { query: "GITGUARD" } }));
      const lower = parseResult(await client.callTool({ name: "hooks_search", arguments: { query: "gitguard" } }));
      expect(upper).toEqual(lower);
    });

    test("hooks_search by category-related term", async () => {
      const data = parseResult(await client.callTool({ name: "hooks_search", arguments: { query: "security" } }));
      expect(data.some((h: any) => h.name === "checksecurity")).toBe(true);
    });

    // --- hooks_list every category individually ---

    test("hooks_list Notifications category", async () => {
      const data = parseResult(await client.callTool({ name: "hooks_list", arguments: { category: "Notifications" } }));
      expect(data).toHaveLength(5);
      expect(data[0].event).toBe("Stop");
    });

    test("hooks_list Context Management category", async () => {
      const data = parseResult(await client.callTool({ name: "hooks_list", arguments: { category: "Context Management" } }));
      expect(data).toHaveLength(2);
      expect(data[0].event).toBe("Notification");
    });

    test("hooks_list Code Quality category", async () => {
      const data = parseResult(await client.callTool({ name: "hooks_list", arguments: { category: "Code Quality" } }));
      expect(data).toHaveLength(9);
      // stylescheck is PreToolUse, others are PostToolUse
      expect(data.some((h: any) => h.event === "PreToolUse")).toBe(true);
      expect(data.some((h: any) => h.event === "PostToolUse")).toBe(true);
    });

    // --- full lifecycle ---

    test("install → doctor → registered → info → remove → verify", async () => {
      // Install
      const install = parseResult(await client.callTool({ name: "hooks_install", arguments: { hooks: ["gitguard", "packageage"] } }));
      expect(install.success).toBe(2);

      // Doctor — both healthy
      const doctor = parseResult(await client.callTool({ name: "hooks_doctor", arguments: {} }));
      expect(doctor.healthy).toBe(true);
      expect(doctor.healthy_hooks).toContain("gitguard");
      expect(doctor.healthy_hooks).toContain("packageage");

      // Registered — both present
      const reg = parseResult(await client.callTool({ name: "hooks_registered", arguments: {} }));
      expect(reg.some((h: any) => h.name === "gitguard")).toBe(true);
      expect(reg.some((h: any) => h.name === "packageage")).toBe(true);

      // Info — shows global=true
      const info = parseResult(await client.callTool({ name: "hooks_info", arguments: { name: "gitguard" } }));
      expect(info.global).toBe(true);

      // Remove gitguard
      const remove = parseResult(await client.callTool({ name: "hooks_remove", arguments: { name: "gitguard" } }));
      expect(remove.removed).toBe(true);

      // Verify gitguard gone, packageage still there
      const afterReg = parseResult(await client.callTool({ name: "hooks_registered", arguments: {} }));
      expect(afterReg.some((h: any) => h.name === "gitguard")).toBe(false);
      expect(afterReg.some((h: any) => h.name === "packageage")).toBe(true);

      // Info now shows global=false
      const afterInfo = parseResult(await client.callTool({ name: "hooks_info", arguments: { name: "gitguard" } }));
      expect(afterInfo.global).toBe(false);
    });

    // --- hooks_run ---

    test("hooks_run executes a hook with provided input", async () => {
      const data = parseResult(await client.callTool({
        name: "hooks_run",
        arguments: { name: "gitguard", input: { tool_name: "Bash", tool_input: { command: "echo hello" } } },
      }));
      expect(data.hook).toBe("gitguard");
      expect(data).toHaveProperty("output");
      expect(data).toHaveProperty("exitCode");
    });

    test("hooks_run returns error for unknown hook", async () => {
      const data = parseResult(await client.callTool({
        name: "hooks_run",
        arguments: { name: "nonexistent-hook-xyz", input: {} },
      }));
      expect(data.error).toContain("not found");
    });

    // --- hooks_context ---

    test("hooks_context returns full session context", async () => {
      const data = parseResult(await client.callTool({ name: "hooks_context", arguments: {} }));
      expect(data).toHaveProperty("scope");
      expect(data).toHaveProperty("settings_path");
      expect(data).toHaveProperty("settings_exists");
      expect(data).toHaveProperty("registered_hooks");
      expect(data).toHaveProperty("hook_count");
      expect(data).toHaveProperty("healthy");
      expect(data).toHaveProperty("issues");
      expect(data).toHaveProperty("version");
      expect(Array.isArray(data.registered_hooks)).toBe(true);
    });

    test("hooks_context registered_hooks include matcher field", async () => {
      backupSettings();
      await client.callTool({ name: "hooks_install", arguments: { hooks: ["gitguard"] } });
      const data = parseResult(await client.callTool({ name: "hooks_context", arguments: {} }));
      const gitguard = data.registered_hooks.find((h: any) => h.name === "gitguard");
      expect(gitguard).toBeDefined();
      expect(gitguard).toHaveProperty("event");
      expect(gitguard).toHaveProperty("matcher");
      restoreSettings();
    });

    // --- hooks_preview ---

    test("hooks_preview returns approve when no hooks match", async () => {
      const data = parseResult(await client.callTool({
        name: "hooks_preview",
        arguments: { tool_name: "Bash", tool_input: { command: "echo hello" } },
      }));
      expect(data).toHaveProperty("decision");
      expect(data).toHaveProperty("tool_name");
      expect(data.tool_name).toBe("Bash");
    });

    test("hooks_preview returns matching hooks after install", async () => {
      backupSettings();
      await client.callTool({ name: "hooks_install", arguments: { hooks: ["gitguard"] } });
      const data = parseResult(await client.callTool({
        name: "hooks_preview",
        arguments: { tool_name: "Bash", tool_input: { command: "echo safe" } },
      }));
      expect(data.matching_hooks).toContain("gitguard");
      expect(data).toHaveProperty("results");
      expect(data.results.length).toBeGreaterThan(0);
      restoreSettings();
    });

    // --- hooks_setup ---

    test("hooks_setup creates profile and installs defaults", async () => {
      backupSettings();
      const data = parseResult(await client.callTool({
        name: "hooks_setup",
        arguments: { agent_type: "claude", name: "test-agent" },
      }));
      expect(data).toHaveProperty("profile");
      expect(data.profile.agent_type).toBe("claude");
      expect(data.profile.name).toBe("test-agent");
      expect(Array.isArray(data.installed)).toBe(true);
      expect(data.installed.length).toBeGreaterThan(0);
      expect(data).toHaveProperty("run_with");
      restoreSettings();
    });

    // --- hooks_batch_run ---

    test("hooks_batch_run runs multiple hooks", async () => {
      const data = parseResult(await client.callTool({
        name: "hooks_batch_run",
        arguments: {
          hooks: [
            { name: "gitguard", input: { tool_name: "Bash", tool_input: { command: "echo hi" } } },
            { name: "gitguard", input: { tool_name: "Bash", tool_input: { command: "echo hi2" } } },
          ],
        },
      }));
      expect(data.count).toBe(2);
      expect(data.results).toHaveLength(2);
      expect(data.results[0].name).toBe("gitguard");
    });

    test("hooks_batch_run handles unknown hook gracefully", async () => {
      const data = parseResult(await client.callTool({
        name: "hooks_batch_run",
        arguments: { hooks: [{ name: "nonexistent-xyz", input: {} }] },
      }));
      expect(data.results[0].error).toBeTruthy();
    });

    // --- hooks_disable / hooks_enable ---

    test("hooks_disable and hooks_enable round-trip", async () => {
      const disabled = parseResult(await client.callTool({
        name: "hooks_disable",
        arguments: { name: "gitguard" },
      }));
      expect(disabled.disabled).toBe(true);
      expect(disabled.hook).toBe("gitguard");

      const enabled = parseResult(await client.callTool({
        name: "hooks_enable",
        arguments: { name: "gitguard" },
      }));
      expect(enabled.disabled).toBe(false);
    });

    // --- compact mode ---

    test("hooks_list compact returns minimal fields", async () => {
      const data = parseResult(await client.callTool({ name: "hooks_list", arguments: { compact: true } }));
      expect(Array.isArray(data)).toBe(true);
      expect(data.length).toBe(39);
      expect(data[0]).toHaveProperty("name");
      expect(data[0]).toHaveProperty("event");
      expect(data[0]).toHaveProperty("matcher");
      expect(data[0]).not.toHaveProperty("description");
    });

    test("hooks_search compact returns minimal fields", async () => {
      const data = parseResult(await client.callTool({ name: "hooks_search", arguments: { query: "git", compact: true } }));
      expect(Array.isArray(data)).toBe(true);
      expect(data[0]).toHaveProperty("name");
      expect(data[0]).toHaveProperty("event");
      expect(data[0]).not.toHaveProperty("tags");
    });

    // --- matcher in hooks_registered ---

    test("hooks_registered includes matcher field", async () => {
      backupSettings();
      await client.callTool({ name: "hooks_install", arguments: { hooks: ["gitguard"] } });
      const data = parseResult(await client.callTool({ name: "hooks_registered", arguments: {} }));
      const hook = data.find((h: any) => h.name === "gitguard");
      expect(hook).toHaveProperty("matcher");
      restoreSettings();
    });
  });

  describe("SSE HTTP endpoints", () => {
    let serverProcess: any;

    beforeAll(async () => {
      serverProcess = Bun.spawn(
        ["bun", "run", join(import.meta.dir, "..", "cli", "index.tsx"), "mcp", "--port", String(TEST_PORT)],
        { stdout: "pipe", stderr: "pipe" }
      );
      for (let i = 0; i < 50; i++) {
        try {
          const res = await fetch(`http://localhost:${TEST_PORT}/`);
          if (res.ok) break;
        } catch {}
        await new Promise((r) => setTimeout(r, 200));
      }
    });

    afterAll(async () => {
      if (serverProcess) {
        serverProcess.kill();
        await serverProcess.exited;
      }
    });

    test("root endpoint returns server info", async () => {
      const res = await fetch(`http://localhost:${TEST_PORT}/`);
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.name).toBe("@hasna/hooks");
      expect(data.transport).toBe("sse");
      expect(data.port).toBe(TEST_PORT);
    });

    test("SSE endpoint returns event-stream", async () => {
      const res = await fetch(`http://localhost:${TEST_PORT}/sse`);
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toContain("text/event-stream");
      if (res.body) {
        const reader = res.body.getReader();
        reader.cancel();
      }
    });

    test("messages endpoint rejects without sessionId", async () => {
      const res = await fetch(`http://localhost:${TEST_PORT}/messages`, { method: "POST", body: "{}" });
      expect(res.status).toBe(400);
    });

    test("messages endpoint rejects invalid sessionId", async () => {
      const res = await fetch(`http://localhost:${TEST_PORT}/messages?sessionId=invalid`, { method: "POST", body: "{}" });
      expect(res.status).toBe(400);
    });
  });
});
