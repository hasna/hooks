import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeDb, getDb } from "./index.js";
import { PG_MIGRATIONS } from "./pg-migrations.js";
import { PgAdapterAsync } from "./remote-storage.js";
import {
  HOOKS_STORAGE_BACKEND_ENV,
  HOOKS_STORAGE_BACKEND_FALLBACK_ENV,
  HOOKS_STORAGE_ENV,
  HOOKS_STORAGE_FALLBACK_ENV,
  RETIRED_STORAGE_MODE_ENV,
  STORAGE_TABLES,
  getStorageBackend,
  getStorageDatabaseEnv,
  getStorageDatabaseEnvName,
  getStorageDatabaseUrl,
  getStoragePg,
  getStorageStatus,
  getSyncMetaAll,
  parseStorageTables,
  resolveTables,
  runStorageMigrations,
  storagePull,
  storagePush,
  storageSync,
} from "./storage-sync.js";

const ENV_KEYS = [
  HOOKS_STORAGE_ENV,
  HOOKS_STORAGE_FALLBACK_ENV,
  HOOKS_STORAGE_BACKEND_ENV,
  HOOKS_STORAGE_BACKEND_FALLBACK_ENV,
  ...RETIRED_STORAGE_MODE_ENV,
  "HASNA_HOOKS_DB_PATH",
] as const;

let tempDir: string;

function clearStorageEnv(): void {
  for (const key of ENV_KEYS) delete process.env[key];
}

function useTestDatabase(): string {
  const dbPath = join(tempDir, "hooks.db");
  new Database(dbPath).close();
  process.env.HASNA_HOOKS_DB_PATH = dbPath;
  return dbPath;
}

function mockPostgres(options: {
  all?: (sql: string, ...params: unknown[]) => Promise<unknown[]>;
  run?: (sql: string, ...params: unknown[]) => Promise<{ changes: number }>;
} = {}) {
  const run = spyOn(PgAdapterAsync.prototype, "run").mockImplementation(
    options.run ?? (async () => ({ changes: 0 })),
  );
  const all = spyOn(PgAdapterAsync.prototype, "all").mockImplementation(
    options.all ?? (async () => []),
  );
  const close = spyOn(PgAdapterAsync.prototype, "close").mockResolvedValue();
  return { run, all, close };
}

beforeEach(() => {
  closeDb();
  clearStorageEnv();
  tempDir = mkdtempSync(join(tmpdir(), "hooks-storage-sync-test-"));
});

afterEach(() => {
  closeDb();
  clearStorageEnv();
  mock.restore();
  rmSync(tempDir, { recursive: true, force: true });
});

describe("storage configuration", () => {
  test("database env helpers prefer a non-empty primary value and expose its trimmed URL", () => {
    expect(getStorageDatabaseEnvName()).toBeNull();
    expect(getStorageDatabaseEnv()).toBeNull();
    expect(getStorageDatabaseUrl()).toBeNull();

    process.env[HOOKS_STORAGE_ENV] = "   ";
    process.env[HOOKS_STORAGE_FALLBACK_ENV] = "  postgres://fallback/hooks  ";
    expect(getStorageDatabaseEnvName()).toBe(HOOKS_STORAGE_FALLBACK_ENV);
    expect(getStorageDatabaseEnv()).toEqual({ name: HOOKS_STORAGE_FALLBACK_ENV });
    expect(getStorageDatabaseUrl()).toBe("postgres://fallback/hooks");

    process.env[HOOKS_STORAGE_ENV] = "postgres://primary/hooks";
    expect(getStorageDatabaseEnvName()).toBe(HOOKS_STORAGE_ENV);
    expect(getStorageDatabaseUrl()).toBe("postgres://primary/hooks");
  });

  test("backend selection supports aliases and rejects invalid or retired configuration", () => {
    expect(getStorageBackend()).toBe("sqlite");

    process.env[HOOKS_STORAGE_FALLBACK_ENV] = "postgres://fallback/hooks";
    expect(getStorageBackend()).toBe("postgresql");

    process.env[HOOKS_STORAGE_BACKEND_ENV] = " PG ";
    expect(getStorageBackend()).toBe("postgresql");

    process.env[HOOKS_STORAGE_BACKEND_ENV] = "hybrid";
    expect(() => getStorageBackend()).toThrow(/retired deployment mode/i);

    process.env[HOOKS_STORAGE_BACKEND_ENV] = "unknown";
    expect(() => getStorageBackend()).toThrow(/not a known hooks storage backend/i);

    delete process.env[HOOKS_STORAGE_BACKEND_ENV];
    process.env.HOOKS_STORAGE_MODE = "remote";
    expect(() => getStorageBackend()).toThrow(/HOOKS_STORAGE_MODE is a retired/);
  });

  test("getStoragePg refuses missing configuration and creates an adapter for a URL", async () => {
    await expect(getStoragePg()).rejects.toThrow(/Missing HASNA_HOOKS_DATABASE_URL/);

    process.env[HOOKS_STORAGE_ENV] = "postgres://example/hooks";
    const close = spyOn(PgAdapterAsync.prototype, "close").mockResolvedValue();
    const remote = await getStoragePg();
    expect(remote).toBeInstanceOf(PgAdapterAsync);
    await remote.close();
    expect(close).toHaveBeenCalledTimes(1);
  });
});

