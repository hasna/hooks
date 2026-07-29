import type { Database } from "bun:sqlite";
import { existsSync } from "fs";
import { getDb, getDbPath } from "./index.js";
import type { HookEventRow } from "./schema.js";

export interface HookEventInput extends Partial<Omit<HookEventRow, "session_id" | "hook_name" | "event_type">> {
  session_id: string;
  hook_name: string;
  event_type: HookEventRow["event_type"];
}

export interface HookLogListOptions {
  hook?: string;
  session?: string;
  limit?: number;
}

export interface HookLogSearchOptions {
  text: string;
  limit?: number;
}

export interface HookLogErrorsOptions {
  since?: string;
  limit?: number;
}

export interface HookLogSummary {
  since: string;
  hooks: Array<{ hook_name: string; total: number; errors: number; error_rate: string }>;
  totals: { events: number; errors: number; hooks_active: number };
}

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 1000;
const TOOL_INPUT_MAX_LENGTH = 500;

/**
 * Normalize a hook event into the exact row shape both write paths persist —
 * the local SQLite writer and the `/v1/log/events` ingestion route — so an event
 * looks identical whichever backend accepted it.
 */
export function buildHookEventRow(event: HookEventInput): HookEventRow {
  return {
    id: event.id ?? crypto.randomUUID().replace(/-/g, "").slice(0, 21),
    timestamp: event.timestamp ?? new Date().toISOString(),
    session_id: event.session_id,
    hook_name: event.hook_name,
    event_type: event.event_type,
    tool_name: event.tool_name ?? null,
    tool_input: event.tool_input ? event.tool_input.slice(0, TOOL_INPUT_MAX_LENGTH) : null,
    result: event.result ?? null,
    error: event.error ?? null,
    duration_ms: event.duration_ms ?? null,
    project_dir: event.project_dir ?? null,
    metadata: event.metadata ?? null,
  };
}

