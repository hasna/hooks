/**
 * Migration 002 — allow Codewith-native event types.
 *
 * SQLite cannot alter CHECK constraints in place, so this rebuilds
 * hook_events only when the existing table still has the old event_type check.
 * Data is preserved.
 */

import type { Database } from "bun:sqlite";
import { CREATE_INDEXES } from "../schema";

const NEW_TABLE_SQL = `
  CREATE TABLE hook_events_new (
    id           TEXT PRIMARY KEY,
    timestamp    TEXT NOT NULL,
    session_id   TEXT NOT NULL,
    hook_name    TEXT NOT NULL,
    event_type   TEXT NOT NULL CHECK (event_type IN ('SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'Stop', 'Notification')),
    tool_name    TEXT,
    tool_input   TEXT,
    result       TEXT CHECK (result IN ('continue', 'block', NULL)),
    error        TEXT,
    duration_ms  INTEGER,
    project_dir  TEXT,
    metadata     TEXT
  )
`;

export function up(db: Database): void {
  const row = db.query<{ sql: string }, [string]>("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?").get("hook_events");
  const sql = row?.sql || "";
  if (!sql || (sql.includes("SessionStart") && sql.includes("UserPromptSubmit"))) {
    for (const idx of CREATE_INDEXES) db.exec(idx);
    return;
  }

  db.exec("BEGIN");
  try {
    db.exec(NEW_TABLE_SQL);
    db.exec(`
      INSERT INTO hook_events_new
        (id, timestamp, session_id, hook_name, event_type, tool_name, tool_input, result, error, duration_ms, project_dir, metadata)
      SELECT id, timestamp, session_id, hook_name, event_type, tool_name, tool_input, result, error, duration_ms, project_dir, metadata
      FROM hook_events
    `);
    db.exec("DROP TABLE hook_events");
    db.exec("ALTER TABLE hook_events_new RENAME TO hook_events");
    for (const idx of CREATE_INDEXES) db.exec(idx);
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}
