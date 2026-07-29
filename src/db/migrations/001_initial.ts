/**
 * Migration 001 — initial schema
 * Creates hook_events table and indexes.
 */

import type { DbAdapter } from "@hasna/cloud";
import { CREATE_HOOK_EVENTS_TABLE, CREATE_INDEXES } from "../schema";

export function up(db: DbAdapter): void {
  db.exec(CREATE_HOOK_EVENTS_TABLE);
  for (const idx of CREATE_INDEXES) {
    db.exec(idx);
  }
}
