import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runLegacyImport } from "./legacy-import.js";
import { applySchema } from "./schema.js";

interface ImportedEvent {
  timestamp: string;
  session_id: string;
  hook_name: string;
  event_type: string;
  tool_name: string | null;
  tool_input: string | null;
  error: string | null;
}

let db: Database;
let tempHome: string;

function projectsDir(): string {
  return join(tempHome, ".claude", "projects");
}

function importedEvents(): ImportedEvent[] {
  return db.query<ImportedEvent, []>(
    `SELECT timestamp, session_id, hook_name, event_type, tool_name, tool_input, error
     FROM hook_events ORDER BY timestamp, hook_name`,
  ).all();
}

beforeEach(() => {
  tempHome = mkdtempSync(join(tmpdir(), "hooks-legacy-import-test-"));
  db = new Database(":memory:");
  applySchema(db);
});

afterEach(() => {
  db.close();
  mock.restore();
  rmSync(tempHome, { recursive: true, force: true });
});

describe("runLegacyImport", () => {
  test("imports valid JSONL and error entries, skips malformed lines, and only runs once", () => {
    const projectDir = join(projectsDir(), "project-a");
    mkdirSync(projectDir, { recursive: true });
    writeFileSync(join(projectDir, "session-log-2026-07-29.jsonl"), [
      JSON.stringify({
        timestamp: "2026-07-29T00:00:00.000Z",
        session_id: "session-a",
        tool_name: "Read",
        tool_input: "src/index.ts",
      }),
      "not json",
      JSON.stringify({
        timestamp: "2026-07-29T00:01:00.000Z",
        tool_name: "Write",
        tool_input: "x".repeat(600),
      }),
      "",
    ].join("\n"));
    writeFileSync(join(projectDir, "errors.log"), [
      "[2026-07-29T00:02:00.000Z] [session:abc] Build — failed to compile",
      `[2026-07-29T00:03:00.000Z] Runtime — ${"e".repeat(600)}`,
      "malformed error line",
    ].join("\n"));
    writeFileSync(
      join(projectDir, "session-log-current.jsonl"),
      JSON.stringify({ timestamp: "2026-07-29T00:04:00.000Z" }),
    );

    runLegacyImport(db, tempHome);

    const events = importedEvents();
    expect(events).toHaveLength(4);
    expect(events[0]).toEqual({
      timestamp: "2026-07-29T00:00:00.000Z",
      session_id: "session-a",
      hook_name: "sessionlog",
      event_type: "PostToolUse",
      tool_name: "Read",
      tool_input: "src/index.ts",
      error: null,
    });
    expect(events[1]).toMatchObject({
      session_id: "legacy",
      hook_name: "sessionlog",
      tool_name: "Write",
    });
    expect(events[1]?.tool_input).toHaveLength(500);
    expect(events[2]).toMatchObject({
      session_id: "legacy-abc",
      hook_name: "errornotify",
      event_type: "PostToolUse",
      error: "failed to compile",
    });
    expect(events[3]).toMatchObject({ session_id: "legacy", hook_name: "errornotify" });
    expect(events[3]?.error).toHaveLength(500);
    expect(db.query<{ value: string }, []>(
      "SELECT value FROM _meta WHERE key = 'legacy_import_done'",
    ).get()).toEqual({ value: "1" });

    writeFileSync(
      join(projectDir, "session-log-2026-07-30.jsonl"),
      JSON.stringify({ timestamp: "2026-07-30T00:00:00.000Z" }),
    );
    runLegacyImport(db, tempHome);
    expect(importedEvents()).toHaveLength(4);
  });

  test("marks an absent legacy directory complete without inserting events", () => {
    runLegacyImport(db, tempHome);

    expect(importedEvents()).toEqual([]);
    expect(db.query<{ value: string }, []>(
      "SELECT value FROM _meta WHERE key = 'legacy_import_done'",
    ).get()).toEqual({ value: "1" });
  });

  test("skips unreadable project entries and files without aborting the import", () => {
    mkdirSync(projectsDir(), { recursive: true });
    writeFileSync(join(projectsDir(), "not-a-directory"), "not a project directory");
    const projectDir = join(projectsDir(), "project-b");
    mkdirSync(join(projectDir, "errors.log"), { recursive: true });
    writeFileSync(join(projectDir, "session-log-2026-07-29.jsonl"), "{malformed");

    expect(() => runLegacyImport(db, tempHome)).not.toThrow();
    expect(importedEvents()).toEqual([]);
    expect(db.query<{ value: string }, []>(
      "SELECT value FROM _meta WHERE key = 'legacy_import_done'",
    ).get()).toEqual({ value: "1" });
  });

  test("contains database write failures and still records completion", () => {
    db.close();
    db = new Database(":memory:");
    const projectDir = join(projectsDir(), "project-c");
    mkdirSync(projectDir, { recursive: true });
    writeFileSync(
      join(projectDir, "session-log-2026-07-29.jsonl"),
      JSON.stringify({ timestamp: "2026-07-29T00:00:00.000Z" }),
    );

    expect(() => runLegacyImport(db, tempHome)).not.toThrow();
    expect(db.query<{ value: string }, []>(
      "SELECT value FROM _meta WHERE key = 'legacy_import_done'",
    ).get()).toEqual({ value: "1" });
  });
});