describe("table selection", () => {
  test("resolveTables handles defaults, empty values, trimming, and invalid names", () => {
    expect(resolveTables()).toEqual([...STORAGE_TABLES]);
    expect(resolveTables([])).toEqual([...STORAGE_TABLES]);
    expect(resolveTables([" hook_events ", "", "feedback"])).toEqual(["hook_events", "feedback"]);
    expect(resolveTables(["   "])).toEqual([]);
    expect(() => resolveTables(["hook_events", "missing", "other"])).toThrow(
      "Unknown hooks sync table(s): missing, other",
    );
  });

  test("parseStorageTables handles absent, comma-delimited, array, and invalid input", () => {
    expect(parseStorageTables()).toBeUndefined();
    expect(parseStorageTables(null)).toBeUndefined();
    expect(parseStorageTables("")).toBeUndefined();
    expect(parseStorageTables("hook_events, ,feedback")).toEqual(["hook_events", "feedback"]);
    expect(parseStorageTables(["_meta"])).toEqual(["_meta"]);
    expect(() => parseStorageTables("hook_events,nope")).toThrow("Unknown hooks sync table(s): nope");
  });
});

describe("PostgreSQL migrations", () => {
  test("runs the extension and every migration in order", async () => {
    const run = mock(async (_sql: string) => ({ changes: 0 }));
    const remote = { run } as unknown as PgAdapterAsync;

    await runStorageMigrations(remote);

    expect(run).toHaveBeenCalledTimes(PG_MIGRATIONS.length + 1);
    expect(run.mock.calls.map(([sql]) => sql)).toEqual([
      "CREATE EXTENSION IF NOT EXISTS pgcrypto",
      ...PG_MIGRATIONS,
    ]);
  });

  test("propagates a migration permission refusal and stops", async () => {
    const run = mock(async () => {
      throw new Error("permission denied for extension pgcrypto");
    });
    const remote = { run } as unknown as PgAdapterAsync;

    await expect(runStorageMigrations(remote)).rejects.toThrow("permission denied");
    expect(run).toHaveBeenCalledTimes(1);
  });
});

