import { describe, test, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { runMigrations } from "./index";
import { up as migration002 } from "./002_session_events";

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

function insertEvent(db: Database, id: string, eventType: string): void {
  db.run(
    `INSERT INTO hook_events (id, timestamp, session_id, hook_name, event_type)
     VALUES (?, ?, ?, ?, ?)`,
    [id, new Date().toISOString(), "session-1", "sessionlog", eventType]
  );
}

describe("migrations", () => {
  test("fresh database accepts SessionStart/SessionEnd events", () => {
    const db = new Database(":memory:");
    runMigrations(db);

    insertEvent(db, "e1", "SessionStart");
    insertEvent(db, "e2", "SessionEnd");
    insertEvent(db, "e3", "PreToolUse");

    const rows = db.query<{ event_type: string }, []>("SELECT event_type FROM hook_events").all();
    expect(rows.map((r) => r.event_type).sort()).toEqual(["PreToolUse", "SessionEnd", "SessionStart"]);
    db.close();
  });

  test("002 rebuilds a legacy table so session events are accepted and rows survive", () => {
    const db = new Database(":memory:");
    db.exec(LEGACY_HOOK_EVENTS_TABLE);
    insertEvent(db, "legacy-1", "PreToolUse");

    // Legacy CHECK rejects session events before the migration
    expect(() => insertEvent(db, "should-fail", "SessionStart")).toThrow();

    migration002(db);

    // Existing rows preserved
    const kept = db
      .query<{ id: string }, []>("SELECT id FROM hook_events")
      .all()
      .map((r) => r.id);
    expect(kept).toEqual(["legacy-1"]);

    // New event types accepted after rebuild
    insertEvent(db, "post-migration", "SessionStart");
    insertEvent(db, "post-migration-2", "SessionEnd");
    const count = db.query<{ n: number }, []>("SELECT COUNT(*) as n FROM hook_events").get();
    expect(count?.n).toBe(3);

    // Invalid event types still rejected
    expect(() => insertEvent(db, "bad", "MadeUpEvent")).toThrow();
    db.close();
  });

  test("002 is idempotent on an already-current table", () => {
    const db = new Database(":memory:");
    runMigrations(db);
    insertEvent(db, "e1", "SessionStart");

    migration002(db); // second run must be a no-op, not a failure

    const kept = db.query<{ id: string }, []>("SELECT id FROM hook_events").all();
    expect(kept).toHaveLength(1);
    db.close();
  });

  test("runMigrations records both migrations exactly once", () => {
    const db = new Database(":memory:");
    runMigrations(db);
    runMigrations(db); // re-running must not double-apply

    const versions = db
      .query<{ version: string }, []>("SELECT version FROM schema_migrations ORDER BY version")
      .all()
      .map((r) => r.version);
    expect(versions).toEqual(["001_initial", "002_session_events"]);
    db.close();
  });

  test("migrating a legacy DB via runMigrations upgrades the CHECK constraint", () => {
    const db = new Database(":memory:");
    // Simulate a DB created by 001 only (old schema, 001 recorded)
    db.exec(`CREATE TABLE schema_migrations (version TEXT PRIMARY KEY, applied_at TEXT NOT NULL)`);
    db.exec(LEGACY_HOOK_EVENTS_TABLE);
    db.run("INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)", [
      "001_initial",
      new Date().toISOString(),
    ]);
    insertEvent(db, "old-row", "Stop");

    runMigrations(db);

    insertEvent(db, "new-row", "SessionEnd");
    const rows = db
      .query<{ id: string }, []>("SELECT id FROM hook_events ORDER BY id")
      .all()
      .map((r) => r.id);
    expect(rows).toEqual(["new-row", "old-row"]);
    db.close();
  });
});
