/**
 * Migration runner — applies pending migrations in order.
 * Tracks applied migrations in a `schema_migrations` table.
 * Migrations are additive-only, never destructive.
 */

import type { DbAdapter } from "@hasna/cloud";
import { up as migration001 } from "./001_initial";
import { up as migration002 } from "./002_session_events";
import { up as migration003 } from "./003_user_prompt_submit_event";

interface Migration {
  version: string;
  up: (db: DbAdapter) => void;
}

const MIGRATIONS: Migration[] = [
  { version: "001_initial", up: migration001 },
  { version: "002_session_events", up: migration002 },
  { version: "003_user_prompt_submit_event", up: migration003 },
];

function ensureMigrationsTable(db: DbAdapter): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version    TEXT PRIMARY KEY,
      applied_at TEXT NOT NULL
    )
  `);
}

function getApplied(db: DbAdapter): Set<string> {
  const rows = db.all("SELECT version FROM schema_migrations") as Array<{ version: string }>;
  return new Set(rows.map((r) => r.version));
}

export function runMigrations(db: DbAdapter): void {
  ensureMigrationsTable(db);
  const applied = getApplied(db);

  for (const migration of MIGRATIONS) {
    if (applied.has(migration.version)) continue;

    migration.up(db);
    db.run(
      "INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)",
      migration.version,
      new Date().toISOString(),
    );
  }
}
