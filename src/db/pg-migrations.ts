/**
 * PostgreSQL migrations for open-hooks cloud sync.
 *
 * Equivalent to the SQLite schema in schema.ts, migrations/, and index.ts,
 * translated for PostgreSQL.
 */

export const PG_MIGRATIONS: string[] = [
  // Core table: hook_events
  `CREATE TABLE IF NOT EXISTS hook_events (
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
  )`,

  // Indexes for hook_events
  `CREATE INDEX IF NOT EXISTS idx_hook_events_timestamp  ON hook_events (timestamp)`,
  `CREATE INDEX IF NOT EXISTS idx_hook_events_session_id ON hook_events (session_id)`,
  `CREATE INDEX IF NOT EXISTS idx_hook_events_hook_name  ON hook_events (hook_name)`,
  `CREATE INDEX IF NOT EXISTS idx_hook_events_event_type ON hook_events (event_type)`,
  `CREATE INDEX IF NOT EXISTS idx_hook_events_errors     ON hook_events (timestamp) WHERE error IS NOT NULL`,

  // Schema migrations tracker
  `CREATE TABLE IF NOT EXISTS schema_migrations (
    version    TEXT PRIMARY KEY,
    applied_at TEXT NOT NULL
  )`,

  // Meta table for tracking one-time operations
  `CREATE TABLE IF NOT EXISTS _meta (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  )`,

  // Feedback table
  `CREATE TABLE IF NOT EXISTS feedback (
    id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
    message TEXT NOT NULL,
    email TEXT,
    category TEXT DEFAULT 'general',
    version TEXT,
    machine_id TEXT,
    created_at TEXT NOT NULL DEFAULT NOW()::text
  )`,
];
