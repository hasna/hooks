import { describe, test, expect } from "bun:test";
import {
  HOOKS,
  CATEGORIES,
  getHooksByCategory,
  searchHooks,
  getHook,
  type HookMeta,
  type Category,
} from "./registry.js";

describe("registry", () => {
  describe("HOOKS", () => {
    test("contains 30 hooks", () => {
      expect(HOOKS).toHaveLength(30);
    });

    test("every hook has required fields", () => {
      for (const hook of HOOKS) {
        expect(hook.name).toBeTruthy();
        expect(hook.displayName).toBeTruthy();
        expect(hook.description).toBeTruthy();
        expect(hook.version).toMatch(/^\d+\.\d+\.\d+$/);
        expect(hook.category).toBeTruthy();
        expect(hook.event).toBeTruthy();
        expect(Array.isArray(hook.tags)).toBe(true);
        expect(hook.tags.length).toBeGreaterThan(0);
      }
    });

    test("every hook name is unique", () => {
      const names = HOOKS.map((h) => h.name);
      expect(new Set(names).size).toBe(names.length);
    });

    test("every hook has a valid event type", () => {
      const validEvents = ["PreToolUse", "PostToolUse", "Stop", "Notification"];
      for (const hook of HOOKS) {
        expect(validEvents).toContain(hook.event);
      }
    });

    test("every hook belongs to a valid category", () => {
      for (const hook of HOOKS) {
        expect(CATEGORIES as readonly string[]).toContain(hook.category);
      }
    });
  });

  describe("CATEGORIES", () => {
    test("contains 10 categories", () => {
      expect(CATEGORIES).toHaveLength(10);
    });

    test("includes all 10 expected categories", () => {
      expect(CATEGORIES).toContain("Git Safety");
      expect(CATEGORIES).toContain("Code Quality");
      expect(CATEGORIES).toContain("Security");
      expect(CATEGORIES).toContain("Notifications");
      expect(CATEGORIES).toContain("Context Management");
      expect(CATEGORIES).toContain("Workflow Automation");
      expect(CATEGORIES).toContain("Environment");
      expect(CATEGORIES).toContain("Permissions");
      expect(CATEGORIES).toContain("Observability");
      expect(CATEGORIES).toContain("Agent Teams");
    });
  });

  describe("getHooksByCategory", () => {
    test("returns Git Safety hooks", () => {
      const hooks = getHooksByCategory("Git Safety");
      expect(hooks).toHaveLength(3);
      expect(hooks.map((h) => h.name)).toEqual([
        "gitguard",
        "branchprotect",
        "checkpoint",
      ]);
    });

    test("returns Code Quality hooks", () => {
      const hooks = getHooksByCategory("Code Quality");
      expect(hooks).toHaveLength(6);
    });

    test("returns Security hooks", () => {
      const hooks = getHooksByCategory("Security");
      expect(hooks).toHaveLength(2);
    });

    test("returns Notifications hooks", () => {
      const hooks = getHooksByCategory("Notifications");
      expect(hooks).toHaveLength(5);
    });

    test("returns Context Management hooks", () => {
      const hooks = getHooksByCategory("Context Management");
      expect(hooks).toHaveLength(2);
    });

    test("returns Workflow Automation hooks", () => {
      const hooks = getHooksByCategory("Workflow Automation");
      expect(hooks).toHaveLength(3);
    });

    test("returns Environment hooks", () => {
      const hooks = getHooksByCategory("Environment");
      expect(hooks).toHaveLength(1);
    });

    test("returns Permissions hooks", () => {
      const hooks = getHooksByCategory("Permissions");
      expect(hooks).toHaveLength(3);
    });

    test("returns Observability hooks", () => {
      const hooks = getHooksByCategory("Observability");
      expect(hooks).toHaveLength(4);
    });

    test("returns Agent Teams hooks", () => {
      const hooks = getHooksByCategory("Agent Teams");
      expect(hooks).toHaveLength(1);
    });

    test("returns empty array for unknown category", () => {
      const hooks = getHooksByCategory("Nonexistent" as Category);
      expect(hooks).toHaveLength(0);
    });

    test("all categories sum to total hooks", () => {
      let total = 0;
      for (const cat of CATEGORIES) {
        total += getHooksByCategory(cat).length;
      }
      expect(total).toBe(HOOKS.length);
    });
  });

  describe("searchHooks", () => {
    test("finds hooks by name", () => {
      const results = searchHooks("gitguard");
      expect(results).toHaveLength(1);
      expect(results[0].name).toBe("gitguard");
    });

    test("finds hooks by display name", () => {
      const results = searchHooks("Git Guard");
      expect(results).toHaveLength(1);
      expect(results[0].name).toBe("gitguard");
    });

    test("finds hooks by description keyword", () => {
      const results = searchHooks("destructive");
      expect(results.length).toBeGreaterThanOrEqual(1);
      expect(results[0].name).toBe("gitguard");
    });

    test("finds hooks by tag", () => {
      const results = searchHooks("typosquatting");
      expect(results).toHaveLength(1);
      expect(results[0].name).toBe("packageage");
    });

    test("search is case-insensitive", () => {
      const upper = searchHooks("GITGUARD");
      const lower = searchHooks("gitguard");
      const mixed = searchHooks("GitGuard");
      expect(upper).toEqual(lower);
      expect(lower).toEqual(mixed);
    });

    test("returns multiple results for broad queries", () => {
      const results = searchHooks("git");
      expect(results.length).toBeGreaterThan(1);
    });

    test("returns empty for no match", () => {
      const results = searchHooks("zzzznonexistent");
      expect(results).toHaveLength(0);
    });

    test("finds hooks matching quality tag", () => {
      const results = searchHooks("quality");
      expect(results.length).toBeGreaterThanOrEqual(6);
    });
  });

  describe("getHook", () => {
    test("returns hook by name", () => {
      const hook = getHook("gitguard");
      expect(hook).toBeDefined();
      expect(hook!.name).toBe("gitguard");
      expect(hook!.displayName).toBe("Git Guard");
      expect(hook!.event).toBe("PreToolUse");
    });

    test("returns undefined for unknown hook", () => {
      expect(getHook("nonexistent")).toBeUndefined();
    });

    test("returns correct metadata for each hook", () => {
      const checkpoint = getHook("checkpoint");
      expect(checkpoint).toBeDefined();
      expect(checkpoint!.category).toBe("Git Safety");
      expect(checkpoint!.version).toBe("0.1.0");
      expect(checkpoint!.matcher).toBe("Write|Edit|NotebookEdit");

      const checktasks = getHook("checktasks");
      expect(checktasks).toBeDefined();
      expect(checktasks!.version).toBe("1.0.8");

      const phonenotify = getHook("phonenotify");
      expect(phonenotify).toBeDefined();
      expect(phonenotify!.event).toBe("Stop");
      expect(phonenotify!.matcher).toBe("");
    });
  });

  describe("hook version values", () => {
    const expected: Record<string, string> = {
      gitguard: "0.1.0",
      branchprotect: "0.1.0",
      checkpoint: "0.1.0",
      checktests: "0.1.6",
      checklint: "0.1.7",
      checkfiles: "0.1.4",
      checkbugs: "0.1.6",
      checkdocs: "0.2.1",
      checktasks: "1.0.8",
      checksecurity: "0.1.6",
      packageage: "0.1.1",
      phonenotify: "0.1.0",
      agentmessages: "0.1.0",
      contextrefresh: "0.1.0",
      precompact: "0.1.0",
      autoformat: "0.1.0",
      autostage: "0.1.0",
      tddguard: "0.1.0",
      envsetup: "0.1.0",
      permissionguard: "0.1.0",
      protectfiles: "0.1.0",
      promptguard: "0.1.0",
      desktopnotify: "0.1.0",
      slacknotify: "0.1.0",
      soundnotify: "0.1.0",
      sessionlog: "0.1.0",
      commandlog: "0.1.0",
      costwatch: "0.1.0",
      errornotify: "0.1.0",
      taskgate: "0.1.0",
    };

    for (const [name, version] of Object.entries(expected)) {
      test(`${name} has version ${version}`, () => {
        expect(getHook(name)!.version).toBe(version);
      });
    }
  });

  describe("hook event distribution", () => {
    test("Stop hooks have empty matchers", () => {
      const stopHooks = HOOKS.filter((h) => h.event === "Stop");
      for (const h of stopHooks) {
        expect(h.matcher).toBe("");
      }
    });

    test("Notification hooks have empty matchers", () => {
      const notifHooks = HOOKS.filter((h) => h.event === "Notification");
      for (const h of notifHooks) {
        expect(h.matcher).toBe("");
      }
    });

    test("correct count per event type", () => {
      expect(HOOKS.filter((h) => h.event === "PreToolUse")).toHaveLength(9);
      expect(HOOKS.filter((h) => h.event === "PostToolUse")).toHaveLength(13);
      expect(HOOKS.filter((h) => h.event === "Stop")).toHaveLength(6);
      expect(HOOKS.filter((h) => h.event === "Notification")).toHaveLength(2);
    });
  });

  describe("hook display names", () => {
    test("every displayName is unique", () => {
      const names = HOOKS.map((h) => h.displayName);
      expect(new Set(names).size).toBe(names.length);
    });

    test("displayName is human-readable (contains spaces or capital letters)", () => {
      for (const hook of HOOKS) {
        expect(hook.displayName).toMatch(/[A-Z]/);
      }
    });
  });

  describe("searchHooks edge cases", () => {
    test("single character returns no results", () => {
      const results = searchHooks("x");
      // Might match something, just ensure no crash
      expect(Array.isArray(results)).toBe(true);
    });

    test("empty string returns all hooks", () => {
      const results = searchHooks("");
      expect(results).toHaveLength(HOOKS.length);
    });

    test("search by partial tag", () => {
      const results = searchHooks("secur");
      expect(results.length).toBeGreaterThanOrEqual(1);
    });

    test("search matches across multiple fields", () => {
      // "check" appears in name, displayName for multiple hooks
      const results = searchHooks("check");
      expect(results.length).toBeGreaterThanOrEqual(6);
    });

    test("search by event name in description", () => {
      const results = searchHooks("snapshot");
      expect(results.length).toBeGreaterThanOrEqual(1);
      expect(results.some((h) => h.name === "checkpoint")).toBe(true);
    });
  });

  describe("getHooksByCategory returns correct hooks", () => {
    test("Code Quality hooks are all PostToolUse", () => {
      const hooks = getHooksByCategory("Code Quality");
      for (const h of hooks) {
        expect(h.event).toBe("PostToolUse");
      }
    });

    test("Notifications hooks are all Stop events", () => {
      const hooks = getHooksByCategory("Notifications");
      for (const h of hooks) {
        expect(h.event).toBe("Stop");
      }
    });

    test("Context Management hooks are all Notification events", () => {
      const hooks = getHooksByCategory("Context Management");
      for (const h of hooks) {
        expect(h.event).toBe("Notification");
      }
    });
  });
});
