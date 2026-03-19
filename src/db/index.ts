/**
 * SQLite DB module for hooks — persistent storage at ~/.hooks/hooks.db
 *
 * Uses bun:sqlite with WAL mode for concurrent reads.
 * Supports HOOKS_DATA_DIR and HOOKS_DB_PATH env overrides.
 */

import { Database } from "bun:sqlite";
import { existsSync, mkdirSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import { runMigrations } from "./migrations";
import { runLegacyImport } from "./legacy-import";
import { runRetention } from "./retention";

let instance: Database | null = null;

export function getDbPath(): string {
  if (process.env.HOOKS_DB_PATH) {
    return process.env.HOOKS_DB_PATH;
  }

  const dataDir = process.env.HOOKS_DATA_DIR ?? join(homedir(), ".hooks");
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
