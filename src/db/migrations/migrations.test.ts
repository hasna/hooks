import { describe, test, expect } from "bun:test";
import type { DbAdapter } from "@hasna/cloud";
import { createTestDb } from "../index";
import { runMigrations } from "./index";
import { up as migration002 } from "./002_session_events";
import { up as migration003 } from "./003_user_prompt_submit_event";

/** The pre-002 hook_events table (event_type CHECK without session events). */
const LEGACY_HOOK_EVENTS_TABLE = `
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

/** The pre-003 hook_events table (session events accepted, UserPromptSubmit absent). */
const PRE_003_HOOK_EVENTS_TABLE = `
  CREATE TABLE IF NOT EXISTS hook_events (
    id           TEXT PRIMARY KEY,
    timestamp    TEXT NOT NULL,
    session_id   TEXT NOT NULL,
    hook_name    TEXT NOT NULL,
    event_type   TEXT NOT NULL CHECK (event_type IN ('PreToolUse', 'PostToolUse', 'Stop', 'Notification', 'SessionStart', 'SessionEnd')),
    tool_name    TEXT,
    tool_input   TEXT,
    result       TEXT CHECK (result IN ('continue', 'block', NULL)),
    error        TEXT,
    duration_ms  INTEGER,
    project_dir  TEXT,
    metadata     TEXT
  )
`;

function insertEvent(db: DbAdapter, id: string, eventType: string): void {
  db.run(
    `INSERT INTO hook_events (id, timestamp, session_id, hook_name, event_type)
     VALUES (?, ?, ?, ?, ?)`,
    id,
    new Date().toISOString(),
    "session-1",
    "sessionlog",
    eventType,
  );
}

describe("migrations", () => {
  test("fresh database accepts session and Codewith prompt events", () => {
    const db = createTestDb();
    runMigrations(db);

    insertEvent(db, "e1", "SessionStart");
    insertEvent(db, "e2", "SessionEnd");
    insertEvent(db, "e3", "UserPromptSubmit");
    insertEvent(db, "e4", "PreToolUse");

    const rows = db.all("SELECT event_type FROM hook_events") as Array<{ event_type: string }>;
    expect(rows.map((r) => r.event_type).sort()).toEqual(["PreToolUse", "SessionEnd", "SessionStart", "UserPromptSubmit"]);
    db.close();
  });

  test("002 rebuilds a legacy table so session events are accepted and rows survive", () => {
    const db = createTestDb();
    db.exec(LEGACY_HOOK_EVENTS_TABLE);
    insertEvent(db, "legacy-1", "PreToolUse");

    // Legacy CHECK rejects session events before the migration
    expect(() => insertEvent(db, "should-fail", "SessionStart")).toThrow();

    migration002(db);

    // Existing rows preserved
    const kept = (db.all("SELECT id FROM hook_events") as Array<{ id: string }>).map((r) => r.id);
    expect(kept).toEqual(["legacy-1"]);

    // New event types accepted after rebuild
    insertEvent(db, "post-migration", "SessionStart");
    insertEvent(db, "post-migration-2", "SessionEnd");
    insertEvent(db, "post-migration-3", "UserPromptSubmit");
    const count = db.get("SELECT COUNT(*) as n FROM hook_events") as { n: number } | undefined;
    expect(count?.n).toBe(4);

    // Invalid event types still rejected
    expect(() => insertEvent(db, "bad", "MadeUpEvent")).toThrow();
    db.close();
  });

  test("003 rebuilds a pre-003 table so UserPromptSubmit is accepted and rows survive", () => {
    const db = createTestDb();
    db.exec(PRE_003_HOOK_EVENTS_TABLE);
    insertEvent(db, "legacy-1", "SessionStart");

    expect(() => insertEvent(db, "should-fail", "UserPromptSubmit")).toThrow();

    migration003(db);

    insertEvent(db, "post-migration", "UserPromptSubmit");
    const rows = (db.all("SELECT id FROM hook_events ORDER BY id") as Array<{ id: string }>).map((r) => r.id);
    expect(rows).toEqual(["legacy-1", "post-migration"]);
    db.close();
  });

  test("002 and 003 are idempotent on an already-current table", () => {
    const db = createTestDb();
    runMigrations(db);
    insertEvent(db, "e1", "SessionStart");
    insertEvent(db, "e2", "UserPromptSubmit");

    migration002(db); // second run must be a no-op, not a failure
    migration003(db);

    const kept = db.all("SELECT id FROM hook_events") as Array<{ id: string }>;
    expect(kept).toHaveLength(2);
    db.close();
  });

  test("runMigrations records all migrations exactly once", () => {
    const db = createTestDb();
    runMigrations(db);
    runMigrations(db); // re-running must not double-apply

    const versions = (db.all("SELECT version FROM schema_migrations ORDER BY version") as Array<{ version: string }>).map(
      (r) => r.version,
    );
    expect(versions).toEqual(["001_initial", "002_session_events", "003_user_prompt_submit_event"]);
    db.close();
  });

  test("migrating a legacy DB via runMigrations upgrades the CHECK constraint", () => {
    const db = createTestDb();
    // Simulate a DB created by 001 only (old schema, 001 recorded)
    db.exec(`CREATE TABLE schema_migrations (version TEXT PRIMARY KEY, applied_at TEXT NOT NULL)`);
    db.exec(LEGACY_HOOK_EVENTS_TABLE);
    db.run(
      "INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)",
      "001_initial",
      new Date().toISOString(),
    );
    insertEvent(db, "old-row", "Stop");

    runMigrations(db);

    insertEvent(db, "new-row", "SessionEnd");
    insertEvent(db, "prompt-row", "UserPromptSubmit");
    const rows = (db.all("SELECT id FROM hook_events ORDER BY id") as Array<{ id: string }>).map((r) => r.id);
    expect(rows).toEqual(["new-row", "old-row", "prompt-row"]);
    db.close();
  });
});
