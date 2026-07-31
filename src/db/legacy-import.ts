/**
 * Legacy flat-file import — runs once on first DB creation.
 *
 * Scans for old .claude/session-log-*.jsonl and .claude/errors.log files
 * in the user's home projects directory and imports their entries into hook_events.
 *
 * Non-blocking: any failure is logged to stderr and skipped.
 * Tracks completion via a `_meta` table row keyed "legacy_import_done".
 */

import type { Database } from "bun:sqlite";
import { existsSync, readdirSync, readFileSync } from "fs";
import { join } from "path";
import { homedir } from "os";

const META_KEY = "legacy_import_done";

function ensureMetaTable(db: Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS _meta (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    )
  `);
}

function isAlreadyDone(db: Database): boolean {
  ensureMetaTable(db);
  const row = db.query<{ value: string }, [string]>("SELECT value FROM _meta WHERE key = ?").get(META_KEY);
  return row?.value === "1";
}

function markDone(db: Database): void {
  db.run("INSERT OR REPLACE INTO _meta (key, value) VALUES (?, ?)", [META_KEY, "1"]);
}

function nanoid(): string {
  return crypto.randomUUID().replace(/-/g, "").slice(0, 21);
}

function importJsonlFile(db: Database, filePath: string): number {
  let count = 0;
  try {
    const lines = readFileSync(filePath, "utf-8").split("\n").filter(Boolean);
    for (const line of lines) {
      try {
        const entry = JSON.parse(line);
        db.run(
          `INSERT OR IGNORE INTO hook_events
            (id, timestamp, session_id, hook_name, event_type, tool_name, tool_input, project_dir)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            nanoid(),
            entry.timestamp ?? new Date().toISOString(),
            entry.session_id ?? "legacy",
            "sessionlog",
            "PostToolUse",
            entry.tool_name ?? null,
            entry.tool_input ? String(entry.tool_input).slice(0, 500) : null,
            null,
          ]
        );
        count++;
      } catch {
        // Skip malformed lines
      }
    }
  } catch {
    // File unreadable — skip
  }
  return count;
}

function importErrorsLog(db: Database, filePath: string): number {
  let count = 0;
  try {
    const lines = readFileSync(filePath, "utf-8").split("\n").filter(Boolean);
    // Format: [ISO] [session:XXXX] Context — Error message
    const linePattern = /^\[(.+?)\]\s+(?:\[session:(\S+)\]\s+)?(.+?)\s+—\s+(.+)$/;

    for (const line of lines) {
      try {
        const m = line.match(linePattern);
        if (!m) continue;
        const [, timestamp, sessionPrefix, , errorMsg] = m;
        db.run(
          `INSERT OR IGNORE INTO hook_events
            (id, timestamp, session_id, hook_name, event_type, error)
           VALUES (?, ?, ?, ?, ?, ?)`,
          [
            nanoid(),
            timestamp,
            sessionPrefix ? `legacy-${sessionPrefix}` : "legacy",
            "errornotify",
            "PostToolUse",
            errorMsg.slice(0, 500),
          ]
        );
        count++;
      } catch {
        // Skip malformed lines
      }
    }
  } catch {
    // File unreadable — skip
  }
  return count;
}

export function runLegacyImport(db: Database): void {
  try {
    if (isAlreadyDone(db)) return;

    let total = 0;

    // Scan ~/.claude/projects/<hash>/ directories for session log files
    const claudeProjectsDir = join(homedir(), ".claude", "projects");
    if (existsSync(claudeProjectsDir)) {
      try {
        const projectDirs = readdirSync(claudeProjectsDir);
        for (const dir of projectDirs) {
          const projectDir = join(claudeProjectsDir, dir);
          try {
            const files = readdirSync(projectDir);
            for (const file of files) {
              if (file.match(/^session-log-\d{4}-\d{2}-\d{2}\.jsonl$/)) {
                total += importJsonlFile(db, join(projectDir, file));
              }
              if (file === "errors.log") {
                total += importErrorsLog(db, join(projectDir, file));
              }
            }
          } catch {
            // Skip unreadable project dirs
          }
        }
      } catch {
        // Skip if projects dir unreadable
      }
    }

    markDone(db);

    if (total > 0) {
      process.stderr.write(`[hooks] Imported ${total} legacy log entries into SQLite.\n`);
    }
  } catch (err) {
    process.stderr.write(`[hooks] Legacy import failed (non-fatal): ${err}\n`);
  }
}