export function insertHookEvent(event: HookEventInput, db: Database = getDb()): HookEventRow {
  const row = buildHookEventRow(event);
  // REPLACE keyed on id keeps ingestion idempotent when a client retries a POST.
  db.run(
    `INSERT OR REPLACE INTO hook_events
      (id, timestamp, session_id, hook_name, event_type, tool_name, tool_input, result, error, duration_ms, project_dir, metadata)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      row.id,
      row.timestamp,
      row.session_id,
      row.hook_name,
      row.event_type,
      row.tool_name,
      row.tool_input,
      row.result,
      row.error,
      row.duration_ms,
      row.project_dir,
      row.metadata,
    ],
  );
  return row;
}

export function normalizeLogLimit(value: string | number | undefined, fallback = DEFAULT_LIMIT): number {
  const parsed = typeof value === "number" ? value : value ? Number.parseInt(value, 10) : fallback;
  if (!Number.isSafeInteger(parsed) || parsed <= 0) return fallback;
  return Math.min(parsed, MAX_LIMIT);
}

export function parseLogSince(value: string | undefined, fallback = "24h"): string {
  const input = value?.trim() || fallback;
  if (/^\d{4}-\d{2}-\d{2}T/.test(input)) return input;
  const match = input.match(/^(\d+)(s|m|h|d)$/);
  if (!match) return new Date(Date.now() - durationMs(fallback)).toISOString();
  return new Date(Date.now() - durationMs(input)).toISOString();
}

export function listHookEvents(options: HookLogListOptions = {}, db: Database = getDb()): HookEventRow[] {
  const params: Array<string | number> = [];
  let sql = "SELECT * FROM hook_events WHERE 1=1";

  if (options.hook) {
    sql += " AND hook_name = ?";
    params.push(options.hook);
  }
  if (options.session) {
    sql += " AND session_id LIKE ?";
    params.push(`${options.session}%`);
  }
  sql += " ORDER BY timestamp DESC LIMIT ?";
  params.push(normalizeLogLimit(options.limit));

  return db.query(sql).all(...params) as HookEventRow[];
}

export function searchHookEvents(options: HookLogSearchOptions, db: Database = getDb()): HookEventRow[] {
  const limit = normalizeLogLimit(options.limit);
  const query = `%${options.text}%`;
  return db.query(
    "SELECT * FROM hook_events WHERE tool_input LIKE ? OR error LIKE ? ORDER BY timestamp DESC LIMIT ?",
  ).all(query, query, limit) as HookEventRow[];
}

export function tailHookEvents(limit?: number, db: Database = getDb()): HookEventRow[] {
  return db.query("SELECT * FROM hook_events ORDER BY timestamp DESC LIMIT ?")
    .all(normalizeLogLimit(limit, 20)) as HookEventRow[];
}

export function listHookErrors(options: HookLogErrorsOptions = {}, db: Database = getDb()): HookEventRow[] {
  const since = parseLogSince(options.since);
  return db.query(
    "SELECT * FROM hook_events WHERE error IS NOT NULL AND timestamp >= ? ORDER BY timestamp DESC LIMIT ?",
  ).all(since, normalizeLogLimit(options.limit)) as HookEventRow[];
}

export function summarizeHookEvents(options: { since?: string } = {}, db: Database = getDb()): HookLogSummary {
  const since = parseLogSince(options.since);
  const totals = db.query(
    "SELECT hook_name, COUNT(*) as total, SUM(CASE WHEN error IS NOT NULL THEN 1 ELSE 0 END) as errors FROM hook_events WHERE timestamp >= ? GROUP BY hook_name ORDER BY total DESC",
  ).all(since) as Array<{ hook_name: string; total: number; errors: number | null }>;

  const hooks = totals.map((row) => {
    const total = Number(row.total);
    const errors = Number(row.errors ?? 0);
    return {
      hook_name: row.hook_name,
      total,
      errors,
      error_rate: total > 0 ? `${((errors / total) * 100).toFixed(1)}%` : "0%",
    };
  });

  return {
    since,
    hooks,
    totals: {
      events: hooks.reduce((sum, row) => sum + row.total, 0),
      errors: hooks.reduce((sum, row) => sum + row.errors, 0),
      hooks_active: hooks.length,
    },
  };
}

export function clearHookEvents(options: { hook?: string } = {}, db: Database = getDb()): number {
  const countRow = options.hook
    ? db.query("SELECT COUNT(*) as n FROM hook_events WHERE hook_name = ?").get(options.hook) as { n?: number | bigint } | null
    : db.query("SELECT COUNT(*) as n FROM hook_events").get() as { n?: number | bigint } | null;
  const count = Number(countRow?.n ?? 0);
  if (count === 0) return 0;

  if (options.hook) {
    db.run("DELETE FROM hook_events WHERE hook_name = ?", [options.hook]);
  } else {
    db.run("DELETE FROM hook_events");
  }
  return count;
}

/**
 * Delete the local copy of events an API authority has already purged.
 *
 * Under an API authority the local SQLite file is a spool and a pull mirror, not
 * a second source of truth: `storage pull` writes authority rows into it and
 * `storage push` uploads everything it still holds. A clear that only reached
 * the authority is therefore undone by the next routine sync, so the purge has
 * to reach both sides.
 *
 * Returns 0 without touching the filesystem when no local database exists —
 * `getDb()` would create the file and its schema, and an API-mode client with
 * no spool must not grow one just to empty it.
 */
export function clearLocalHookEventMirror(options: { hook?: string } = {}): number {
  const path = getDbPath();
  if (path !== ":memory:" && !existsSync(path)) return 0;
  return clearHookEvents(options);
}

function durationMs(value: string): number {
  const match = value.match(/^(\d+)(s|m|h|d)$/);
  if (!match) return 24 * 60 * 60 * 1000;
  const amount = Number.parseInt(match[1]!, 10);
  switch (match[2]) {
    case "s": return amount * 1000;
    case "m": return amount * 60 * 1000;
    case "h": return amount * 60 * 60 * 1000;
    case "d": return amount * 24 * 60 * 60 * 1000;
    default: return 24 * 60 * 60 * 1000;
  }
}
