import type { DbAdapter } from "@hasna/cloud";
import { getDb } from "./index.js";
import { PG_MIGRATIONS } from "./pg-migrations.js";
import { PgAdapterAsync } from "./remote-storage.js";

export const STORAGE_TABLES = [
  "hook_events",
  "schema_migrations",
  "_meta",
  "feedback",
] as const;

export const HOOKS_STORAGE_TABLES = STORAGE_TABLES;

type StorageTable = (typeof STORAGE_TABLES)[number];
type Row = Record<string, unknown>;

/**
 * The storage backend is a two-value data-backend switch, NOT a deployment mode.
 *
 * `local | hybrid | remote` (and the wider fleet's `self_hosted | cloud`) described *where*
 * something ran, which is not a property of the data layer. They are retired: local collapses
 * to `sqlite`, and every server-backed placement collapses to `postgresql`.
 */
export const STORAGE_BACKENDS = ["sqlite", "postgresql"] as const;

export type StorageBackend = (typeof STORAGE_BACKENDS)[number];

export interface StorageEnv {
  name: string;
}

export interface SyncResult {
  table: string;
  rowsRead: number;
  rowsWritten: number;
  errors: string[];
}

export interface SyncMeta {
  table_name: string;
  last_synced_at: string | null;
  direction: "push" | "pull";
}

export const HOOKS_STORAGE_ENV = "HASNA_HOOKS_DATABASE_URL";
export const HOOKS_STORAGE_FALLBACK_ENV = "HOOKS_DATABASE_URL";
export const HOOKS_STORAGE_BACKEND_ENV = "HASNA_HOOKS_STORAGE_BACKEND";
export const HOOKS_STORAGE_BACKEND_FALLBACK_ENV = "HOOKS_STORAGE_BACKEND";
export const STORAGE_DATABASE_ENV = [HOOKS_STORAGE_ENV, HOOKS_STORAGE_FALLBACK_ENV] as const;
export const STORAGE_BACKEND_ENV = [HOOKS_STORAGE_BACKEND_ENV, HOOKS_STORAGE_BACKEND_FALLBACK_ENV] as const;

/**
 * Deployment-mode env vars that no longer exist. Reading one is an error rather than a no-op:
 * an operator who set `HASNA_HOOKS_STORAGE_MODE=hybrid` believed they had configured something,
 * and silently ignoring it is how a config change appears to work and does not.
 */
export const RETIRED_STORAGE_MODE_ENV = ["HASNA_HOOKS_STORAGE_MODE", "HOOKS_STORAGE_MODE"] as const;

export interface StorageStatus {
  configured: boolean;
  backend: StorageBackend;
  env: typeof STORAGE_DATABASE_ENV;
  activeEnv: string | null;
  service: "hooks";
  tables: typeof STORAGE_TABLES;
  sync: SyncMeta[];
}

const PRIMARY_KEYS: Record<StorageTable, string[]> = {
  hook_events: ["id"],
  schema_migrations: ["version"],
  _meta: ["key"],
  feedback: ["id"],
};

function readEnv(name: string): string | undefined {
  const value = process.env[name]?.trim();
  return value || undefined;
}

/**
 * Retired deployment-mode values mapped to the backend that replaced them. `local` was the
 * on-box SQLite file; every other placement — hybrid, remote, self-hosted, cloud — was a
 * server holding the data in PostgreSQL.
 */
const RETIRED_MODE_REPLACEMENT: Record<string, StorageBackend> = {
  local: "sqlite",
  hybrid: "postgresql",
  remote: "postgresql",
  self_hosted: "postgresql",
  "self-hosted": "postgresql",
  selfhosted: "postgresql",
  cloud: "postgresql",
};

const BACKEND_ALIASES: Record<string, StorageBackend> = {
  sqlite: "sqlite",
  sqlite3: "sqlite",
  postgresql: "postgresql",
  postgres: "postgresql",
  pg: "postgresql",
};

