/**
 * Migration 002 — session events
 * Rebuilds hook_events so the event_type CHECK constraint accepts
 * 'SessionStart' and 'SessionEnd'. SQLite cannot ALTER a CHECK
 * constraint, so the table is recreated and rows are copied over.
 * Skips the rebuild when the constraint already includes SessionStart
 * (fresh databases created from the updated schema.ts).
 */

import type { Database } from "bun:sqlite";
import { CREATE_HOOK_EVENTS_TABLE, CREATE_INDEXES } from "../schema";

export function up(db: Database): void {
  const row = db
    .query<{ sql: string | null }, [string]>(
      "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?"
    )
    .get("hook_events");

  // Table missing (shouldn't happen — 001 creates it) or already current.
  if (!row?.sql) return;
  if (row.sql.includes("SessionStart")) return;

  db.exec("BEGIN");
  try {
    db.exec("ALTER TABLE hook_events RENAME TO hook_events_old");
    db.exec(CREATE_HOOK_EVENTS_TABLE);
    db.exec(
      `INSERT INTO hook_events
         (id, timestamp, session_id, hook_name, event_type, tool_name, tool_input, result, error, duration_ms, project_dir, metadata)
       SELECT id, timestamp, session_id, hook_name, event_type, tool_name, tool_input, result, error, duration_ms, project_dir, metadata
       FROM hook_events_old`
    );
    db.exec("DROP TABLE hook_events_old");
    for (const idx of CREATE_INDEXES) {
      db.exec(idx);
    }
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}