describe("storage synchronization", () => {
  test("pushes local rows, records sync metadata, and closes PostgreSQL", async () => {
    useTestDatabase();
    process.env[HOOKS_STORAGE_ENV] = "postgres://example/hooks";
    const db = getDb();
    db.run(
      `INSERT INTO hook_events (id, timestamp, session_id, hook_name, event_type, tool_name)
       VALUES (?, ?, ?, ?, ?, ?)`,
      ["local-1", "2026-07-29T00:00:00.000Z", "session-1", "sessionlog", "PostToolUse", "Read"],
    );
    const remoteColumns = ["id", "timestamp", "session_id", "hook_name", "event_type", "tool_name"];
    const pg = mockPostgres({
      all: async (sql) => sql.includes("information_schema.columns")
        ? remoteColumns.map((column_name) => ({ column_name, data_type: "text" }))
        : [],
    });

    const results = await storagePush({ tables: ["hook_events"] });

    expect(results).toEqual([{ table: "hook_events", rowsRead: 1, rowsWritten: 1, errors: [] }]);
    const insert = pg.run.mock.calls.find(([sql]) => sql.includes('INSERT INTO "hook_events"'));
    expect(insert?.[0]).toContain('ON CONFLICT ("id") DO UPDATE');
    expect(insert?.slice(1)).toEqual([
      "local-1",
      "2026-07-29T00:00:00.000Z",
      "session-1",
      "sessionlog",
      "PostToolUse",
      "Read",
    ]);
    expect(getSyncMetaAll()).toEqual([
      { table_name: "hook_events", direction: "push", last_synced_at: expect.any(String) },
    ]);
    expect(pg.close).toHaveBeenCalledTimes(1);
  });

  test("returns a per-table push error on remote permission refusal and does not mark it synced", async () => {
    useTestDatabase();
    process.env[HOOKS_STORAGE_ENV] = "postgres://example/hooks";
    getDb().run(
      `INSERT INTO hook_events (id, timestamp, session_id, hook_name, event_type)
       VALUES (?, ?, ?, ?, ?)`,
      ["local-1", "2026-07-29T00:00:00.000Z", "session-1", "sessionlog", "PostToolUse"],
    );
    const pg = mockPostgres({
      all: async () => [],
      run: async (sql) => {
        if (sql.includes('INSERT INTO "hook_events"')) throw new Error("permission denied for hook_events");
        return { changes: 0 };
      },
    });

    const results = await storagePush({ tables: ["hook_events"] });

    expect(results).toEqual([{
      table: "hook_events",
      rowsRead: 1,
      rowsWritten: 0,
      errors: ["permission denied for hook_events"],
    }]);
    expect(getSyncMetaAll()).toEqual([]);
    expect(pg.close).toHaveBeenCalledTimes(1);
  });

  test("pulls remote rows through the local schema and records sync metadata", async () => {
    useTestDatabase();
    process.env[HOOKS_STORAGE_ENV] = "postgres://example/hooks";
    const pg = mockPostgres({
      all: async (sql) => sql.includes('SELECT * FROM "hook_events"')
        ? [{
          id: "remote-1",
          timestamp: "2026-07-29T01:00:00.000Z",
          session_id: "session-2",
          hook_name: "sessionlog",
          event_type: "PostToolUse",
          tool_name: "Write",
          remote_only: "ignored",
        }]
        : [],
    });

    const results = await storagePull({ tables: ["hook_events"] });

    expect(results).toEqual([{ table: "hook_events", rowsRead: 1, rowsWritten: 1, errors: [] }]);
    expect(getDb().query(
      "SELECT id, tool_name FROM hook_events WHERE id = 'remote-1'",
    ).get()).toEqual({ id: "remote-1", tool_name: "Write" });
    expect(getSyncMetaAll()).toEqual([
      { table_name: "hook_events", direction: "pull", last_synced_at: expect.any(String) },
    ]);
    expect(pg.close).toHaveBeenCalledTimes(1);
  });

  test("returns a per-table pull error on remote read refusal and does not mark it synced", async () => {
    useTestDatabase();
    process.env[HOOKS_STORAGE_ENV] = "postgres://example/hooks";
    const pg = mockPostgres({
      all: async (sql) => {
        if (sql.includes('SELECT * FROM "hook_events"')) throw new Error("not authorized to read hook_events");
        return [];
      },
    });

    const results = await storagePull({ tables: ["hook_events"] });

    expect(results).toEqual([{
      table: "hook_events",
      rowsRead: 0,
      rowsWritten: 0,
      errors: ["not authorized to read hook_events"],
    }]);
    expect(getSyncMetaAll()).toEqual([]);
    expect(pg.close).toHaveBeenCalledTimes(1);
  });

  test("sync performs pull then push and closes both adapters for an empty table", async () => {
    useTestDatabase();
    process.env[HOOKS_STORAGE_ENV] = "postgres://example/hooks";
    const pg = mockPostgres();

    const result = await storageSync({ tables: ["feedback"] });

    expect(result).toEqual({
      pull: [{ table: "feedback", rowsRead: 0, rowsWritten: 0, errors: [] }],
      push: [{ table: "feedback", rowsRead: 0, rowsWritten: 0, errors: [] }],
    });
    expect(getSyncMetaAll().map(({ table_name, direction }) => ({ table_name, direction }))).toEqual([
      { table_name: "feedback", direction: "pull" },
      { table_name: "feedback", direction: "push" },
    ]);
    expect(pg.close).toHaveBeenCalledTimes(2);
  });

  test("sync rejects missing database configuration before doing work", async () => {
    useTestDatabase();
    await expect(storageSync({ tables: ["feedback"] })).rejects.toThrow(/Missing HASNA_HOOKS_DATABASE_URL/);
    expect(getSyncMetaAll()).toEqual([]);
  });
});

describe("sync metadata and status", () => {
  test("getSyncMetaAll creates an empty metadata table and returns rows in stable order", () => {
    useTestDatabase();
    expect(getSyncMetaAll()).toEqual([]);
    const db = getDb();
    db.run(
      "INSERT INTO _hooks_sync_meta (table_name, last_synced_at, direction) VALUES (?, ?, ?)",
      ["feedback", null, "push"],
    );
    db.run(
      "INSERT INTO _hooks_sync_meta (table_name, last_synced_at, direction) VALUES (?, ?, ?)",
      ["feedback", "2026-07-29T00:00:00.000Z", "pull"],
    );
    expect(getSyncMetaAll()).toEqual([
      { table_name: "feedback", last_synced_at: "2026-07-29T00:00:00.000Z", direction: "pull" },
      { table_name: "feedback", last_synced_at: null, direction: "push" },
    ]);
  });

  test("getStorageStatus reports configured state and rejects a bad backend", () => {
    useTestDatabase();
    process.env[HOOKS_STORAGE_FALLBACK_ENV] = "postgres://fallback/hooks";
    expect(getStorageStatus()).toEqual({
      configured: true,
      backend: "postgresql",
      env: [HOOKS_STORAGE_ENV, HOOKS_STORAGE_FALLBACK_ENV],
      activeEnv: HOOKS_STORAGE_FALLBACK_ENV,
      service: "hooks",
      tables: STORAGE_TABLES,
      sync: [],
    });

    process.env[HOOKS_STORAGE_BACKEND_ENV] = "invalid";
    expect(() => getStorageStatus()).toThrow(/not a known hooks storage backend/);
  });
});
