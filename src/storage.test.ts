import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeDb } from "./db/index.js";
import * as storageModule from "./storage.js";
import {
  HOOKS_STORAGE_BACKEND_ENV,
  HOOKS_STORAGE_BACKEND_FALLBACK_ENV,
  HOOKS_STORAGE_ENV,
  HOOKS_STORAGE_FALLBACK_ENV,
  RETIRED_STORAGE_MODE_ENV,
  STORAGE_BACKENDS,
  STORAGE_TABLES,
  getStorageBackend,
  getStorageDatabaseEnv,
  getStorageDatabaseUrl,
  getStorageStatus,
  parseStorageTables,
  resolveTables,
} from "./storage.js";

const ENV_KEYS = [
  HOOKS_STORAGE_ENV,
  HOOKS_STORAGE_FALLBACK_ENV,
  HOOKS_STORAGE_BACKEND_ENV,
  HOOKS_STORAGE_BACKEND_FALLBACK_ENV,
  ...RETIRED_STORAGE_MODE_ENV,
  "HASNA_HOOKS_DB_PATH",
] as const;

afterEach(() => {
  closeDb();
  for (const key of ENV_KEYS) delete process.env[key];
});

describe("hooks storage config", () => {
  test("resolves canonical database env and fallback env", () => {
    for (const key of ENV_KEYS) delete process.env[key];
    expect(getStorageDatabaseEnv()).toBeNull();
    expect(getStorageDatabaseUrl()).toBeNull();

    process.env[HOOKS_STORAGE_FALLBACK_ENV] = "postgres://fallback/hooks";
    expect(getStorageDatabaseEnv()?.name).toBe(HOOKS_STORAGE_FALLBACK_ENV);
    expect(getStorageDatabaseUrl()).toBe("postgres://fallback/hooks");

    process.env[HOOKS_STORAGE_ENV] = "postgres://primary/hooks";
    expect(getStorageDatabaseEnv()?.name).toBe(HOOKS_STORAGE_ENV);
    expect(getStorageDatabaseUrl()).toBe("postgres://primary/hooks");
  });

  test("the storage backend is a two-value switch, not a three-way deployment mode", () => {
    expect([...STORAGE_BACKENDS]).toEqual(["sqlite", "postgresql"]);
  });

  test("backend defaults to sqlite, and to postgresql once a database url is configured", () => {
    for (const key of ENV_KEYS) delete process.env[key];
    expect(getStorageBackend()).toBe("sqlite");

    process.env[HOOKS_STORAGE_FALLBACK_ENV] = "postgres://fallback/hooks";
    expect(getStorageBackend()).toBe("postgresql");
  });

  test("an explicit backend wins over the inferred default, case-insensitively", () => {
    process.env[HOOKS_STORAGE_BACKEND_ENV] = "PostgreSQL";
    expect(getStorageBackend()).toBe("postgresql");

    delete process.env[HOOKS_STORAGE_BACKEND_ENV];
    process.env[HOOKS_STORAGE_BACKEND_FALLBACK_ENV] = " sqlite ";
    process.env[HOOKS_STORAGE_ENV] = "postgres://primary/hooks";
    expect(getStorageBackend()).toBe("sqlite");
  });

  test("`postgres` is accepted as an alias for the canonical `postgresql`", () => {
    process.env[HOOKS_STORAGE_BACKEND_ENV] = "postgres";
    expect(getStorageBackend()).toBe("postgresql");
  });

  test("an unknown backend value throws instead of silently falling back", () => {
    process.env[HOOKS_STORAGE_BACKEND_ENV] = "invalid";
    process.env[HOOKS_STORAGE_BACKEND_FALLBACK_ENV] = "sqlite";
    expect(() => getStorageBackend()).toThrow(/HASNA_HOOKS_STORAGE_BACKEND/);
    expect(() => getStorageBackend()).toThrow(/sqlite/);
    expect(() => getStorageBackend()).toThrow(/postgresql/);
  });

  test.each(["local", "hybrid", "remote", "self_hosted", "self-hosted", "cloud"])(
    "the retired deployment mode %p throws and names its backend replacement",
    (retired) => {
      process.env[HOOKS_STORAGE_BACKEND_ENV] = retired;
      expect(() => getStorageBackend()).toThrow(/deployment mode/i);
      expect(() => getStorageBackend()).toThrow(/HASNA_HOOKS_STORAGE_BACKEND/);
      const expected = retired === "local" ? "sqlite" : "postgresql";
      expect(() => getStorageBackend()).toThrow(new RegExp(expected));
    },
  );

  test.each(["HASNA_HOOKS_STORAGE_MODE", "HOOKS_STORAGE_MODE"])(
    "the retired env var %s throws and names the replacement env var",
    (retiredEnv) => {
      process.env[retiredEnv] = "hybrid";
      expect(() => getStorageBackend()).toThrow(new RegExp(retiredEnv));
      expect(() => getStorageBackend()).toThrow(/HASNA_HOOKS_STORAGE_BACKEND/);
      expect(() => getStorageStatus()).toThrow(/HASNA_HOOKS_STORAGE_BACKEND/);
    },
  );

  test("a retired env var throws even when it carries an otherwise valid backend value", () => {
    process.env.HASNA_HOOKS_STORAGE_MODE = "sqlite";
    expect(() => getStorageBackend()).toThrow(/HASNA_HOOKS_STORAGE_MODE/);
  });

  test("the deployment-mode API is gone from the public surface", () => {
    const removed = [
      "getStorageMode",
      "HOOKS_STORAGE_MODE_ENV",
      "HOOKS_STORAGE_MODE_FALLBACK_ENV",
      "STORAGE_MODE_ENV",
    ];
    for (const name of removed) {
      expect(Object.keys(storageModule)).not.toContain(name);
    }
  });

  test("exposes and validates storage tables", () => {
    expect(STORAGE_TABLES).toContain("hook_events");
    expect(STORAGE_TABLES).toContain("schema_migrations");
    expect(STORAGE_TABLES).toContain("feedback");
    expect(resolveTables()).toEqual([...STORAGE_TABLES]);
    expect(parseStorageTables("hook_events,feedback")).toEqual(["hook_events", "feedback"]);
    expect(() => resolveTables(["missing"])).toThrow("Unknown hooks sync table");
  });

  test("storage status reports the sqlite backend and no deployment mode", () => {
    const dir = mkdtempSync(join(tmpdir(), "hooks-storage-"));
    const dbPath = join(dir, "hooks.db");
    process.env.HASNA_HOOKS_DB_PATH = dbPath;

    try {
      const status = getStorageStatus();
      expect(status).toMatchObject({
        configured: false,
        backend: "sqlite",
        service: "hooks",
        activeEnv: null,
        sync: [],
      });
      expect(Object.keys(status)).not.toContain("mode");
      expect(status.tables).toEqual(STORAGE_TABLES);
      expect(existsSync(dbPath)).toBe(true);
    } finally {
      closeDb();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