function assertNoRetiredModeEnv(): void {
  for (const name of RETIRED_STORAGE_MODE_ENV) {
    const value = readEnv(name);
    if (!value) continue;
    const replacement = RETIRED_MODE_REPLACEMENT[value.trim().toLowerCase()];
    const mapping = replacement
      ? `${value} maps to ${replacement}`
      : `use one of ${STORAGE_BACKENDS.join(", ")}`;
    throw new Error(
      `${name} is a retired deployment-mode variable and is no longer read. `
        + `Hooks storage is a data-backend switch, not a deployment mode: `
        + `set ${HOOKS_STORAGE_BACKEND_ENV} to ${STORAGE_BACKENDS.join(" or ")} instead (${mapping}), `
        + `then unset ${name}.`,
    );
  }
}

function normalizeStorageBackend(value: string | undefined, envName: string): StorageBackend | undefined {
  if (value === undefined) return undefined;
  const normalized = value.trim().toLowerCase();
  if (normalized === "") return undefined;

  const backend = BACKEND_ALIASES[normalized];
  if (backend) return backend;

  const replacement = RETIRED_MODE_REPLACEMENT[normalized];
  if (replacement) {
    throw new Error(
      `${envName}=${value} names a retired deployment mode. `
        + `local/hybrid/remote/self_hosted/cloud were removed: hooks storage now selects a data `
        + `backend only. Set ${envName}=${replacement} instead.`,
    );
  }

  throw new Error(
    `${envName}=${value} is not a known hooks storage backend. `
      + `Set ${HOOKS_STORAGE_BACKEND_ENV} to one of ${STORAGE_BACKENDS.join(", ")}.`,
  );
}

export function getStorageDatabaseEnvName(): (typeof STORAGE_DATABASE_ENV)[number] | null {
  for (const name of STORAGE_DATABASE_ENV) {
    if (readEnv(name)) return name;
  }
  return null;
}

export function getStorageDatabaseEnv(): StorageEnv | null {
  const name = getStorageDatabaseEnvName();
  return name ? { name } : null;
}

export function getStorageDatabaseUrl(): string | null {
  const env = getStorageDatabaseEnv();
  return env ? readEnv(env.name) ?? null : null;
}

/**
 * Which data backend hooks storage talks to. Explicit configuration wins; otherwise the
 * presence of a database URL is the answer, exactly as before.
 *
 * Throws — never silently falls back — on an unknown value or a retired deployment-mode name.
 */
export function getStorageBackend(): StorageBackend {
  assertNoRetiredModeEnv();
  const backend = normalizeStorageBackend(readEnv(HOOKS_STORAGE_BACKEND_ENV), HOOKS_STORAGE_BACKEND_ENV)
    ?? normalizeStorageBackend(readEnv(HOOKS_STORAGE_BACKEND_FALLBACK_ENV), HOOKS_STORAGE_BACKEND_FALLBACK_ENV);
  if (backend) return backend;
  return getStorageDatabaseUrl() ? "postgresql" : "sqlite";
}

export async function getStoragePg(): Promise<PgAdapterAsync> {
  const url = getStorageDatabaseUrl();
  if (!url) {
    throw new Error("Missing HASNA_HOOKS_DATABASE_URL or HOOKS_DATABASE_URL");
  }
  return new PgAdapterAsync(url);
}

export async function runStorageMigrations(remote: PgAdapterAsync): Promise<void> {
  await remote.run("CREATE EXTENSION IF NOT EXISTS pgcrypto");
  for (const sql of PG_MIGRATIONS) await remote.run(sql);
}

export async function storagePush(options?: { tables?: string[] }): Promise<SyncResult[]> {
  const remote = await getStoragePg();
  const db = getDb();
  try {
    await runStorageMigrations(remote);
    const results: SyncResult[] = [];
    for (const table of resolveTables(options?.tables)) {
      results.push(await pushTable(db, remote, table));
    }
    recordSyncMeta(db, "push", results);
    return results;
  } finally {
    await remote.close();
  }
}

export async function storagePull(options?: { tables?: string[] }): Promise<SyncResult[]> {
  const remote = await getStoragePg();
  const db = getDb();
  try {
    await runStorageMigrations(remote);
    const results: SyncResult[] = [];
    for (const table of resolveTables(options?.tables)) {
      results.push(await pullTable(remote, db, table));
    }
    recordSyncMeta(db, "pull", results);
    return results;
  } finally {
    await remote.close();
  }
}

