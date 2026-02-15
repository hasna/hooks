import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, readFileSync, writeFileSync, mkdirSync, rmSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import {
  installHook,
  installHooks,
  getInstalledHooks,
  getRegisteredHooks,
  removeHook,
  hookExists,
  getHookPath,
  getSettingsPath,
} from "./installer.js";

const GLOBAL_SETTINGS = join(homedir(), ".claude", "settings.json");

let settingsBackup: string | null = null;

function backupSettings(): void {
  if (existsSync(GLOBAL_SETTINGS)) {
    settingsBackup = readFileSync(GLOBAL_SETTINGS, "utf-8");
  } else {
    settingsBackup = null;
  }
}

function restoreSettings(): void {
  if (settingsBackup !== null) {
    writeFileSync(GLOBAL_SETTINGS, settingsBackup);
  } else if (existsSync(GLOBAL_SETTINGS)) {
    // Clean up only our test hooks
    try {
      const settings = JSON.parse(readFileSync(GLOBAL_SETTINGS, "utf-8"));
      if (settings.hooks) {
        for (const eventKey of Object.keys(settings.hooks)) {
          settings.hooks[eventKey] = settings.hooks[eventKey].filter(
            (entry: any) =>
              !entry.hooks?.some((h: any) =>
                /hooks run (gitguard|checkpoint|packageage|branchprotect)/.test(h.command || "")
              )
          );
          if (settings.hooks[eventKey].length === 0) delete settings.hooks[eventKey];
        }
        if (Object.keys(settings.hooks).length === 0) delete settings.hooks;
      }
      writeFileSync(GLOBAL_SETTINGS, JSON.stringify(settings, null, 2) + "\n");
    } catch {}
  }
}

beforeEach(() => {
  backupSettings();
});

afterEach(() => {
  restoreSettings();
});

