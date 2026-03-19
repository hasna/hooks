#!/usr/bin/env bun

/**
 * Claude Code Hook: costwatch
 *
 * Stop hook that estimates session token usage and persists cost data to
 * SQLite (~/.hooks/hooks.db) for cross-session history queries.
 *
 * Configuration:
 * - Environment variable: COST_WATCH_BUDGET (max $ per session, e.g. "5.00")
 * - If not set, no budget enforcement (just logs a reminder)
 *
 * Token estimation: ~4 chars/token, blended rate ~$30/M tokens.
 */

import { readFileSync, existsSync, readdirSync, statSync } from "fs";
import { join } from "path";
import { writeHookEvent } from "../../../src/lib/db-writer";

interface HookInput {
  session_id: string;
  cwd: string;
  hook_event_name: string;
  transcript_path?: string;
}

interface HookOutput {
  continue: boolean;
}

const BLENDED_COST_PER_MILLION_TOKENS = 30;
const CHARS_PER_TOKEN = 4;

function readStdinJson(): HookInput | null {
  try {
    const input = readFileSync(0, "utf-8").trim();
    if (!input) return null;
    return JSON.parse(input);
  } catch {
    return null;
  }
}

function respond(output: HookOutput): void {
  console.log(JSON.stringify(output));
}

function getBudget(): number | null {
  const budgetStr = process.env.COST_WATCH_BUDGET;
  if (!budgetStr) return null;

  const budget = parseFloat(budgetStr);
  if (isNaN(budget) || budget <= 0) {
    process.stderr.write(
      `[hook-costwatch] Invalid COST_WATCH_BUDGET value: "${budgetStr}". Must be a positive number.\n`
    );
    return null;
  }
  return budget;
}

function estimateTranscriptCost(transcriptPath: string): {
  charCount: number;
  estimatedTokens: number;
  estimatedCost: number;
} | null {
  try {
    if (!existsSync(transcriptPath)) return null;
    const stat = statSync(transcriptPath);
    const charCount = stat.size;
    const estimatedTokens = Math.ceil(charCount / CHARS_PER_TOKEN);
    const estimatedCost = (estimatedTokens / 1_000_000) * BLENDED_COST_PER_MILLION_TOKENS;
    return { charCount, estimatedTokens, estimatedCost };
  } catch {
    return null;
  }
}

function findSessionTranscript(cwd: string, sessionId: string): string | null {
  const possibleDirs = [
    join(cwd, ".claude"),
    join(process.env.HOME || "", ".claude", "projects"),
  ];

  for (const dir of possibleDirs) {
    if (!existsSync(dir)) continue;
    try {
      const files = readdirSync(dir, { recursive: true }) as string[];
      for (const file of files) {
        if (typeof file === "string" && file.includes(sessionId)) {
          return join(dir, file);
        }
      }
    } catch {
      // Directory not readable, skip
    }
  }

  return null;
}

export function run(): void {
  const input = readStdinJson();

  if (!input) {
    respond({ continue: true });
    return;
  }

  const budget = getBudget();

  let estimate: { charCount: number; estimatedTokens: number; estimatedCost: number } | null = null;

  if (input.transcript_path) {
    estimate = estimateTranscriptCost(input.transcript_path);
  }

  if (!estimate) {
    const transcriptPath = findSessionTranscript(input.cwd, input.session_id);
    if (transcriptPath) {
      estimate = estimateTranscriptCost(transcriptPath);
    }
  }

  if (estimate) {
    const costStr = estimate.estimatedCost.toFixed(2);
    const tokensStr = (estimate.estimatedTokens / 1000).toFixed(1);
    const budgetExceeded = budget !== null && estimate.estimatedCost > budget;

    process.stderr.write(`[hook-costwatch] Session estimate: ~${tokensStr}K tokens, ~$${costStr}\n`);

    if (budgetExceeded) {
      process.stderr.write(
        `[hook-costwatch] WARNING: Estimated cost ($${costStr}) exceeds budget ($${budget!.toFixed(2)})!\n`
      );
      process.stderr.write(`[hook-costwatch] Check your actual usage at https://console.anthropic.com/\n`);
    }

    writeHookEvent({
      session_id: input.session_id,
      hook_name: "costwatch",
      event_type: "Stop",
      project_dir: input.cwd,
      metadata: JSON.stringify({
        char_count: estimate.charCount,
        estimated_tokens: estimate.estimatedTokens,
        estimated_cost_usd: estimate.estimatedCost,
        budget_usd: budget,
        budget_exceeded: budgetExceeded,
      }),
    });
  } else {
    process.stderr.write(`[hook-costwatch] Could not estimate session cost (no transcript found).\n`);

    writeHookEvent({
      session_id: input.session_id,
      hook_name: "costwatch",
      event_type: "Stop",
      project_dir: input.cwd,
      metadata: JSON.stringify({ error: "no_transcript", budget_usd: budget }),
    });
  }

  if (budget !== null) {
    process.stderr.write(`[hook-costwatch] Budget: $${budget.toFixed(2)}/session. Remember to check actual usage.\n`);
  } else {
    process.stderr.write(`[hook-costwatch] No budget set. Set COST_WATCH_BUDGET env var to enable budget warnings.\n`);
  }

  respond({ continue: true });
}

if (import.meta.main) {
  run();
}
