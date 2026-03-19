/**
 * Migration runner — applies pending migrations in order.
 * Tracks applied migrations in a `schema_migrations` table.
 * Migrations are additive-only, never destructive.
 */

import type { Database } from "bun:sqlite";
import { up as migration001 } from "./001_initial";

interface Migration {
  version: string;
  up: (db: Database) => void;
}

const MIGRATIONS: Migration[] = [{ version: "001_initial", up: migration001 }];

function ensureMigrationsTable(db: Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version    TEXT PRIMARY KEY,
      applied_at TEXT NOT NULL
    )
  `);
}

function getApplied(db: Database): Set<string> {
  const rows = db.query<{ version: string }, []>("SELECT version FROM schema_migrations").all();
  return new Set(rows.map((r) => r.version));
}

export function runMigrations(db: Database): void {
  ensureMigrationsTable(db);
  const applied = getApplied(db);

  for (const migration of MIGRATIONS) {
    if (applied.has(migration.version)) continue;

    migration.up(db);
    db.run("INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)", [
      migration.version,
      new Date().toISOString(),
    ]);
  }
}
