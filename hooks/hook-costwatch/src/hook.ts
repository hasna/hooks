#!/usr/bin/env bun

/**
 * Claude Code Hook: costwatch
 *
 * Stop hook that estimates session token usage and warns if a budget
 * threshold is exceeded.
 *
 * Configuration:
 * - Environment variable: COST_WATCH_BUDGET (max $ per session, e.g. "5.00")
 * - If not set, no budget enforcement (just logs a reminder)
 *
 * Token estimation is rough:
 * - ~4 characters per token (English text average)
 * - Claude Opus pricing: ~$15/M input tokens, ~$75/M output tokens
 * - We estimate a blended rate of ~$30/M tokens for simplicity
 *
 * Since the Stop event provides limited session info, this hook
 * primarily serves as a reminder to check actual usage.
 */

import { readFileSync, existsSync, readdirSync, statSync } from "fs";
import { join } from "path";

interface HookInput {
  session_id: string;
  cwd: string;
  hook_event_name: string;
  transcript_path?: string;
}

interface HookOutput {
  continue: boolean;
}

/** Approximate cost per million tokens (blended input/output estimate) */
const BLENDED_COST_PER_MILLION_TOKENS = 30;

/** Average characters per token */
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
    console.error(
      `[hook-costwatch] Invalid COST_WATCH_BUDGET value: "${budgetStr}". Must be a positive number.`
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
  // Check common transcript locations
  const possibleDirs = [
    join(cwd, ".claude"),
    join(process.env.HOME || "", ".claude", "projects"),
  ];

  for (const dir of possibleDirs) {
    if (!existsSync(dir)) continue;
    try {
      const files = readdirSync(dir, { recursive: true }) as string[];
      for (const file of files) {
        const filePath = join(dir, file);
        if (typeof file === "string" && file.includes(sessionId)) {
          return filePath;
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

  // Try to estimate cost from transcript
  let estimate: {
    charCount: number;
    estimatedTokens: number;
    estimatedCost: number;
  } | null = null;

  if (input.transcript_path) {
    estimate = estimateTranscriptCost(input.transcript_path);
  }

  if (!estimate) {
    // Try to find transcript by session ID
    const transcriptPath = findSessionTranscript(input.cwd, input.session_id);
    if (transcriptPath) {
      estimate = estimateTranscriptCost(transcriptPath);
    }
  }

  if (estimate) {
    const costStr = estimate.estimatedCost.toFixed(2);
    const tokensStr = (estimate.estimatedTokens / 1000).toFixed(1);

    console.error(`[hook-costwatch] Session estimate: ~${tokensStr}K tokens, ~$${costStr}`);

    if (budget !== null && estimate.estimatedCost > budget) {
      console.error(
        `[hook-costwatch] WARNING: Estimated cost ($${costStr}) exceeds budget ($${budget.toFixed(2)})!`
      );
      console.error(
        `[hook-costwatch] Check your actual usage at https://console.anthropic.com/`
      );
    }
  } else {
    console.error(
      `[hook-costwatch] Could not estimate session cost (no transcript found).`
    );
  }

  if (budget !== null) {
    console.error(
      `[hook-costwatch] Budget: $${budget.toFixed(2)}/session. Remember to check actual usage.`
    );
  } else {
    console.error(
      `[hook-costwatch] No budget set. Set COST_WATCH_BUDGET env var to enable budget warnings.`
    );
  }

  respond({ continue: true });
}

if (import.meta.main) {
  run();
}
