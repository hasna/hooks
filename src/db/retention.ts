/**
 * Retention/cleanup — auto-prune hook_events older than N days.
 *
 * Configurable via HOOKS_RETENTION_DAYS env var (default: 30).
 * Called on DB open after migrations.
 */

import type { Database } from "bun:sqlite";

export function runRetention(db: Database, days?: number): number {
  const envDays = parseInt(process.env.HOOKS_RETENTION_DAYS ?? "30");
  const retentionDays = days ?? (isNaN(envDays) || envDays <= 0 ? 30 : envDays);
  const cutoff = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000).toISOString();

  try {
    db.run("DELETE FROM hook_events WHERE timestamp < ?", [cutoff]);
    const changes = db.query<{ changes: number }, []>("SELECT changes() as changes").get()?.changes ?? 0;
    return changes;
  } catch {
    return 0;
  }
}