describe("installer", () => {
  describe("getSettingsPath", () => {
    test("global returns ~/.claude/settings.json", () => {
      expect(getSettingsPath("global")).toBe(join(homedir(), ".claude", "settings.json"));
    });

    test("project returns .claude/settings.json in cwd", () => {
      expect(getSettingsPath("project")).toBe(join(process.cwd(), ".claude", "settings.json"));
    });
  });

  describe("getHookPath", () => {
    test("returns path for short name", () => {
      const path = getHookPath("gitguard");
      expect(path).toContain("hook-gitguard");
    });

    test("returns path for prefixed name", () => {
      const path = getHookPath("hook-gitguard");
      expect(path).toContain("hook-gitguard");
      expect(path).not.toContain("hook-hook-");
    });
  });

  describe("hookExists", () => {
    test("returns true for existing hook", () => {
      expect(hookExists("gitguard")).toBe(true);
    });

    test("returns true with hook- prefix", () => {
      expect(hookExists("hook-gitguard")).toBe(true);
    });

    test("returns false for nonexistent hook", () => {
      expect(hookExists("nonexistent")).toBe(false);
    });

    test("returns true for all 30 registered hooks", () => {
      const names = [
        "gitguard", "branchprotect", "checkpoint",
        "checktests", "checklint", "checkfiles",
        "checkbugs", "checkdocs", "checktasks",
        "checksecurity", "packageage",
        "phonenotify", "agentmessages",
        "contextrefresh", "precompact",
        "autoformat", "autostage", "tddguard",
        "envsetup",
        "permissionguard", "protectfiles", "promptguard",
        "desktopnotify", "slacknotify", "soundnotify",
        "sessionlog", "commandlog", "costwatch", "errornotify",
        "taskgate",
      ];
      expect(names).toHaveLength(30);
      for (const name of names) {
        expect(hookExists(name)).toBe(true);
      }
    });
  });

  describe("installHook", () => {
    test("registers hook in global settings", () => {
      const result = installHook("gitguard");
      expect(result.success).toBe(true);
      expect(result.hook).toBe("gitguard");
      expect(result.scope).toBe("global");
    });

    test("writes hooks run command to settings", () => {
      installHook("gitguard");
      const settings = JSON.parse(readFileSync(GLOBAL_SETTINGS, "utf-8"));
      expect(settings.hooks).toBeDefined();
      expect(settings.hooks.PreToolUse).toBeDefined();
      const found = settings.hooks.PreToolUse.some((entry: any) =>
        entry.hooks?.some((h: any) => h.command === "hooks run gitguard")
      );
      expect(found).toBe(true);
    });

    test("registers with correct matcher", () => {
      installHook("gitguard");
      const settings = JSON.parse(readFileSync(GLOBAL_SETTINGS, "utf-8"));
      const entry = settings.hooks.PreToolUse.find((e: any) =>
        e.hooks?.some((h: any) => h.command === "hooks run gitguard")
      );
      expect(entry.matcher).toBe("Bash");
    });

    test("does not copy any files", () => {
      installHook("gitguard");
      expect(existsSync(join(process.cwd(), ".hooks"))).toBe(false);
    });

    test("fails for nonexistent hook", () => {
      const result = installHook("nonexistent");
      expect(result.success).toBe(false);
      expect(result.error).toContain("not found");
    });

    test("fails if already installed without overwrite", () => {
      installHook("gitguard");
      const result = installHook("gitguard");
      expect(result.success).toBe(false);
      expect(result.error).toContain("Already installed");
    });

    test("succeeds with overwrite", () => {
      installHook("gitguard");
      const result = installHook("gitguard", { overwrite: true });
      expect(result.success).toBe(true);
    });

    test("does not duplicate on overwrite", () => {
      installHook("gitguard");
      installHook("gitguard", { overwrite: true });
      const settings = JSON.parse(readFileSync(GLOBAL_SETTINGS, "utf-8"));
      const matches = settings.hooks.PreToolUse.filter((e: any) =>
        e.hooks?.some((h: any) => h.command === "hooks run gitguard")
      );
      expect(matches).toHaveLength(1);
    });

    test("accepts hook- prefixed name", () => {
      const result = installHook("hook-gitguard");
      expect(result.success).toBe(true);
      expect(result.hook).toBe("gitguard");
    });
  });

  describe("installHooks", () => {
    test("installs multiple hooks", () => {
      const results = installHooks(["gitguard", "checkpoint"]);
      expect(results).toHaveLength(2);
      expect(results[0].success).toBe(true);
      expect(results[1].success).toBe(true);
    });

    test("returns mixed results for valid and invalid hooks", () => {
      const results = installHooks(["gitguard", "nonexistent"]);
      expect(results).toHaveLength(2);
      expect(results[0].success).toBe(true);
      expect(results[1].success).toBe(false);
    });
  });

  describe("getRegisteredHooks / getInstalledHooks", () => {
    test("returns empty when no hooks installed", () => {
      expect(getRegisteredHooks()).not.toContain("gitguard");
    });

    test("returns hook after install", () => {
      installHook("gitguard");
      expect(getRegisteredHooks()).toContain("gitguard");
    });

    test("getInstalledHooks is alias for getRegisteredHooks", () => {
      installHook("gitguard");
      expect(getInstalledHooks()).toEqual(getRegisteredHooks());
    });

    test("returns unique names", () => {
      installHook("gitguard");
      const hooks = getRegisteredHooks();
      const gitguardCount = hooks.filter((n) => n === "gitguard").length;
      expect(gitguardCount).toBe(1);
    });
  });

  describe("removeHook", () => {
    test("removes registered hook", () => {
      installHook("gitguard");
      expect(getRegisteredHooks()).toContain("gitguard");
      const removed = removeHook("gitguard");
      expect(removed).toBe(true);
      expect(getRegisteredHooks()).not.toContain("gitguard");
    });

    test("returns false for non-registered hook", () => {
      expect(removeHook("nonexistent")).toBe(false);
    });

    test("cleans up empty hooks object", () => {
      installHook("gitguard");
      removeHook("gitguard");
      const settings = JSON.parse(readFileSync(GLOBAL_SETTINGS, "utf-8"));
      // PreToolUse might still exist with other hooks, but gitguard should be gone
      if (settings.hooks?.PreToolUse) {
        const found = settings.hooks.PreToolUse.some((e: any) =>
          e.hooks?.some((h: any) => h.command === "hooks run gitguard")
        );
        expect(found).toBe(false);
      }
    });

    test("accepts hook- prefixed name", () => {
      installHook("gitguard");
      const removed = removeHook("hook-gitguard");
      expect(removed).toBe(true);
    });
  });

  describe("event type registration", () => {
    test("PreToolUse hook registers under PreToolUse", () => {
      installHook("gitguard"); // PreToolUse
      const settings = JSON.parse(readFileSync(GLOBAL_SETTINGS, "utf-8"));
      expect(settings.hooks.PreToolUse).toBeDefined();
      expect(settings.hooks.PostToolUse).toBeUndefined();
    });

    test("PostToolUse hook registers under PostToolUse", () => {
      installHook("checktests"); // PostToolUse
      const settings = JSON.parse(readFileSync(GLOBAL_SETTINGS, "utf-8"));
      expect(settings.hooks.PostToolUse).toBeDefined();
      const found = settings.hooks.PostToolUse.some((e: any) =>
        e.hooks?.some((h: any) => h.command === "hooks run checktests")
      );
      expect(found).toBe(true);
    });

    test("Stop hook registers under Stop", () => {
      installHook("phonenotify"); // Stop
      const settings = JSON.parse(readFileSync(GLOBAL_SETTINGS, "utf-8"));
      expect(settings.hooks.Stop).toBeDefined();
      const found = settings.hooks.Stop.some((e: any) =>
        e.hooks?.some((h: any) => h.command === "hooks run phonenotify")
      );
      expect(found).toBe(true);
    });

    test("Notification hook registers under Notification", () => {
      installHook("contextrefresh"); // Notification
      const settings = JSON.parse(readFileSync(GLOBAL_SETTINGS, "utf-8"));
      expect(settings.hooks.Notification).toBeDefined();
      const found = settings.hooks.Notification.some((e: any) =>
        e.hooks?.some((h: any) => h.command === "hooks run contextrefresh")
      );
      expect(found).toBe(true);
    });

    test("hooks with no matcher omit matcher field", () => {
      installHook("phonenotify"); // matcher is ""
      const settings = JSON.parse(readFileSync(GLOBAL_SETTINGS, "utf-8"));
      const entry = settings.hooks.Stop.find((e: any) =>
        e.hooks?.some((h: any) => h.command === "hooks run phonenotify")
      );
      expect(entry.matcher).toBeUndefined();
    });

    test("multiple hooks across different events", () => {
      installHook("gitguard");       // PreToolUse
      installHook("checktests");     // PostToolUse
      installHook("phonenotify");    // Stop
      installHook("contextrefresh"); // Notification
      const settings = JSON.parse(readFileSync(GLOBAL_SETTINGS, "utf-8"));
      expect(Object.keys(settings.hooks)).toContain("PreToolUse");
      expect(Object.keys(settings.hooks)).toContain("PostToolUse");
      expect(Object.keys(settings.hooks)).toContain("Stop");
      expect(Object.keys(settings.hooks)).toContain("Notification");
    });
  });

  describe("backwards compatibility", () => {
    test("detects old format hook-<name> in settings", () => {
      // Manually write old format
      const settings = existsSync(GLOBAL_SETTINGS)
        ? JSON.parse(readFileSync(GLOBAL_SETTINGS, "utf-8"))
        : {};
      if (!settings.hooks) settings.hooks = {};
      if (!settings.hooks.PreToolUse) settings.hooks.PreToolUse = [];
      settings.hooks.PreToolUse.push({
        hooks: [{ type: "command", command: "hook-gitguard" }],
        matcher: "Bash",
      });
      writeFileSync(GLOBAL_SETTINGS, JSON.stringify(settings, null, 2) + "\n");

      const registered = getRegisteredHooks();
      expect(registered).toContain("gitguard");
    });
  });

  describe("install + remove roundtrip", () => {
    test("install all 30 hooks then remove all", () => {
      const allNames = [
        "gitguard", "branchprotect", "checkpoint",
        "checktests", "checklint", "checkfiles",
        "checkbugs", "checkdocs", "checktasks",
        "checksecurity", "packageage",
        "phonenotify", "agentmessages",
        "contextrefresh", "precompact",
        "autoformat", "autostage", "tddguard",
        "envsetup",
        "permissionguard", "protectfiles", "promptguard",
        "desktopnotify", "slacknotify", "soundnotify",
        "sessionlog", "commandlog", "costwatch", "errornotify",
        "taskgate",
      ];
      const results = installHooks(allNames);
      expect(results.every((r) => r.success)).toBe(true);
      expect(getRegisteredHooks().length).toBeGreaterThanOrEqual(30);

      for (const name of allNames) {
        expect(removeHook(name)).toBe(true);
      }
      // All our hooks should be gone
      for (const name of allNames) {
        expect(getRegisteredHooks()).not.toContain(name);
      }
    });

    test("removing one hook does not affect others", () => {
      installHook("gitguard");
      installHook("checkpoint");
      removeHook("gitguard");
      expect(getRegisteredHooks()).not.toContain("gitguard");
      expect(getRegisteredHooks()).toContain("checkpoint");
    });
  });

  describe("settings preservation", () => {
    test("install preserves existing non-hook settings", () => {
      // Write custom setting
      const settings = existsSync(GLOBAL_SETTINGS)
        ? JSON.parse(readFileSync(GLOBAL_SETTINGS, "utf-8"))
        : {};
      settings.customKey = "testValue";
      writeFileSync(GLOBAL_SETTINGS, JSON.stringify(settings, null, 2) + "\n");

      installHook("gitguard");
      const after = JSON.parse(readFileSync(GLOBAL_SETTINGS, "utf-8"));
      expect(after.customKey).toBe("testValue");
    });

    test("remove preserves existing non-hook settings", () => {
      const settings = existsSync(GLOBAL_SETTINGS)
        ? JSON.parse(readFileSync(GLOBAL_SETTINGS, "utf-8"))
        : {};
      settings.customKey = "testValue";
      writeFileSync(GLOBAL_SETTINGS, JSON.stringify(settings, null, 2) + "\n");

      installHook("gitguard");
      removeHook("gitguard");
      const after = JSON.parse(readFileSync(GLOBAL_SETTINGS, "utf-8"));
      expect(after.customKey).toBe("testValue");
    });
  });

  describe("project scope", () => {
    const projectSettings = join(process.cwd(), ".claude", "settings.json");
    let projectBackup: string | null = null;

    beforeEach(() => {
      if (existsSync(projectSettings)) {
        projectBackup = readFileSync(projectSettings, "utf-8");
      } else {
        projectBackup = null;
      }
      // Start each test with clean project settings
      writeFileSync(projectSettings, "{}\n");
    });

    afterEach(() => {
      if (projectBackup !== null) {
        writeFileSync(projectSettings, projectBackup);
      } else if (existsSync(projectSettings)) {
        writeFileSync(projectSettings, "{}\n");
      }
    });

    test("installHook with project scope writes to project settings", () => {
      const result = installHook("gitguard", { scope: "project" });
      expect(result.success).toBe(true);
      expect(result.scope).toBe("project");
      expect(existsSync(projectSettings)).toBe(true);
      const settings = JSON.parse(readFileSync(projectSettings, "utf-8"));
      const found = settings.hooks?.PreToolUse?.some((e: any) =>
        e.hooks?.some((h: any) => h.command === "hooks run gitguard")
      );
      expect(found).toBe(true);
    });

    test("getRegisteredHooks with project scope reads project settings", () => {
      installHook("gitguard", { scope: "project" });
      const projectHooks = getRegisteredHooks("project");
      expect(projectHooks).toContain("gitguard");
    });

    test("removeHook with project scope removes from project settings", () => {
      installHook("gitguard", { scope: "project" });
      const removed = removeHook("gitguard", "project");
      expect(removed).toBe(true);
      expect(getRegisteredHooks("project")).not.toContain("gitguard");
    });

    test("global and project scopes are independent", () => {
      installHook("gitguard", { scope: "global" });
      installHook("checkpoint", { scope: "project" });
      expect(getRegisteredHooks("global")).toContain("gitguard");
      expect(getRegisteredHooks("global")).not.toContain("checkpoint");
      expect(getRegisteredHooks("project")).toContain("checkpoint");
      expect(getRegisteredHooks("project")).not.toContain("gitguard");
    });

    test("same hook can be in both scopes", () => {
      installHook("gitguard", { scope: "global" });
      installHook("gitguard", { scope: "project" });
      expect(getRegisteredHooks("global")).toContain("gitguard");
      expect(getRegisteredHooks("project")).toContain("gitguard");
    });

    test("installHooks with project scope", () => {
      const results = installHooks(["gitguard", "checkpoint"], { scope: "project" });
      expect(results.every((r) => r.success)).toBe(true);
      expect(getRegisteredHooks("project")).toContain("gitguard");
      expect(getRegisteredHooks("project")).toContain("checkpoint");
    });
  });

  describe("getSettingsPath default", () => {
    test("defaults to global when no argument", () => {
      expect(getSettingsPath()).toBe(join(homedir(), ".claude", "settings.json"));
    });

    test("gemini global path", () => {
      expect(getSettingsPath("global", "gemini")).toBe(join(homedir(), ".gemini", "settings.json"));
    });

    test("gemini project path", () => {
      expect(getSettingsPath("project", "gemini")).toBe(join(process.cwd(), ".gemini", "settings.json"));
    });
  });

  describe("installHooks edge cases", () => {
    test("empty array returns empty results", () => {
      const results = installHooks([]);
      expect(results).toHaveLength(0);
    });

    test("all invalid hooks returns all failures", () => {
      const results = installHooks(["fake1", "fake2", "fake3"]);
      expect(results.every((r) => !r.success)).toBe(true);
    });
  });

  describe("hook source files", () => {
    const ALL_30_NAMES = [
      "gitguard", "branchprotect", "checkpoint",
      "checktests", "checklint", "checkfiles",
      "checkbugs", "checkdocs", "checktasks",
      "checksecurity", "packageage",
      "phonenotify", "agentmessages",
      "contextrefresh", "precompact",
      "autoformat", "autostage", "tddguard",
      "envsetup",
      "permissionguard", "protectfiles", "promptguard",
      "desktopnotify", "slacknotify", "soundnotify",
      "sessionlog", "commandlog", "costwatch", "errornotify",
      "taskgate",
    ];

    test("every hook has src/hook.ts in package (except agentmessages)", () => {
      for (const name of ALL_30_NAMES) {
        if (name === "agentmessages") continue; // uses different file structure
        const hookScript = join(getHookPath(name), "src", "hook.ts");
        expect(existsSync(hookScript)).toBe(true);
      }
    });

    test("every hook has package.json in package", () => {
      for (const name of ALL_30_NAMES) {
        const pkgJson = join(getHookPath(name), "package.json");
        expect(existsSync(pkgJson)).toBe(true);
      }
    });

    test("every hook has README.md in package", () => {
      for (const name of ALL_30_NAMES) {
        const readme = join(getHookPath(name), "README.md");
        expect(existsSync(readme)).toBe(true);
      }
    });
  });

  describe("target: all", () => {
    test("installHook with target all returns target all", () => {
      const result = installHook("gitguard", { target: "all" });
      expect(result.success).toBe(true);
      expect(result.target).toBe("all");
    });

    test("removeHook with target all", () => {
      installHook("gitguard", { target: "all" });
      const removed = removeHook("gitguard", "global", "all");
      expect(removed).toBe(true);
    });
  });

  describe("corrupt settings", () => {
    test("readSettings handles corrupt JSON gracefully", () => {
      // Write corrupt JSON to settings
      writeFileSync(GLOBAL_SETTINGS, "{ broken json !!!");
      // Should not throw, returns empty or fallback
      const hooks = getRegisteredHooks();
      expect(Array.isArray(hooks)).toBe(true);
    });

    test("installHook creates settings from scratch when corrupt", () => {
      writeFileSync(GLOBAL_SETTINGS, "not valid json");
      const result = installHook("gitguard");
      expect(result.success).toBe(true);
    });
  });

  describe("new hooks install correctly", () => {
    const newHooks = [
      { name: "autoformat", event: "PostToolUse", matcher: "Edit|Write" },
      { name: "autostage", event: "PostToolUse", matcher: "Edit|Write" },
      { name: "tddguard", event: "PreToolUse", matcher: "Edit|Write" },
      { name: "envsetup", event: "PreToolUse", matcher: "Bash" },
      { name: "permissionguard", event: "PreToolUse", matcher: "Bash" },
      { name: "protectfiles", event: "PreToolUse", matcher: "Edit|Write|Read|Bash" },
      { name: "promptguard", event: "PreToolUse", matcher: "" },
      { name: "desktopnotify", event: "Stop", matcher: "" },
      { name: "slacknotify", event: "Stop", matcher: "" },
      { name: "soundnotify", event: "Stop", matcher: "" },
      { name: "sessionlog", event: "PostToolUse", matcher: "" },
      { name: "commandlog", event: "PostToolUse", matcher: "Bash" },
      { name: "costwatch", event: "Stop", matcher: "" },
      { name: "errornotify", event: "PostToolUse", matcher: "" },
      { name: "taskgate", event: "PostToolUse", matcher: "" },
    ];

    for (const { name, event } of newHooks) {
      test(`${name} installs under ${event}`, () => {
        const result = installHook(name);
        expect(result.success).toBe(true);
        const settings = JSON.parse(readFileSync(GLOBAL_SETTINGS, "utf-8"));
        expect(settings.hooks[event]).toBeDefined();
        const found = settings.hooks[event].some((e: any) =>
          e.hooks?.some((h: any) => h.command === `hooks run ${name}`)
        );
        expect(found).toBe(true);
      });
    }
  });
});
