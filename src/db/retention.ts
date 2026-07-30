/**
 * Retention/cleanup — auto-prune hook_events older than N days.
 *
 * Configurable via HOOKS_RETENTION_DAYS env var (default: 30).
 * Called on DB open after migrations.
 */

import type { DbAdapter } from "@hasna/cloud";

export function runRetention(db: DbAdapter, days?: number): number {
  const envDays = parseInt(process.env.HOOKS_RETENTION_DAYS ?? "30");
  const retentionDays = days ?? (isNaN(envDays) || envDays <= 0 ? 30 : envDays);
  const cutoff = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000).toISOString();

  try {
    db.run("DELETE FROM hook_events WHERE timestamp < ?", cutoff);
    const row = db.get("SELECT changes() as changes") as { changes: number } | undefined;
    const changes = row?.changes ?? 0;
    return changes;
  } catch {
    return 0;
  }
}
