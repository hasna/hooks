import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeDb } from "./db/index.js";
import {
  HOOKS_STORAGE_ENV,
  HOOKS_STORAGE_FALLBACK_ENV,
  HOOKS_STORAGE_MODE_ENV,
  HOOKS_STORAGE_MODE_FALLBACK_ENV,
  STORAGE_TABLES,
  getStorageDatabaseEnv,
  getStorageDatabaseUrl,
  getStorageMode,
  getStorageStatus,
  parseStorageTables,
  resolveTables,
} from "./storage.js";

const ENV_KEYS = [
  HOOKS_STORAGE_ENV,
  HOOKS_STORAGE_FALLBACK_ENV,
  HOOKS_STORAGE_MODE_ENV,
  HOOKS_STORAGE_MODE_FALLBACK_ENV,
  "HASNA_HOOKS_DB_PATH",
] as const;

afterEach(() => {
  closeDb();
  for (const key of ENV_KEYS) delete process.env[key];
});

describe("hooks storage config", () => {
  test("resolves canonical database env, fallback env, and storage mode", () => {
    for (const key of ENV_KEYS) delete process.env[key];
    expect(getStorageDatabaseEnv()).toBeNull();
    expect(getStorageDatabaseUrl()).toBeNull();
    expect(getStorageMode()).toBe("local");

    process.env[HOOKS_STORAGE_FALLBACK_ENV] = "postgres://fallback/hooks";
    expect(getStorageDatabaseEnv()?.name).toBe(HOOKS_STORAGE_FALLBACK_ENV);
    expect(getStorageDatabaseUrl()).toBe("postgres://fallback/hooks");
    expect(getStorageMode()).toBe("hybrid");

    process.env[HOOKS_STORAGE_ENV] = "postgres://primary/hooks";
    expect(getStorageDatabaseEnv()?.name).toBe(HOOKS_STORAGE_ENV);
    expect(getStorageDatabaseUrl()).toBe("postgres://primary/hooks");

    process.env[HOOKS_STORAGE_MODE_ENV] = "remote";
    expect(getStorageMode()).toBe("remote");

    process.env[HOOKS_STORAGE_MODE_ENV] = "invalid";
    process.env[HOOKS_STORAGE_MODE_FALLBACK_ENV] = "local";
    expect(getStorageMode()).toBe("local");
  });

  test("exposes and validates storage tables", () => {
    expect(STORAGE_TABLES).toContain("hook_events");
    expect(STORAGE_TABLES).toContain("schema_migrations");
    expect(STORAGE_TABLES).toContain("feedback");
    expect(resolveTables()).toEqual([...STORAGE_TABLES]);
    expect(parseStorageTables("hook_events,feedback")).toEqual(["hook_events", "feedback"]);
    expect(() => resolveTables(["missing"])).toThrow("Unknown hooks sync table");
  });

  test("storage status initializes local sync metadata without remote config", () => {
    const dir = mkdtempSync(join(tmpdir(), "hooks-storage-"));
    const dbPath = join(dir, "hooks.db");
    process.env.HASNA_HOOKS_DB_PATH = dbPath;

    try {
      const status = getStorageStatus();
      expect(status).toMatchObject({
        configured: false,
        mode: "local",
        service: "hooks",
        activeEnv: null,
        sync: [],
      });
      expect(status.tables).toEqual(STORAGE_TABLES);
      expect(existsSync(dbPath)).toBe(true);
    } finally {
      closeDb();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
