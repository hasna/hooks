#!/usr/bin/env bun

import {
  commandExists,
  classifyDangerousOperation,
  gitCommandInfo,
  getCommand,
  isBashPreToolUse,
  isRiskyOperation,
  readCache,
  readInput,
  redactGitleaksOutput,
  respond,
  runCommand,
  warn,
  type CodewithHookInput,
} from "../../codewith-native-common";

interface SessionDigest {
  context: string;
  warnings: string[];
}

async function runStagedSecretsScan(cwd: string): Promise<{ block: boolean; reason?: string; warning?: string }> {
  if (!commandExists("gitleaks")) {
    return { block: false, warning: "gitleaks unavailable; staged secrets scan skipped fail-open." };
  }

  const result = await runCommand([
    "gitleaks", "git", "--staged", "--no-banner", "--redact", "--report-format", "json", "--report-path", "-", ".",
  ], { cwd, timeoutMs: 15_000 });

  if (result.exitCode === 0) return { block: false };
  if (result.exitCode === 1) {
    return { block: true, reason: redactGitleaksOutput(result.stdout, result.stderr) };
  }
  return { block: false, warning: `gitleaks scan did not complete cleanly (exit ${result.exitCode ?? "unknown"}${result.timedOut ? ", timed out" : ""}); fail-open.` };
}

function riskyCommsBlock(): string | null {
  const cached = readCache<SessionDigest>("session-start-digest", 5 * 60_000);
  if (!cached) return null;
  const context = cached.context || "";
  if (/\[FREEZE\]/i.test(context)) return "Cached announcements contain a [FREEZE]. Re-check conversations before running risky operations.";
  if (/Unread blockers JSON:\n\s*\[(?!\s*\])/i.test(context)) return "Cached conversations blockers are non-empty. Resolve or verify blockers before risky operations.";
  if (/"message_ids"\s*:\s*\[(?!\s*\])/i.test(context) && /blockers/i.test(context)) return "Cached blocker digest appears non-empty. Re-check conversations before risky operations.";
  return null;
}

export async function evaluate(input: CodewithHookInput): Promise<{ output: Record<string, unknown>; warnings: string[] }> {
  const warnings: string[] = [];
  if (!isBashPreToolUse(input)) return { output: { continue: true }, warnings };
  const command = getCommand(input);
  if (!command) return { output: { continue: true }, warnings };
  const cwd = input.cwd || process.cwd();

  const dangerous = await classifyDangerousOperation(input);
  if (dangerous.block) {
    return { output: { decision: "block", reason: dangerous.reason }, warnings };
  }

  const gitInfo = gitCommandInfo(command, cwd);

  if (gitInfo) {
    const scan = await runStagedSecretsScan(gitInfo.targetCwd);
    if (scan.warning) warnings.push(scan.warning);
    if (scan.block) {
      return { output: { decision: "block", reason: scan.reason }, warnings };
    }
  }

  if (isRiskyOperation(command)) {
    const reason = riskyCommsBlock();
    if (reason) return { output: { decision: "block", reason }, warnings };
    if (!readCache<SessionDigest>("session-start-digest", 5 * 60_000)) {
      warnings.push("No fresh session-start comms cache; risky operation allowed fail-open, but manually re-check blockers/announcements first.");
    }
  }

  if (warnings.length > 0) {
    return {
      output: {
        continue: true,
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          additionalContext: warnings.map((w) => `[pre-bash] ${w}`).join("\n"),
        },
      },
      warnings,
    };
  }

  return { output: { continue: true }, warnings };
}

export async function run(): Promise<void> {
  const input = readInput();
  try {
    const { output, warnings } = await evaluate(input);
    for (const message of warnings) warn(message);
    respond(output);
  } catch (error) {
    warn(`pre-bash failed open: ${error instanceof Error ? error.message : String(error)}`);
    respond({ continue: true });
  }
}

if (import.meta.main) {
  await run();
}
