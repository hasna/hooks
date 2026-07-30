/**
 * Migration 003 — UserPromptSubmit event.
 *
 * Rebuilds hook_events so the event_type CHECK constraint accepts Codewith's
 * UserPromptSubmit. SQLite cannot ALTER a CHECK constraint, so the table is
 * recreated and rows are copied over. Skips the rebuild when the constraint is
 * already current (fresh databases or databases rebuilt by a newer 002).
 */

import type { DbAdapter } from "@hasna/cloud";
import { CREATE_HOOK_EVENTS_TABLE, CREATE_INDEXES } from "../schema";

export function up(db: DbAdapter): void {
  const row = db.get(
    "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?",
    "hook_events",
  ) as { sql: string | null } | undefined;

  if (!row?.sql) return;
  if (row.sql.includes("UserPromptSubmit")) return;

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
