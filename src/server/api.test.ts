import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { handleHooksApiRequest } from "./api.js";
import { closeDb } from "../db/index.js";

const SERVER_ENV = { HASNA_HOOKS_API_SERVER_KEY: "fixture-server-key" };
const AUTH = { authorization: "Bearer fixture-server-key", "content-type": "application/json" };

async function withDbPath<T>(dbPath: string, callback: () => Promise<T>): Promise<T> {
  const originalHasnaDbPath = process.env.HASNA_HOOKS_DB_PATH;
  const originalHooksDbPath = process.env.HOOKS_DB_PATH;
  closeDb();
  process.env.HASNA_HOOKS_DB_PATH = dbPath;
  delete process.env.HOOKS_DB_PATH;
  try {
    return await callback();
  } finally {
    closeDb();
    if (originalHasnaDbPath === undefined) delete process.env.HASNA_HOOKS_DB_PATH;
    else process.env.HASNA_HOOKS_DB_PATH = originalHasnaDbPath;
    if (originalHooksDbPath === undefined) delete process.env.HOOKS_DB_PATH;
    else process.env.HOOKS_DB_PATH = originalHooksDbPath;
  }
}

async function withTempRoot<T>(prefix: string, callback: (root: string) => Promise<T>): Promise<T> {
  const root = mkdtempSync(join(tmpdir(), prefix));
  try {
    return await callback(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function post(body: unknown): Request {
  return new Request("http://127.0.0.1/v1/log/events", {
    method: "POST",
    headers: AUTH,
    body: JSON.stringify(body),
  });
}

describe("Hooks /v1 log ingestion", () => {
  test("POST /v1/log/events persists the event and it is readable back", async () => {
    await withTempRoot("hooks-api-ingest-", async (root) => {
      const dbPath = join(root, "hooks.db");
      await withDbPath(dbPath, async () => {
        const created = await handleHooksApiRequest(post({
          session_id: "session-ingest",
          hook_name: "commandlog",
          event_type: "PostToolUse",
          tool_name: "Bash",
          tool_input: "git status",
          project_dir: "/tmp/project",
        }), { env: SERVER_ENV });

        expect(created.status).toBe(201);
        const { event } = await created.json() as { event: { id: string; timestamp: string } };
        expect(typeof event.id).toBe("string");
        expect(typeof event.timestamp).toBe("string");

        const listed = await handleHooksApiRequest(
          new Request("http://127.0.0.1/v1/log/events", { headers: AUTH }),
          { env: SERVER_ENV },
        );
        expect(listed.status).toBe(200);
        const { events } = await listed.json() as { events: Array<Record<string, unknown>> };
        expect(events).toHaveLength(1);
        expect(events[0]).toMatchObject({
          id: event.id,
          session_id: "session-ingest",
          hook_name: "commandlog",
          tool_input: "git status",
        });
      });

      const db = new Database(dbPath, { readonly: true });
      try {
        expect(db.query("SELECT COUNT(*) as n FROM hook_events").get()).toEqual({ n: 1 });
      } finally {
        db.close();
      }
    });
  });

  test("POST /v1/log/events is idempotent for a retried event id", async () => {
    await withTempRoot("hooks-api-ingest-retry-", async (root) => {
      await withDbPath(join(root, "hooks.db"), async () => {
        const event = {
          id: "evt_retry",
          timestamp: "2026-07-28T00:00:00.000Z",
          session_id: "session-retry",
          hook_name: "commandlog",
          event_type: "PostToolUse",
        };
        expect((await handleHooksApiRequest(post(event), { env: SERVER_ENV })).status).toBe(201);
        expect((await handleHooksApiRequest(post(event), { env: SERVER_ENV })).status).toBe(201);

        const listed = await handleHooksApiRequest(
          new Request("http://127.0.0.1/v1/log/events", { headers: AUTH }),
          { env: SERVER_ENV },
        );
        const { events } = await listed.json() as { events: unknown[] };
        expect(events).toHaveLength(1);
      });
    });
  });

  test("POST /v1/log/events rejects an invalid event type", async () => {
    await withTempRoot("hooks-api-ingest-invalid-", async (root) => {
      await withDbPath(join(root, "hooks.db"), async () => {
        const res = await handleHooksApiRequest(post({
          session_id: "session-invalid",
          hook_name: "commandlog",
          event_type: "NotAnEvent",
        }), { env: SERVER_ENV });
        expect(res.status).toBe(400);
      });
    });
  });

  test("POST /v1/log/events requires the server key", async () => {
    const res = await handleHooksApiRequest(
      new Request("http://127.0.0.1/v1/log/events", {
        method: "POST",
        headers: { authorization: "Bearer client-key", "content-type": "application/json" },
        body: JSON.stringify({ session_id: "s", hook_name: "h", event_type: "Stop" }),
      }),
      { env: { HASNA_HOOKS_API_KEY: "client-key" } },
    );
    expect(res.status).toBe(503);
  });
});

function readMigrationLedger(dbPath: string): string[] {
  const db = new Database(dbPath, { readonly: true });
  try {
    return (db.query("SELECT version FROM schema_migrations ORDER BY version").all() as Array<{ version: string }>)
      .map((row) => row.version);
  } finally {
    db.close();
  }
}

describe("Hooks /v1 storage sync", () => {
  test("POST /v1/storage/import refuses a schema_migrations payload and leaves the ledger untouched", async () => {
    await withTempRoot("hooks-api-ledger-", async (root) => {
      const dbPath = join(root, "hooks.db");
      let ledgerBefore: string[] = [];

      await withDbPath(dbPath, async () => {
        // Opening the authority's database applies its own migrations.
        await handleHooksApiRequest(post({
          session_id: "session-ledger",
          hook_name: "commandlog",
          event_type: "PostToolUse",
        }), { env: SERVER_ENV });
        ledgerBefore = readMigrationLedger(dbPath);
        expect(ledgerBefore.length).toBeGreaterThan(0);

        const res = await handleHooksApiRequest(
          new Request("http://127.0.0.1/v1/storage/import", {
            method: "POST",
            headers: AUTH,
            body: JSON.stringify({
              tables: {
                schema_migrations: [{ version: "004_future", applied_at: "2026-07-28T00:00:00.000Z" }],
                _meta: [{ key: "peer", value: "client" }],
              },
            }),
          }),
          { env: SERVER_ENV },
        );

        expect(res.status).toBe(200);
        const { results } = await res.json() as { results: Array<{ table: string; rowsWritten: number; errors: string[] }> };
        for (const result of results) {
          expect(result.rowsWritten).toBe(0);
          expect(result.errors.join(" ")).toContain("does not carry bookkeeping table");
        }
        expect(results.map((result) => result.table).sort()).toEqual(["_meta", "schema_migrations"]);
      });

      expect(readMigrationLedger(dbPath)).toEqual(ledgerBefore);
    });
  });

  test("GET /v1/storage/export never carries bookkeeping tables", async () => {
    await withTempRoot("hooks-api-export-", async (root) => {
      await withDbPath(join(root, "hooks.db"), async () => {
        const res = await handleHooksApiRequest(
          new Request("http://127.0.0.1/v1/storage/export", { headers: AUTH }),
          { env: SERVER_ENV },
        );
        expect(res.status).toBe(200);
        const { tables } = await res.json() as { tables: Record<string, unknown[]> };
        expect(Object.keys(tables).sort()).toEqual(["feedback", "hook_events"]);
      });
    });
  });

  test("GET /v1/storage/export rejects an explicitly requested bookkeeping table", async () => {
    await withTempRoot("hooks-api-export-reject-", async (root) => {
      await withDbPath(join(root, "hooks.db"), async () => {
        const res = await handleHooksApiRequest(
          new Request("http://127.0.0.1/v1/storage/export?tables=schema_migrations", { headers: AUTH }),
          { env: SERVER_ENV },
        );
        expect(res.status).toBe(400);
        const { error } = await res.json() as { error: string };
        expect(error).toContain("does not carry bookkeeping table");
      });
    });
  });
});
