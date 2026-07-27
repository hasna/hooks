import type { Database } from "bun:sqlite";
import { getDb } from "./index.js";
import type { HookEventRow } from "./schema.js";

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
