import { existsSync, readFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import {
  clearHookEvents,
  insertHookEvent,
  listHookErrors,
  listHookEvents,
  normalizeLogLimit,
  searchHookEvents,
  summarizeHookEvents,
  type HookEventInput,
} from "../db/log-store.js";
import {
  getStorageStatus,
  parseStorageTables,
  storageExportRows,
  storageImportRows,
  type StorageRowsPayload,
} from "../storage.js";

type Env = Record<string, string | undefined>;

/**
 * The credential this process accepts as the /v1 admin key. It is deliberately
 * NOT `HASNA_HOOKS_API_KEY`: that variable is the CLIENT bearer token for a
 * remote authority, and one secret must not serve both trust roles.
 */
export const HOOKS_API_SERVER_KEY_ENV = "HASNA_HOOKS_API_SERVER_KEY";
export const HOOKS_API_SERVER_KEY_FALLBACK_ENV = "HOOKS_API_SERVER_KEY";

const __dirname = dirname(fileURLToPath(import.meta.url));
let pkg = { name: "@hasna/hooks", version: "0.0.0" };
try {
  for (const rel of ["../../package.json", "../package.json", "../../../package.json"]) {
    const path = join(__dirname, rel);
    if (existsSync(path)) {
      pkg = JSON.parse(readFileSync(path, "utf-8"));
      break;
    }
  }
} catch {}

export async function handleHooksApiRequest(req: Request, options: { name?: string; env?: Env } = {}): Promise<Response> {
  const env = options.env ?? process.env as Env;
  const url = new URL(req.url);
  const name = options.name ?? "hooks";

  if (url.pathname === "/v1/health" && req.method === "GET") {
    return json({ status: "ok", name, version: pkg.version });
  }

  const authFailure = requireApiAuth(req, env);
  if (authFailure) return authFailure;

  try {
    if (url.pathname === "/v1/log/events" && req.method === "GET") {
      const events = listHookEvents({
        hook: url.searchParams.get("hook") ?? undefined,
        session: url.searchParams.get("session") ?? undefined,
        since: url.searchParams.get("since") ?? undefined,
        limit: normalizeLogLimit(url.searchParams.get("limit") ?? undefined),
      });
      return json({ events, count: events.length });
    }
    if (url.pathname === "/v1/log/events" && req.method === "POST") {
      const event = await req.json() as HookEventInput;
      return json({ event: insertHookEvent(event) }, 201);
    }
    if (url.pathname === "/v1/log/events" && req.method === "DELETE") {
      const cleared = clearHookEvents({ hook: url.searchParams.get("hook") ?? undefined });
      return json({ cleared });
    }
    if (url.pathname === "/v1/log/search" && req.method === "GET") {
      const text = url.searchParams.get("q") ?? "";
      const events = text
        ? searchHookEvents({ text, limit: normalizeLogLimit(url.searchParams.get("limit") ?? undefined) })
        : [];
      return json({ events, count: events.length });
    }
    if (url.pathname === "/v1/log/errors" && req.method === "GET") {
      const events = listHookErrors({
        since: url.searchParams.get("since") ?? undefined,
        limit: normalizeLogLimit(url.searchParams.get("limit") ?? undefined),
      });
      return json({ events, count: events.length });
    }
    if (url.pathname === "/v1/log/summary" && req.method === "GET") {
      return json(summarizeHookEvents({ since: url.searchParams.get("since") ?? undefined }));
    }
    if (url.pathname === "/v1/storage/status" && req.method === "GET") {
      return json({ ...getStorageStatus(), transport: "api-http" });
    }
    if (url.pathname === "/v1/storage/export" && req.method === "GET") {
      const tables = parseStorageTables(url.searchParams.get("tables"));
      return json(storageExportRows({ tables }));
    }
    if (url.pathname === "/v1/storage/import" && req.method === "POST") {
      const payload = await req.json() as StorageRowsPayload;
      const results = storageImportRows(payload, { direction: "push" });
      return json({ results });
    }
  } catch (error) {
    return json({ error: error instanceof Error ? error.message : String(error) }, 400);
  }

  return json({ error: "Not Found" }, 404);
}

function requireApiAuth(req: Request, env: Env): Response | null {
  const expected = (env[HOOKS_API_SERVER_KEY_ENV] ?? env[HOOKS_API_SERVER_KEY_FALLBACK_ENV])?.trim();
  if (!expected) {
    return json({ error: `${HOOKS_API_SERVER_KEY_ENV} is required for Hooks /v1 data routes` }, 503);
  }
  const authorization = req.headers.get("authorization") ?? "";
  if (authorization !== `Bearer ${expected}`) {
    return json({ error: "Unauthorized" }, 401);
  }
  return null;
}

function json(body: unknown, status = 200): Response {
  return Response.json(body, { status });
}