export async function storageSync(options?: { tables?: string[] }): Promise<{ pull: SyncResult[]; push: SyncResult[] }> {
  const pull = await storagePull(options);
  const push = await storagePush(options);
  return { pull, push };
}

export function getSyncMetaAll(): SyncMeta[] {
  const db = getDb();
  ensureSyncMetaTable(db);
  return db.all("SELECT table_name, last_synced_at, direction FROM _hooks_sync_meta ORDER BY table_name, direction") as SyncMeta[];
}

export function getStorageStatus(): StorageStatus {
  const activeEnv = getStorageDatabaseEnv();
  return {
    configured: Boolean(activeEnv),
    backend: getStorageBackend(),
    env: STORAGE_DATABASE_ENV,
    activeEnv: activeEnv?.name ?? null,
    service: "hooks",
    tables: STORAGE_TABLES,
    sync: getSyncMetaAll(),
  };
}

export function resolveTables(tables?: string[]): StorageTable[] {
  if (!tables || tables.length === 0) return [...STORAGE_TABLES];
  const allowed = new Set<string>(STORAGE_TABLES);
  const requested = tables.map((table) => table.trim()).filter(Boolean);
  const invalid = requested.filter((table) => !allowed.has(table));
  if (invalid.length > 0) throw new Error(`Unknown hooks sync table(s): ${invalid.join(", ")}`);
  return requested as StorageTable[];
}

export function parseStorageTables(value?: string | string[] | null): StorageTable[] | undefined {
  if (!value) return undefined;
  return resolveTables(Array.isArray(value) ? value : value.split(","));
}

async function pushTable(db: DbAdapter, remote: PgAdapterAsync, table: StorageTable): Promise<SyncResult> {
  const result: SyncResult = { table, rowsRead: 0, rowsWritten: 0, errors: [] };
  try {
    if (!tableExists(db, table)) return result;
    const rows = db.all(`SELECT * FROM ${quoteIdent(table)}`) as Row[];
    result.rowsRead = rows.length;
    if (rows.length === 0) return result;
    const remoteColumns = await getRemoteColumns(remote, table);
    const columns = filterRemoteColumns(remoteColumns, Object.keys(rows[0]!));
    result.rowsWritten = await upsertPg(remote, table, columns, rows, remoteColumns);
  } catch (error) {
    result.errors.push(error instanceof Error ? error.message : String(error));
  }
  return result;
}

async function pullTable(remote: PgAdapterAsync, db: DbAdapter, table: StorageTable): Promise<SyncResult> {
  const result: SyncResult = { table, rowsRead: 0, rowsWritten: 0, errors: [] };
  try {
    if (!tableExists(db, table)) return result;
    const rows = await remote.all(`SELECT * FROM ${quoteIdent(table)}`) as Row[];
    result.rowsRead = rows.length;
    if (rows.length === 0) return result;
    const columns = filterLocalColumns(db, table, Object.keys(rows[0]!));
    result.rowsWritten = upsertSqlite(db, table, columns, rows);
  } catch (error) {
    result.errors.push(error instanceof Error ? error.message : String(error));
  }
  return result;
}

async function getRemoteColumns(remote: PgAdapterAsync, table: string): Promise<Map<string, string>> {
  const rows = await remote.all(
    "SELECT column_name, data_type FROM information_schema.columns WHERE table_schema = 'public' AND table_name = ?",
    table,
  ) as Array<{ column_name: string; data_type: string }>;
  return new Map(rows.map((row) => [row.column_name, row.data_type]));
}

function filterRemoteColumns(remoteColumns: Map<string, string>, columns: string[]): string[] {
  if (remoteColumns.size === 0) return columns;
  return columns.filter((column) => remoteColumns.has(column));
}

function filterLocalColumns(db: DbAdapter, table: string, columns: string[]): string[] {
  const rows = db.all(`PRAGMA table_info(${quoteIdent(table)})`) as Array<{ name: string }>;
  const allowed = new Set(rows.map((row) => row.name));
  return columns.filter((column) => allowed.has(column));
}

