/**
 * Shared hook DB writer — single write path for all observability hooks.
 *
 * In local mode the event is inserted straight into SQLite. In an API storage
 * mode the event is POSTed to the configured Hooks `/v1` authority so that the
 * `hooks log` commands — which read from that same authority — can see it. If
 * the authority is unreachable or misconfigured the event is spooled into the
 * local database instead of being dropped; `hooks storage push` drains that
 * spool to the authority (row upserts are keyed on the event id, so draining is
 * idempotent).
 *
 * Never throws: errors are written to stderr only.
 */

import type { HooksApiClient } from "../cli/cloud-router";
import { insertHookEvent, buildHookEventRow, type HookEventInput as HookEventRowInput } from "../db/log-store";
import type { HookEventRow } from "../db/schema";

export type HookEventInput = Omit<HookEventRowInput, "id">;

async function resolveApiClient(): Promise<HooksApiClient | null> {
  try {
    const { getHooksApiClient } = await import("../cli/cloud-router");
    return getHooksApiClient();
  } catch (err) {
    process.stderr.write(`[hooks db-writer] Hooks API routing unavailable, spooling locally: ${err}\n`);
    return null;
  }
}

function spool(row: HookEventRow): void {
  try {
    insertHookEvent(row);
  } catch (err) {
    process.stderr.write(`[hooks db-writer] failed to write event: ${err}\n`);
  }
}

export async function writeHookEvent(event: HookEventInput): Promise<void> {
  let row: HookEventRow;
  try {
    row = buildHookEventRow(event);
  } catch (err) {
    process.stderr.write(`[hooks db-writer] failed to write event: ${err}\n`);
    return;
  }

  const client = await resolveApiClient();
  if (client) {
    try {
      await client.appendHookEvent(row);
      return;
    } catch (err) {
      process.stderr.write(
        `[hooks db-writer] Hooks API write failed, spooling locally for 'hooks storage push': ${err}\n`,
      );
    }
  }

  spool(row);
}
