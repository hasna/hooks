import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  getHooksApiAuthorityConfigStatus,
  getHooksApiClient,
  resolveHooksCliStorageMode,
} from "./cloud-router.js";
import { closeDb } from "../db/index.js";
import { CREATE_HOOK_EVENTS_TABLE } from "../db/schema.js";

type FetchStub = (
  input: Parameters<typeof fetch>[0],
  init?: Parameters<typeof fetch>[1],
) => Promise<Response>;

function seedHookEvent(dbPath: string, row: Partial<Record<string, string | number | null>> = {}): void {
  const db = new Database(dbPath);
  try {
    db.exec(CREATE_HOOK_EVENTS_TABLE);
    db.run(
      `INSERT INTO hook_events
        (id, timestamp, session_id, hook_name, event_type, tool_name, tool_input, result, error, duration_ms, project_dir, metadata)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        row.id ?? "evt_fixture_1",
        row.timestamp ?? "2026-07-28T00:00:00.000Z",
        row.session_id ?? "session-fixture",
        row.hook_name ?? "gitguard",
        row.event_type ?? "PreToolUse",
        row.tool_name ?? "Bash",
        row.tool_input ?? "git status",
        row.result ?? "continue",
        row.error ?? null,
        row.duration_ms ?? 12,
        row.project_dir ?? "/tmp/project",
        row.metadata ?? null,
      ],
    );
  } finally {
    db.close();
  }
}

async function withFetchStub<T>(
  stub: FetchStub,
  callback: () => Promise<T>,
): Promise<T> {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = stub as typeof fetch;
  try {
    return await callback();
  } finally {
    globalThis.fetch = originalFetch;
  }
}

async function withDbPath<T>(dbPath: string, callback: () => Promise<T>): Promise<T> {
  const originalHasnaDbPath = process.env.HASNA_HOOKS_DB_PATH;
  const originalHooksDbPath = process.env.HOOKS_DB_PATH;
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

describe("hooks api router", () => {
  test("defaults to local even when API URL and key are present without an explicit mode", () => {
    expect(resolveHooksCliStorageMode({
      HASNA_HOOKS_API_URL: "https://hooks.example",
      HASNA_HOOKS_API_KEY: "fixture-key",
    })).toMatchObject({ mode: "local", selected: false });
    expect(getHooksApiClient({
      HASNA_HOOKS_API_URL: "https://hooks.example",
      HASNA_HOOKS_API_KEY: "fixture-key",
    })).toBeNull();
  });

  test("api mode resolves an authenticated /v1 authority", () => {
    const status = getHooksApiAuthorityConfigStatus({
      HASNA_HOOKS_STORAGE_MODE: "api",
      HASNA_HOOKS_API_URL: "https://hooks.example/v1",
      HASNA_HOOKS_API_KEY: "fixture-key",
    });
    expect(status).toMatchObject({
      selected: true,
      ok: true,
      mode: "api",
      v1_base_url: "https://hooks.example/v1",
      local_fallback: false,
    });
  });

  test("explicit api mode fails closed when URL or key is missing", () => {
    expect(() => getHooksApiClient({
      HASNA_HOOKS_STORAGE_MODE: "api",
      HASNA_HOOKS_API_KEY: "fixture-key",
    })).toThrow("REMOTE_API_URL_MISSING");
    expect(() => getHooksApiClient({
      HASNA_HOOKS_STORAGE_MODE: "self_hosted",
      HASNA_HOOKS_API_URL: "https://hooks.example",
    })).toThrow("REMOTE_API_KEY_MISSING");
  });

  test("legacy remote mode selects API only when API credentials are present", () => {
    expect(resolveHooksCliStorageMode({
      HASNA_HOOKS_STORAGE_MODE: "remote",
      HASNA_HOOKS_DATABASE_URL: "postgres://example/hooks",
    })).toMatchObject({ mode: "remote", selected: false });
    expect(resolveHooksCliStorageMode({
      HASNA_HOOKS_STORAGE_MODE: "remote",
      HASNA_HOOKS_API_URL: "https://hooks.example",
      HASNA_HOOKS_API_KEY: "fixture-key",
    })).toMatchObject({ mode: "remote", selected: true });
  });

  test.each([
    ["HASNA_HOOKS_API_KEY"],
    ["HOOKS_API_KEY"],
  ])("a stray %s never diverts legacy remote mode away from PostgreSQL", (keyEnv) => {
    const env = {
      HASNA_HOOKS_STORAGE_MODE: "remote",
      HASNA_HOOKS_DATABASE_URL: "postgres://example/hooks",
      [keyEnv]: "strayvalue",
    };
    expect(resolveHooksCliStorageMode(env)).toMatchObject({ mode: "remote", selected: false, warnings: [] });
    expect(getHooksApiClient(env)).toBeNull();
  });

  test("hybrid mode keeps the PostgreSQL path when only an API key is present", () => {
    const env = {
      HASNA_HOOKS_STORAGE_MODE: "hybrid",
      HOOKS_DATABASE_URL: "postgres://example/hooks",
      HOOKS_API_KEY: "strayvalue",
    };
    expect(resolveHooksCliStorageMode(env)).toMatchObject({ mode: "hybrid", selected: false });
    expect(getHooksApiClient(env)).toBeNull();
  });

  test("legacy remote mode warns when a database URL and an API URL are both configured", () => {
    const env = {
      HASNA_HOOKS_STORAGE_MODE: "remote",
      HASNA_HOOKS_DATABASE_URL: "postgres://example/hooks",
      HASNA_HOOKS_API_URL: "https://hooks.example",
      HASNA_HOOKS_API_KEY: "fixture-key",
    };
    const resolution = resolveHooksCliStorageMode(env);
    expect(resolution).toMatchObject({ mode: "remote", selected: true });
    expect(resolution.warnings).toHaveLength(1);
    expect(resolution.warnings[0]).toContain("REMOTE_TRANSPORT_AMBIGUOUS");
    expect(resolution.warnings[0]).toContain("HASNA_HOOKS_DATABASE_URL");
    expect(resolution.warnings[0]).toContain("HASNA_HOOKS_API_URL");
    expect(getHooksApiAuthorityConfigStatus(env).warnings).toEqual(resolution.warnings);
  });

  test("explicit api mode does not warn about an unused database URL", () => {
    expect(resolveHooksCliStorageMode({
      HASNA_HOOKS_STORAGE_MODE: "api",
      HASNA_HOOKS_DATABASE_URL: "postgres://example/hooks",
      HASNA_HOOKS_API_URL: "https://hooks.example",
      HASNA_HOOKS_API_KEY: "fixture-key",
    }).warnings).toEqual([]);
  });

  test.each([
    "https://user@hooks.example",
    "https://hooks.example?x=1",
    "https://hooks.example#v1",
    "https://hooks.example/api/v1",
    "http://hooks.example",
  ])("rejects unsafe API authority URL %s", (apiUrl) => {
    expect(() => getHooksApiClient({
      HASNA_HOOKS_STORAGE_MODE: "api",
      HASNA_HOOKS_API_URL: apiUrl,
      HASNA_HOOKS_API_KEY: "fixture-key",
    })).toThrow("REMOTE_API_URL_INVALID");
  });

  test("client sends log requests to the configured /v1 authority", async () => {
    const requests: Array<{ path: string; search: string; authorization: string | null }> = [];
    const client = getHooksApiClient({
      HASNA_HOOKS_STORAGE_MODE: "api",
      HASNA_HOOKS_API_URL: "http://127.0.0.1:8847",
      HASNA_HOOKS_API_KEY: "fixture-key",
    });

    await withFetchStub(async (input, init) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      requests.push({
        path: url.pathname,
        search: url.search,
        authorization: new Headers(init?.headers).get("authorization"),
      });
      return Response.json({
        events: [{
          id: "evt_api",
          timestamp: "2026-07-28T00:00:00.000Z",
          session_id: "session-api",
          hook_name: "gitguard",
          event_type: "PreToolUse",
          tool_name: "Bash",
          tool_input: "git status",
          result: "continue",
          error: null,
          duration_ms: 10,
          project_dir: "/tmp/project",
          metadata: null,
        }],
      });
    }, async () => {
      const events = await client!.listHookEvents({ hook: "gitguard", session: "session", limit: 5 });
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({ id: "evt_api", hook_name: "gitguard" });
    });

    expect(requests).toEqual([{
      path: "/v1/log/events",
      search: "?hook=gitguard&session=session&limit=5",
      authorization: "Bearer fixture-key",
    }]);
  });

  test("client appends hook events to the configured /v1 authority", async () => {
    const requests: Array<{ method: string | undefined; path: string; body: unknown }> = [];
    const client = getHooksApiClient({
      HASNA_HOOKS_STORAGE_MODE: "api",
      HASNA_HOOKS_API_URL: "http://127.0.0.1:8847",
      HASNA_HOOKS_API_KEY: "fixture-key",
    });
    const row = {
      id: "evt_append",
      timestamp: "2026-07-28T00:00:00.000Z",
      session_id: "session-append",
      hook_name: "commandlog",
      event_type: "PostToolUse" as const,
      tool_name: "Bash",
      tool_input: "git status",
      result: null,
      error: null,
      duration_ms: null,
      project_dir: "/tmp/project",
      metadata: null,
    };

    await withFetchStub(async (input, init) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      requests.push({ method: init?.method, path: url.pathname, body: JSON.parse(String(init?.body)) });
      return Response.json({ event: row }, { status: 201 });
    }, async () => {
      expect(await client!.appendHookEvent(row)).toEqual(row);
    });

    expect(requests).toEqual([{ method: "POST", path: "/v1/log/events", body: row }]);
  });

  test("client storage pull imports remote rows into the local database", async () => {
    const root = mkdtempSync(join(tmpdir(), "hooks-router-pull-"));
    const dbPath = join(root, "hooks.db");
    try {
      const client = getHooksApiClient({
        HASNA_HOOKS_STORAGE_MODE: "api",
        HASNA_HOOKS_API_URL: "http://127.0.0.1:8847",
        HASNA_HOOKS_API_KEY: "fixture-key",
      });

      await withDbPath(dbPath, async () => {
        const result = await withFetchStub(async (input, init) => {
          const url = new URL(input instanceof Request ? input.url : String(input));
          expect(url.pathname).toBe("/v1/storage/export");
          expect(url.search).toBe("?tables=hook_events");
          expect(new Headers(init?.headers).get("authorization")).toBe("Bearer fixture-key");
          return Response.json({
            tables: {
              hook_events: [{
                id: "evt_pull",
                timestamp: "2026-07-28T00:00:00.000Z",
                session_id: "session-pull",
                hook_name: "gitguard",
                event_type: "PreToolUse",
                tool_name: "Bash",
                tool_input: "git status",
                result: "continue",
                error: null,
                duration_ms: 10,
                project_dir: "/tmp/project",
                metadata: null,
              }],
            },
          });
        }, () => client!.storagePull({ tables: ["hook_events"] }));

        expect(result).toEqual([{ table: "hook_events", rowsRead: 1, rowsWritten: 1, errors: [] }]);
      });

      const db = new Database(dbPath, { readonly: true });
      try {
        expect(db.query("SELECT id, hook_name FROM hook_events").all()).toEqual([
          { id: "evt_pull", hook_name: "gitguard" },
        ]);
      } finally {
        db.close();
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("client storage push exports local rows to the configured authority", async () => {
    const root = mkdtempSync(join(tmpdir(), "hooks-router-push-"));
    const dbPath = join(root, "hooks.db");
    try {
      seedHookEvent(dbPath, { id: "evt_push", hook_name: "gitguard" });
      const imports: any[] = [];
      const client = getHooksApiClient({
        HASNA_HOOKS_STORAGE_MODE: "api",
        HASNA_HOOKS_API_URL: "http://127.0.0.1:8847",
        HASNA_HOOKS_API_KEY: "fixture-key",
      });

      await withDbPath(dbPath, async () => {
        const result = await withFetchStub(async (input, init) => {
          const url = new URL(input instanceof Request ? input.url : String(input));
          expect(url.pathname).toBe("/v1/storage/import");
          expect(new Headers(init?.headers).get("authorization")).toBe("Bearer fixture-key");
          imports.push(JSON.parse(String(init?.body)));
          return Response.json({ results: [{ table: "hook_events", rowsRead: 1, rowsWritten: 1, errors: [] }] });
        }, () => client!.storagePush({ tables: ["hook_events"] }));

        expect(result).toEqual([{ table: "hook_events", rowsRead: 1, rowsWritten: 1, errors: [] }]);
      });

      expect(imports[0].tables.hook_events[0]).toMatchObject({ id: "evt_push", hook_name: "gitguard" });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