async function upsertPg(remote: PgAdapterAsync, table: StorageTable, columns: string[], rows: Row[], remoteColumns: Map<string, string>): Promise<number> {
  if (columns.length === 0) return 0;
  const primaryKeys = PRIMARY_KEYS[table];
  const columnList = columns.map(quoteIdent).join(", ");
  const placeholders = columns.map(() => "?").join(", ");
  const keyList = primaryKeys.map(quoteIdent).join(", ");
  const updateColumns = columns.filter((column) => !primaryKeys.includes(column));
  const fallbackKey = primaryKeys[0]!;
  const setClause = updateColumns.length > 0
    ? updateColumns.map((column) => `${quoteIdent(column)} = EXCLUDED.${quoteIdent(column)}`).join(", ")
    : `${quoteIdent(fallbackKey)} = EXCLUDED.${quoteIdent(fallbackKey)}`;

  for (const row of rows) {
    await remote.run(
      `INSERT INTO ${quoteIdent(table)} (${columnList}) VALUES (${placeholders})
       ON CONFLICT (${keyList}) DO UPDATE SET ${setClause}`,
      ...columns.map((column) => coerceForPg(row[column], remoteColumns.get(column))),
    );
  }
  return rows.length;
}

function upsertSqlite(db: DbAdapter, table: StorageTable, columns: string[], rows: Row[]): number {
  if (columns.length === 0) return 0;
  const primaryKeys = PRIMARY_KEYS[table];
  const columnList = columns.map(quoteIdent).join(", ");
  const placeholders = columns.map(() => "?").join(", ");
  const keyList = primaryKeys.map(quoteIdent).join(", ");
  const updateColumns = columns.filter((column) => !primaryKeys.includes(column));
  const fallbackKey = primaryKeys[0]!;
  const setClause = updateColumns.length > 0
    ? updateColumns.map((column) => `${quoteIdent(column)} = excluded.${quoteIdent(column)}`).join(", ")
    : `${quoteIdent(fallbackKey)} = excluded.${quoteIdent(fallbackKey)}`;
  const statement = db.prepare(
    `INSERT INTO ${quoteIdent(table)} (${columnList}) VALUES (${placeholders})
     ON CONFLICT (${keyList}) DO UPDATE SET ${setClause}`,
  );
  db.transaction(() => {
    for (const row of rows) statement.run(...columns.map((column) => coerceForSqlite(row[column])));
  });
  return rows.length;
}

function recordSyncMeta(db: DbAdapter, direction: "push" | "pull", results: SyncResult[]): void {
  ensureSyncMetaTable(db);
  const now = new Date().toISOString();
  const statement = db.prepare(`
    INSERT INTO _hooks_sync_meta (table_name, last_synced_at, direction)
    VALUES (?, ?, ?)
    ON CONFLICT(table_name, direction) DO UPDATE SET last_synced_at = excluded.last_synced_at
  `);
  for (const result of results) {
    if (result.errors.length > 0) continue;
    statement.run(result.table, now, direction);
  }
}

function ensureSyncMetaTable(db: DbAdapter): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS _hooks_sync_meta (
      table_name TEXT NOT NULL,
      last_synced_at TEXT,
      direction TEXT NOT NULL CHECK(direction IN ('push', 'pull')),
      PRIMARY KEY (table_name, direction)
    )
  `);
}

function tableExists(db: DbAdapter, table: string): boolean {
  const row = db.get("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?", table);
  return Boolean(row);
}

function quoteIdent(identifier: string): string {
  return `"${identifier.replace(/"/g, '""')}"`;
}

function coerceForPg(value: unknown, dataType?: string): unknown {
  if (value === undefined || value === null) return null;
  if (dataType === "boolean") {
    if (typeof value === "boolean") return value;
    if (typeof value === "number") return value !== 0;
    if (typeof value === "string") return value === "1" || value.toLowerCase() === "true";
  }
  if (value instanceof Date) return value.toISOString();
  if (Buffer.isBuffer(value) || value instanceof Uint8Array) return value;
  if (typeof value === "object") return JSON.stringify(value);
  return value;
}

function coerceForSqlite(value: unknown): string | number | bigint | boolean | null | Uint8Array {
  if (value === undefined || value === null) return null;
  if (typeof value === "string" || typeof value === "number" || typeof value === "bigint" || typeof value === "boolean") return value;
  if (value instanceof Date) return value.toISOString();
  if (Buffer.isBuffer(value) || value instanceof Uint8Array) return value;
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}
