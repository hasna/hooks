/**
 * Tests for the library public API (src/index.ts).
 * Ensures all exported functions and types are accessible.
 */

import { describe, test, expect } from "bun:test";
import {
  HOOKS,
  CATEGORIES,
  getHook,
  getHooksByCategory,
  searchHooks,
  installHook,
  installHooks,
  getInstalledHooks,
  getRegisteredHooks,
  getRegisteredHooksForTarget,
  removeHook,
  hookExists,
  getHookPath,
  getSettingsPath,
  installHookForProject,
  installHooksForProject,
  listProjectHooks,
  removeProjectHook,
  runHook,
  type HookMeta,
  type Category,
  type InstallResult,
  type InstallOptions,
  type Scope,
  type Target,
  type HookInput,
  type HookOutput,
  type HookAgentInfo,
  type RunHookOptions,
  type RunHookResult,
} from "./index.js";

describe("library exports", () => {
  test("HOOKS is an array of 31 hooks", () => {
    expect(Array.isArray(HOOKS)).toBe(true);
    expect(HOOKS).toHaveLength(31);
  });

  test("CATEGORIES is an array of 10 categories", () => {
    expect(CATEGORIES).toHaveLength(10);
  });

  test("getHook is a function", () => {
    expect(typeof getHook).toBe("function");
    expect(getHook("gitguard")?.name).toBe("gitguard");
  });

  test("getHooksByCategory is a function", () => {
    expect(typeof getHooksByCategory).toBe("function");
    expect(getHooksByCategory("Git Safety")).toHaveLength(3);
  });

  test("searchHooks is a function", () => {
    expect(typeof searchHooks).toBe("function");
    expect(searchHooks("git").length).toBeGreaterThan(0);
  });

  test("installHook is a function", () => {
    expect(typeof installHook).toBe("function");
  });

  test("installHooks is a function", () => {
    expect(typeof installHooks).toBe("function");
  });

  test("getInstalledHooks is a function", () => {
    expect(typeof getInstalledHooks).toBe("function");
  });

  test("getRegisteredHooks is a function", () => {
    expect(typeof getRegisteredHooks).toBe("function");
  });

  test("removeHook is a function", () => {
    expect(typeof removeHook).toBe("function");
  });

  test("hookExists is a function", () => {
    expect(typeof hookExists).toBe("function");
  });

  test("getHookPath is a function", () => {
    expect(typeof getHookPath).toBe("function");
  });

  test("getSettingsPath is a function", () => {
    expect(typeof getSettingsPath).toBe("function");
  });

  test("getRegisteredHooksForTarget is a function", () => {
    expect(typeof getRegisteredHooksForTarget).toBe("function");
  });

  test("installHookForProject is a function", () => {
    expect(typeof installHookForProject).toBe("function");
  });

  test("installHooksForProject is a function", () => {
    expect(typeof installHooksForProject).toBe("function");
  });

  test("listProjectHooks is a function", () => {
    expect(typeof listProjectHooks).toBe("function");
    expect(Array.isArray(listProjectHooks())).toBe(true);
  });

  test("removeProjectHook is a function", () => {
    expect(typeof removeProjectHook).toBe("function");
  });

  test("runHook is a function", () => {
    expect(typeof runHook).toBe("function");
  });
});
