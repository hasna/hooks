/**
 * Shared hook DB writer — single write path for all observability hooks.
 * Never throws: errors are written to stderr only.
 */

import { getDb } from "../db";
import type { HookEventRow } from "../db/schema";

export type HookEventInput = Omit<HookEventRow, "id" | "timestamp"> & {
  timestamp?: string;
};

function nanoid(): string {
  return crypto.randomUUID().replace(/-/g, "").slice(0, 21);
}

export function writeHookEvent(event: HookEventInput): void {
  try {
    const db = getDb();
    const id = nanoid();
    const timestamp = event.timestamp ?? new Date().toISOString();

    db.run(
      `INSERT INTO hook_events
        (id, timestamp, session_id, hook_name, event_type, tool_name, tool_input, result, error, duration_ms, project_dir, metadata)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        timestamp,
        event.session_id,
        event.hook_name,
        event.event_type,
        event.tool_name ?? null,
        event.tool_input ? event.tool_input.slice(0, 500) : null,
        event.result ?? null,
        event.error ?? null,
        event.duration_ms ?? null,
        event.project_dir ?? null,
        event.metadata ?? null,
      ]
    );
  } catch (err) {
    process.stderr.write(`[hooks db-writer] failed to write event: ${err}\n`);
  }
}
