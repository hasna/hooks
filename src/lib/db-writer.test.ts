import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync, mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { writeHookEvent, type HookEventInput } from "./db-writer.js";
import { closeDb } from "../db/index.js";

type FetchStub = (
  input: Parameters<typeof fetch>[0],
  init?: Parameters<typeof fetch>[1],
) => Promise<Response>;

const EVENT: HookEventInput = {
  session_id: "session-writer",
  hook_name: "commandlog",
  event_type: "PostToolUse",
  tool_name: "Bash",
  tool_input: "git status",
  project_dir: "/tmp/project",
};

const ROUTING_ENV = [
  "HASNA_HOOKS_STORAGE_MODE",
  "HOOKS_STORAGE_MODE",
  "HASNA_HOOKS_API_URL",
  "HOOKS_API_URL",
  "HASNA_HOOKS_API_KEY",
  "HOOKS_API_KEY",
  "HASNA_HOOKS_DB_PATH",
  "HOOKS_DB_PATH",
] as const;

async function withEnv<T>(overrides: Record<string, string | undefined>, callback: () => Promise<T>): Promise<T> {
  const original = new Map<string, string | undefined>();
  for (const name of ROUTING_ENV) {
    original.set(name, process.env[name]);
    delete process.env[name];
  }
  for (const [name, value] of Object.entries(overrides)) {
    if (value !== undefined) process.env[name] = value;
  }
  try {
    return await callback();
  } finally {
    closeDb();
    for (const [name, value] of original) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
}

async function withFetchStub<T>(stub: FetchStub, callback: () => Promise<T>): Promise<T> {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = stub as typeof fetch;
  try {
    return await callback();
  } finally {
    globalThis.fetch = originalFetch;
  }
}

function readHookEvents(dbPath: string): Array<Record<string, unknown>> {
  const db = new Database(dbPath, { readonly: true });
  try {
    return db.query("SELECT * FROM hook_events").all() as Array<Record<string, unknown>>;
  } finally {
    db.close();
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

describe("writeHookEvent", () => {
  test("local mode writes the event to SQLite", async () => {
    await withTempRoot("hooks-writer-local-", async (root) => {
      const dbPath = join(root, "hooks.db");
      await withEnv({ HASNA_HOOKS_STORAGE_MODE: "local", HASNA_HOOKS_DB_PATH: dbPath }, () => writeHookEvent(EVENT));

      const rows = readHookEvents(dbPath);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        session_id: "session-writer",
        hook_name: "commandlog",
        event_type: "PostToolUse",
        tool_input: "git status",
      });
    });
  });

  test("api mode posts the event to the /v1 authority and never opens local SQLite", async () => {
    await withTempRoot("hooks-writer-api-", async (root) => {
      const dbDir = join(root, "must-not-exist");
      const requests: Array<{ method: string | undefined; path: string; authorization: string | null; body: any }> = [];

      await withEnv({
        HASNA_HOOKS_STORAGE_MODE: "api",
        HASNA_HOOKS_API_URL: "http://127.0.0.1:8847",
        HASNA_HOOKS_API_KEY: "fixture-api-key",
        HASNA_HOOKS_DB_PATH: join(dbDir, "hooks.db"),
      }, () => withFetchStub(async (input, init) => {
        const url = new URL(input instanceof Request ? input.url : String(input));
        const body = JSON.parse(String(init?.body));
        requests.push({
          method: init?.method,
          path: url.pathname,
          authorization: new Headers(init?.headers).get("authorization"),
          body,
        });
        return Response.json({ event: body }, { status: 201 });
      }, () => writeHookEvent(EVENT)));

      expect(requests).toHaveLength(1);
      expect(requests[0]).toMatchObject({
        method: "POST",
        path: "/v1/log/events",
        authorization: "Bearer fixture-api-key",
      });
      expect(requests[0]!.body).toMatchObject({
        session_id: "session-writer",
        hook_name: "commandlog",
        event_type: "PostToolUse",
        tool_input: "git status",
      });
      expect(typeof requests[0]!.body.id).toBe("string");
      expect(typeof requests[0]!.body.timestamp).toBe("string");
      expect(existsSync(dbDir)).toBe(false);
    });
  });

  test("api mode spools to local SQLite when the authority is unreachable", async () => {
    await withTempRoot("hooks-writer-spool-", async (root) => {
      const dbPath = join(root, "hooks.db");
      await withEnv({
        HASNA_HOOKS_STORAGE_MODE: "api",
        HASNA_HOOKS_API_URL: "http://127.0.0.1:8847",
        HASNA_HOOKS_API_KEY: "fixture-api-key",
        HASNA_HOOKS_DB_PATH: dbPath,
      }, () => withFetchStub(
        async () => { throw new Error("connection refused"); },
        () => writeHookEvent(EVENT),
      ));

      const rows = readHookEvents(dbPath);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ session_id: "session-writer", hook_name: "commandlog" });
    });
  });

  test("api mode spools to local SQLite when the authority is misconfigured", async () => {
    await withTempRoot("hooks-writer-misconfigured-", async (root) => {
      const dbPath = join(root, "hooks.db");
      await withEnv({
        HASNA_HOOKS_STORAGE_MODE: "api",
        HASNA_HOOKS_API_KEY: "fixture-api-key",
        HASNA_HOOKS_DB_PATH: dbPath,
      }, () => writeHookEvent(EVENT));

      const rows = readHookEvents(dbPath);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ session_id: "session-writer", hook_name: "commandlog" });
    });
  });
});
