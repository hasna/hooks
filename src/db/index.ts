/**
 * SQLite DB module for hooks — persistent storage at ~/.hasna/hooks/hooks.db
 *
 * Uses bun:sqlite with WAL mode for concurrent reads.
 * Supports HASNA_HOOKS_DATA_DIR / HOOKS_DATA_DIR and HASNA_HOOKS_DB_PATH / HOOKS_DB_PATH env overrides.
 */

import { SqliteAdapter as Database } from "@hasna/cloud";
import { existsSync, mkdirSync, cpSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import { runMigrations } from "./migrations";
import { runLegacyImport } from "./legacy-import";
import { runRetention } from "./retention";

let instance: Database | null = null;

function resolveDataDir(): string {
  const explicit = process.env.HASNA_HOOKS_DATA_DIR ?? process.env.HOOKS_DATA_DIR;
  if (explicit) return explicit;

  const newDir = join(homedir(), ".hasna", "hooks");
  const oldDir = join(homedir(), ".hooks");

  // Auto-migrate: copy old data to new location if needed
  if (!existsSync(newDir) && existsSync(oldDir)) {
    mkdirSync(join(homedir(), ".hasna"), { recursive: true });
    cpSync(oldDir, newDir, { recursive: true });
  }

  return newDir;
}

export function getDbPath(): string {
  const explicitDb = process.env.HASNA_HOOKS_DB_PATH ?? process.env.HOOKS_DB_PATH;
  if (explicitDb) return explicitDb;

  const dataDir = resolveDataDir();
  return join(dataDir, "hooks.db");
}

function ensureDir(dbPath: string): void {
  const dir = dbPath.substring(0, dbPath.lastIndexOf("/"));
  if (dir && !existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
}

export function getDb(): Database {
  if (instance) return instance;

  const dbPath = getDbPath();
  const isNew = dbPath === ":memory:" || !existsSync(dbPath);
  ensureDir(dbPath);

  instance = new Database(dbPath);
  instance.exec("PRAGMA journal_mode=WAL");
  instance.exec("PRAGMA foreign_keys=ON");
  runMigrations(instance);
  runRetention(instance);
  instance.exec(`CREATE TABLE IF NOT EXISTS feedback (
    id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
    message TEXT NOT NULL,
    email TEXT,
    category TEXT DEFAULT 'general',
    version TEXT,
    machine_id TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`);

  if (isNew) {
    runLegacyImport(instance);
  }

  return instance;
}

export function closeDb(): void {
  if (instance) {
    instance.close();
    instance = null;
  }
}

export function createTestDb(): Database {
  const db = new Database(":memory:");
  db.exec("PRAGMA journal_mode=WAL");
  db.exec("PRAGMA foreign_keys=ON");
  return db;
}
