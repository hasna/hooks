import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { join } from "path";
import { existsSync, readFileSync, writeFileSync, mkdirSync, rmSync } from "fs";
import { homedir, tmpdir } from "os";

const CLI = join(import.meta.dir, "index.tsx");
const SETTINGS_PATH = join(homedir(), ".claude", "settings.json");

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
  }
}

async function run(...args: string[]): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const proc = Bun.spawn(["bun", "run", CLI, ...args], {
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, NO_COLOR: "1" },
  });
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const exitCode = await proc.exited;
  return { stdout, stderr, exitCode };
}

async function runJson(...args: string[]): Promise<any> {
  const { stdout } = await run(...args, "--json");
  return JSON.parse(stdout.trim());
}

describe("CLI", () => {
  describe("hooks --version", () => {
    test("prints version", async () => {
      const { stdout } = await run("--version");
      expect(stdout.trim()).toMatch(/^\d+\.\d+\.\d+$/);
    });
  });

  describe("hooks --help", () => {
    test("shows help text", async () => {
      const { stdout } = await run("--help");
      expect(stdout).toContain("Install Claude Code hooks");
    });

    test("shows all commands", async () => {
      const { stdout } = await run("--help");
      expect(stdout).toContain("install");
      expect(stdout).toContain("list");
      expect(stdout).toContain("search");
      expect(stdout).toContain("remove");
      expect(stdout).toContain("categories");
      expect(stdout).toContain("info");
      expect(stdout).toContain("doctor");
      expect(stdout).toContain("update");
      expect(stdout).toContain("docs");
      expect(stdout).toContain("run");
      expect(stdout).toContain("mcp");
    });
  });

  describe("hooks list", () => {
    test("lists all hooks", async () => {
      const { stdout } = await run("list");
      expect(stdout).toContain("Available hooks (15)");
      expect(stdout).toContain("Git Safety");
      expect(stdout).toContain("Code Quality");
      expect(stdout).toContain("Security");
      expect(stdout).toContain("Notifications");
      expect(stdout).toContain("Context Management");
    });

    test("--json returns all hooks grouped by category", async () => {
      const data = await runJson("list");
      expect(data["Git Safety"]).toHaveLength(3);
      expect(data["Code Quality"]).toHaveLength(6);
      expect(data["Security"]).toHaveLength(2);
      expect(data["Notifications"]).toHaveLength(2);
      expect(data["Context Management"]).toHaveLength(2);
    });

    test("lists by category", async () => {
      const { stdout } = await run("list", "-c", "Security");
      expect(stdout).toContain("Security (2)");
      expect(stdout).toContain("checksecurity");
      expect(stdout).toContain("packageage");
    });

    test("--category --json returns hook array", async () => {
      const data = await runJson("list", "-c", "Security");
      expect(Array.isArray(data)).toBe(true);
      expect(data).toHaveLength(2);
      expect(data[0].name).toBe("checksecurity");
    });

    test("errors on unknown category", async () => {
      const { stdout } = await run("list", "-c", "Fake");
      expect(stdout).toContain("Unknown category");
    });

    test("--category unknown --json returns error", async () => {
      const data = await runJson("list", "-c", "Fake");
      expect(data.error).toContain("Unknown category");
      expect(data.available).toBeDefined();
    });

    test("--registered --json returns array", async () => {
      const data = await runJson("list", "--registered");
      expect(Array.isArray(data)).toBe(true);
    });

    test("--installed --json returns array", async () => {
      const data = await runJson("list", "--installed");
      expect(Array.isArray(data)).toBe(true);
    });
  });

  describe("hooks search", () => {
    test("finds hooks by query", async () => {
      const { stdout } = await run("search", "git");
      expect(stdout).toContain("Found");
      expect(stdout).toContain("gitguard");
    });

    test("shows no results for bad query", async () => {
      const { stdout } = await run("search", "zzzzzzz");
      expect(stdout).toContain("No hooks found");
    });

    test("--json returns hook array", async () => {
      const data = await runJson("search", "git");
      expect(Array.isArray(data)).toBe(true);
      expect(data.length).toBeGreaterThan(0);
      expect(data[0].name).toBeDefined();
    });

    test("--json returns empty array for no match", async () => {
      const data = await runJson("search", "zzzzzzz");
      expect(data).toEqual([]);
    });
  });

  describe("hooks categories", () => {
    test("lists all categories", async () => {
      const { stdout } = await run("categories");
      expect(stdout).toContain("Git Safety");
      expect(stdout).toContain("Code Quality");
      expect(stdout).toContain("Security");
      expect(stdout).toContain("Notifications");
      expect(stdout).toContain("Context Management");
    });

    test("--json returns category objects", async () => {
      const data = await runJson("categories");
      expect(Array.isArray(data)).toBe(true);
      expect(data).toHaveLength(5);
      expect(data[0]).toHaveProperty("name");
      expect(data[0]).toHaveProperty("count");
    });
  });

  describe("hooks info", () => {
    test("shows hook details", async () => {
      const { stdout } = await run("info", "gitguard");
      expect(stdout).toContain("Git Guard");
      expect(stdout).toContain("PreToolUse");
      expect(stdout).toContain("Bash");
      expect(stdout).toContain("Version");
    });

    test("errors on unknown hook", async () => {
      const { stdout } = await run("info", "nonexistent");
      expect(stdout).toContain("not found");
    });

    test("--json returns full hook metadata", async () => {
      const data = await runJson("info", "gitguard");
      expect(data.name).toBe("gitguard");
      expect(data.displayName).toBe("Git Guard");
      expect(data.event).toBe("PreToolUse");
      expect(data.version).toBe("0.1.0");
      expect(typeof data.global).toBe("boolean");
      expect(typeof data.project).toBe("boolean");
    });

    test("--json returns error for unknown hook", async () => {
      const data = await runJson("info", "nonexistent");
      expect(data.error).toContain("not found");
    });
  });

  describe("hooks install", () => {
    test("fails for nonexistent hook", async () => {
      const { stdout } = await run("install", "nonexistent");
      expect(stdout).toContain("not found");
    });

    test("--json shows install result", async () => {
      const data = await runJson("install", "nonexistent");
      expect(data.failed).toHaveLength(1);
      expect(data.failed[0].hook).toBe("nonexistent");
    });

    test("--all flag exists in help", async () => {
      const { stdout } = await run("install", "--help");
      expect(stdout).toContain("--all");
    });

    test("--category flag exists in help", async () => {
      const { stdout } = await run("install", "--help");
      expect(stdout).toContain("--category");
    });

    test("--category unknown --json returns error", async () => {
      const data = await runJson("install", "--category", "Fake");
      expect(data.error).toContain("Unknown category");
    });
  });

  describe("hooks remove", () => {
    test("fails for non-installed hook", async () => {
      const { stdout } = await run("remove", "nonexistent");
      expect(stdout).toContain("not installed");
    });

    test("--json returns removal result", async () => {
      const data = await runJson("remove", "nonexistent");
      expect(data.hook).toBe("nonexistent");
      expect(data.removed).toBe(false);
    });
  });

  describe("hooks doctor", () => {
    test("runs health check", async () => {
      const { stdout } = await run("doctor");
      expect(stdout).toContain("Hook Health Check");
    });

    test("--json returns structured result", async () => {
      const data = await runJson("doctor");
      expect(data).toHaveProperty("healthy");
      expect(data).toHaveProperty("issues");
      expect(data).toHaveProperty("registered");
      expect(data).toHaveProperty("scope");
      expect(Array.isArray(data.healthy)).toBe(true);
      expect(Array.isArray(data.issues)).toBe(true);
    });
  });

  describe("hooks update", () => {
    test("shows message when no hooks installed", async () => {
      // Run in a temp dir with no hooks
      const proc = Bun.spawn(["bun", "run", CLI, "update"], {
        stdout: "pipe",
        stderr: "pipe",
        cwd: tmpdir(),
        env: { ...process.env, NO_COLOR: "1" },
      });
      const stdout = await new Response(proc.stdout).text();
      await proc.exited;
      expect(stdout).toContain("No hooks installed");
    });

    test("--json returns empty when no hooks", async () => {
      const proc = Bun.spawn(["bun", "run", CLI, "update", "--json"], {
        stdout: "pipe",
        stderr: "pipe",
        cwd: tmpdir(),
        env: { ...process.env, NO_COLOR: "1" },
      });
      const stdout = await new Response(proc.stdout).text();
      await proc.exited;
      const data = JSON.parse(stdout.trim());
      expect(data.updated).toEqual([]);
    });
  });

  describe("hooks docs", () => {
    test("shows general documentation", async () => {
      const { stdout } = await run("docs");
      expect(stdout).toContain("Documentation");
      expect(stdout).toContain("How It Works");
      expect(stdout).toContain("Hook Events");
      expect(stdout).toContain("PreToolUse");
      expect(stdout).toContain("PostToolUse");
      expect(stdout).toContain("Stop");
      expect(stdout).toContain("Notification");
      expect(stdout).toContain("Installation");
      expect(stdout).toContain("Management");
    });

    test("--json returns structured docs", async () => {
      const data = await runJson("docs");
      expect(data).toHaveProperty("overview");
      expect(data).toHaveProperty("events");
      expect(data).toHaveProperty("installation");
      expect(data).toHaveProperty("management");
      expect(data).toHaveProperty("howItWorks");
      expect(data.events).toHaveProperty("PreToolUse");
      expect(data.events).toHaveProperty("PostToolUse");
      expect(data.events).toHaveProperty("Stop");
      expect(data.events).toHaveProperty("Notification");
    });

    test("shows hook-specific docs", async () => {
      const { stdout } = await run("docs", "gitguard");
      expect(stdout).toContain("Git Guard");
      expect(stdout).toContain("Configuration");
      expect(stdout).toContain("Install");
    });

    test("--json for specific hook includes readme", async () => {
      const data = await runJson("docs", "gitguard");
      expect(data.name).toBe("gitguard");
      expect(typeof data.readme).toBe("string");
    });

    test("errors on unknown hook", async () => {
      const { stdout } = await run("docs", "nonexistent");
      expect(stdout).toContain("not found");
    });

    test("--json error for unknown hook", async () => {
      const data = await runJson("docs", "nonexistent");
      expect(data.error).toContain("not found");
    });

    test("docs --json for hook with readme has content", async () => {
      const data = await runJson("docs", "checkpoint");
      expect(data.name).toBe("checkpoint");
      expect(data.readme.length).toBeGreaterThan(0);
    });

    test("docs --json howItWorks has all expected keys", async () => {
      const data = await runJson("docs");
      expect(data.howItWorks).toHaveProperty("install");
      expect(data.howItWorks).toHaveProperty("register");
      expect(data.howItWorks).toHaveProperty("execution");
      expect(data.howItWorks).toHaveProperty("noFileCopy");
    });
  });

  describe("hooks run", () => {
    test("errors for unknown hook", async () => {
      const { stderr, exitCode } = await run("run", "nonexistent");
      expect(exitCode).not.toBe(0);
      expect(stderr).toContain("not found");
    });

    test("run command exists in help", async () => {
      const { stdout } = await run("run", "--help");
      expect(stdout).toContain("Execute a hook");
    });
  });

  describe("hooks install --all (JSON)", () => {
    test("--all --json installs all 15 hooks", async () => {
      backupSettings();
      try {
        const data = await runJson("install", "--all");
        expect(data.total).toBe(15);
        expect(data.success).toBe(15);
        expect(data.installed).toHaveLength(15);
        expect(data.scope).toBe("global");
      } finally {
        restoreSettings();
      }
    });
  });

  describe("hooks install --category (JSON)", () => {
    test("installs all hooks in Git Safety category", async () => {
      backupSettings();
      try {
        const data = await runJson("install", "--category", "Git Safety");
        expect(data.installed).toContain("gitguard");
        expect(data.installed).toContain("branchprotect");
        expect(data.installed).toContain("checkpoint");
        expect(data.success).toBe(3);
      } finally {
        restoreSettings();
      }
    });
  });

  describe("hooks install + doctor + remove E2E", () => {
    test("full lifecycle via JSON", async () => {
      backupSettings();
      try {
        // Install
        const installData = await runJson("install", "gitguard", "packageage");
        expect(installData.success).toBe(2);
        expect(installData.installed).toContain("gitguard");
        expect(installData.installed).toContain("packageage");

        // Doctor
        const doctorData = await runJson("doctor");
        expect(doctorData.healthy).toContain("gitguard");
        expect(doctorData.healthy).toContain("packageage");
        expect(doctorData.issues).toHaveLength(0);

        // List installed
        const listData = await runJson("list", "--installed");
        const names = listData.map((h: any) => h.name);
        expect(names).toContain("gitguard");
        expect(names).toContain("packageage");

        // Info shows installed
        const infoData = await runJson("info", "gitguard");
        expect(infoData.global).toBe(true);

        // Remove one
        const removeData = await runJson("remove", "gitguard");
        expect(removeData.removed).toBe(true);

        // Verify removed
        const afterRemove = await runJson("list", "--installed");
        const afterNames = afterRemove.map((h: any) => h.name);
        expect(afterNames).not.toContain("gitguard");
        expect(afterNames).toContain("packageage");

        // Clean up
        await run("remove", "packageage");
      } finally {
        restoreSettings();
      }
    });
  });

  describe("hooks install scope flags", () => {
    test("--global flag exists in install help", async () => {
      const { stdout } = await run("install", "--help");
      expect(stdout).toContain("--global");
      expect(stdout).toContain("--project");
    });

    test("--global flag exists in remove help", async () => {
      const { stdout } = await run("remove", "--help");
      expect(stdout).toContain("--global");
      expect(stdout).toContain("--project");
    });

    test("--json install includes scope", async () => {
      const data = await runJson("install", "nonexistent");
      expect(data).toHaveProperty("scope");
      expect(data.scope).toBe("global");
    });

    test("--json remove includes scope", async () => {
      const data = await runJson("remove", "nonexistent");
      expect(data).toHaveProperty("scope");
      expect(data.scope).toBe("global");
    });
  });

  describe("hooks search --json structure", () => {
    test("each result has all HookMeta fields", async () => {
      const data = await runJson("search", "git");
      for (const hook of data) {
        expect(hook).toHaveProperty("name");
        expect(hook).toHaveProperty("displayName");
        expect(hook).toHaveProperty("description");
        expect(hook).toHaveProperty("version");
        expect(hook).toHaveProperty("category");
        expect(hook).toHaveProperty("event");
        expect(hook).toHaveProperty("matcher");
        expect(hook).toHaveProperty("tags");
      }
    });
  });

  describe("hooks list --json structure", () => {
    test("category list has all hook fields", async () => {
      const data = await runJson("list", "-c", "Git Safety");
      expect(data).toHaveLength(3);
      for (const hook of data) {
        expect(hook).toHaveProperty("name");
        expect(hook).toHaveProperty("version");
        expect(hook).toHaveProperty("event");
        expect(hook).toHaveProperty("tags");
      }
    });

    test("all-hooks list has all 5 categories as keys", async () => {
      const data = await runJson("list");
      expect(Object.keys(data)).toHaveLength(5);
      expect(data).toHaveProperty("Git Safety");
      expect(data).toHaveProperty("Code Quality");
      expect(data).toHaveProperty("Security");
      expect(data).toHaveProperty("Notifications");
      expect(data).toHaveProperty("Context Management");
    });
  });

  describe("hooks categories --json structure", () => {
    test("counts match actual hook counts", async () => {
      const data = await runJson("categories");
      const gitSafety = data.find((c: any) => c.name === "Git Safety");
      expect(gitSafety.count).toBe(3);
      const codeQuality = data.find((c: any) => c.name === "Code Quality");
      expect(codeQuality.count).toBe(6);
      const security = data.find((c: any) => c.name === "Security");
      expect(security.count).toBe(2);
    });
  });

  describe("hooks mcp", () => {
    test("mcp --help shows options", async () => {
      const { stdout } = await run("mcp", "--help");
      expect(stdout).toContain("--stdio");
      expect(stdout).toContain("--port");
      expect(stdout).toContain("MCP server");
    });
  });

  describe("hooks update with installed hooks", () => {
    test("updates installed hooks via JSON", async () => {
      backupSettings();
      try {
        await run("install", "gitguard", "checkpoint");
        const data = await runJson("update");
        expect(data.updated).toContain("gitguard");
        expect(data.updated).toContain("checkpoint");
        expect(data.failed).toHaveLength(0);
      } finally {
        restoreSettings();
      }
    });

    test("update specific hook via JSON", async () => {
      backupSettings();
      try {
        await run("install", "gitguard", "checkpoint");
        const data = await runJson("update", "gitguard");
        expect(data.updated).toContain("gitguard");
        expect(data.updated).not.toContain("checkpoint");
      } finally {
        restoreSettings();
      }
    });

    test("update non-installed hook fails", async () => {
      backupSettings();
      try {
        await run("install", "gitguard");
        const data = await runJson("update", "nonexistent");
        expect(data.failed).toHaveLength(1);
        expect(data.failed[0].error).toContain("Not installed");
      } finally {
        restoreSettings();
      }
    });
  });

  describe("hooks install + remove for each event type", () => {
    test("PreToolUse hook E2E", async () => {
      backupSettings();
      try {
        const install = await runJson("install", "gitguard");
        expect(install.success).toBe(1);
        const remove = await runJson("remove", "gitguard");
        expect(remove.removed).toBe(true);
      } finally {
        restoreSettings();
      }
    });

    test("PostToolUse hook E2E", async () => {
      backupSettings();
      try {
        const install = await runJson("install", "checktests");
        expect(install.success).toBe(1);
        const remove = await runJson("remove", "checktests");
        expect(remove.removed).toBe(true);
      } finally {
        restoreSettings();
      }
    });

    test("Stop hook E2E", async () => {
      backupSettings();
      try {
        const install = await runJson("install", "phonenotify");
        expect(install.success).toBe(1);
        const remove = await runJson("remove", "phonenotify");
        expect(remove.removed).toBe(true);
      } finally {
        restoreSettings();
      }
    });

    test("Notification hook E2E", async () => {
      backupSettings();
      try {
        const install = await runJson("install", "contextrefresh");
        expect(install.success).toBe(1);
        const remove = await runJson("remove", "contextrefresh");
        expect(remove.removed).toBe(true);
      } finally {
        restoreSettings();
      }
    });
  });

  describe("hooks docs for multiple hooks", () => {
    const sampleHooks = ["branchprotect", "checklint", "checksecurity", "phonenotify", "precompact"];

    for (const name of sampleHooks) {
      test(`docs --json for ${name} has metadata and readme`, async () => {
        const data = await runJson("docs", name);
        expect(data.name).toBe(name);
        expect(data.version).toMatch(/^\d+\.\d+\.\d+$/);
        expect(data.event).toBeTruthy();
        expect(typeof data.readme).toBe("string");
      });
    }
  });

  describe("hooks list --installed --json shows scope", () => {
    test("installed hooks include scope field", async () => {
      backupSettings();
      try {
        await run("install", "gitguard");
        const data = await runJson("list", "--installed");
        expect(data.length).toBeGreaterThanOrEqual(1);
        const hook = data.find((h: any) => h.name === "gitguard");
        expect(hook).toBeDefined();
        expect(hook.scope).toBe("global");
      } finally {
        restoreSettings();
      }
    });
  });

  describe("hooks install --category for all categories", () => {
    const categories = ["Code Quality", "Security", "Notifications", "Context Management"];
    const expectedCounts: Record<string, number> = {
      "Code Quality": 6,
      "Security": 2,
      "Notifications": 2,
      "Context Management": 2,
    };

    for (const cat of categories) {
      test(`--category "${cat}" installs ${expectedCounts[cat]} hooks`, async () => {
        backupSettings();
        try {
          const data = await runJson("install", "--category", cat);
          expect(data.success).toBe(expectedCounts[cat]);
        } finally {
          restoreSettings();
        }
      });
    }
  });

  describe("hooks install --all + remove --all E2E", () => {
    test("install all then verify and remove all", async () => {
      backupSettings();
      try {
        const install = await runJson("install", "--all");
        expect(install.success).toBe(15);

        const listed = await runJson("list", "--installed");
        expect(listed.length).toBeGreaterThanOrEqual(15);

        // Remove all one by one
        const allNames = install.installed as string[];
        for (const name of allNames) {
          const rm = await runJson("remove", name);
          expect(rm.removed).toBe(true);
        }
      } finally {
        restoreSettings();
      }
    });
  });

  describe("hooks info --json for every hook", () => {
    const allHooks = [
      "gitguard", "branchprotect", "checkpoint",
      "checktests", "checklint", "checkfiles",
      "checkbugs", "checkdocs", "checktasks",
      "checksecurity", "packageage",
      "phonenotify", "agentmessages",
      "contextrefresh", "precompact",
    ];

    for (const name of allHooks) {
      test(`info --json returns valid data for ${name}`, async () => {
        const data = await runJson("info", name);
        expect(data.name).toBe(name);
        expect(data.version).toMatch(/^\d+\.\d+\.\d+$/);
        expect(typeof data.global).toBe("boolean");
        expect(typeof data.project).toBe("boolean");
      });
    }
  });
});
