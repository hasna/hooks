import { describe, expect, test } from "bun:test";
import { createTestDb } from "./index.js";
import { applySchema } from "./schema.js";

describe("hook_events schema", () => {
  test("accepts Codewith-native event types", () => {
    const db = createTestDb();
    try {
      applySchema(db);
      db.run(
        `INSERT INTO hook_events (id, timestamp, session_id, hook_name, event_type)
         VALUES (?, ?, ?, ?, ?)`,
        ["evt1", new Date().toISOString(), "sess", "session-start", "SessionStart"],
      );
      db.run(
        `INSERT INTO hook_events (id, timestamp, session_id, hook_name, event_type)
         VALUES (?, ?, ?, ?, ?)`,
        ["evt2", new Date().toISOString(), "sess", "prompt-guard", "UserPromptSubmit"],
      );
      db.run(
        `INSERT INTO hook_events (id, timestamp, session_id, hook_name, event_type)
         VALUES (?, ?, ?, ?, ?)`,
        ["evt3", new Date().toISOString(), "sess", "fleet-catchup", "SessionEnd"],
      );
      const row = db.query<{ count: number }, []>("SELECT COUNT(*) as count FROM hook_events").get();
      expect(row?.count).toBe(3);
    } finally {
      db.close();
    }
  });
});
