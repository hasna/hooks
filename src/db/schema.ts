/**
 * hook_events table schema and DDL
 */

import type { Database } from "bun:sqlite";

export const CREATE_HOOK_EVENTS_TABLE = `
  CREATE TABLE IF NOT EXISTS hook_events (
    id           TEXT PRIMARY KEY,
    timestamp    TEXT NOT NULL,
    session_id   TEXT NOT NULL,
    hook_name    TEXT NOT NULL,
    event_type   TEXT NOT NULL CHECK (event_type IN ('PreToolUse', 'PostToolUse', 'Stop', 'Notification')),
    tool_name    TEXT,
    tool_input   TEXT,
    result       TEXT CHECK (result IN ('continue', 'block', NULL)),
    error        TEXT,
    duration_ms  INTEGER,
    project_dir  TEXT,
    metadata     TEXT
  )
`;

export const CREATE_INDEXES = [
  `CREATE INDEX IF NOT EXISTS idx_hook_events_timestamp  ON hook_events (timestamp)`,
  `CREATE INDEX IF NOT EXISTS idx_hook_events_session_id ON hook_events (session_id)`,
  `CREATE INDEX IF NOT EXISTS idx_hook_events_hook_name  ON hook_events (hook_name)`,
  `CREATE INDEX IF NOT EXISTS idx_hook_events_event_type ON hook_events (event_type)`,
  `CREATE INDEX IF NOT EXISTS idx_hook_events_errors     ON hook_events (timestamp) WHERE error IS NOT NULL`,
];

export interface HookEventRow {
  id: string;
  timestamp: string;
  session_id: string;
  hook_name: string;
  event_type: "PreToolUse" | "PostToolUse" | "Stop" | "Notification";
  tool_name: string | null;
  tool_input: string | null;
  result: "continue" | "block" | null;
  error: string | null;
  duration_ms: number | null;
  project_dir: string | null;
  metadata: string | null;
}

export function applySchema(db: Database): void {
  db.exec(CREATE_HOOK_EVENTS_TABLE);
  for (const idx of CREATE_INDEXES) {
    db.exec(idx);
  }
}
