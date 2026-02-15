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
  removeHook,
  hookExists,
  getHookPath,
  getSettingsPath,
  type HookMeta,
  type Category,
  type InstallResult,
  type InstallOptions,
  type Scope,
  type Target,
} from "./index.js";

describe("library exports", () => {
  test("HOOKS is an array of 30 hooks", () => {
    expect(Array.isArray(HOOKS)).toBe(true);
    expect(HOOKS).toHaveLength(30);
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
});
