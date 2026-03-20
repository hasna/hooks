#!/usr/bin/env bun

/**
 * Claude Code Hook: typecheck-gate
 *
 * Stop hook that runs TypeScript type checking before Claude finishes.
 * Blocks the session stop if type errors are found, forcing Claude to fix them first.
 *
 * Configure via ~/.claude/settings.json:
 * {
 *   "typecheckGateConfig": {
 *     "enabled": true,
 *     "command": "bun run typecheck"  // override auto-detection
 *   }
 * }
 */

import { readFileSync, existsSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import { execSync } from "child_process";

interface HookInput {
  session_id: string;
  cwd: string;
  hook_event_name: string;
  transcript_path?: string;
}

interface HookOutput {
  decision?: "block";
  reason?: string;
  continue?: boolean;
}

interface TypecheckGateConfig {
  enabled?: boolean;
  command?: string;
}

const CONFIG_KEY = "typecheckGateConfig";

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

function getConfig(cwd: string): TypecheckGateConfig {
  for (const settingsPath of [
    join(cwd, ".claude", "settings.json"),
    join(homedir(), ".claude", "settings.json"),
  ]) {
    try {
      if (existsSync(settingsPath)) {
        const settings = JSON.parse(readFileSync(settingsPath, "utf-8"));
        if (settings[CONFIG_KEY]) return settings[CONFIG_KEY] as TypecheckGateConfig;
      }
    } catch {}
  }
  return { enabled: true };
}

function detectTypecheckCommand(cwd: string): string | null {
  const pkgPath = join(cwd, "package.json");
  if (existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
      const scripts = pkg.scripts || {};
      if (scripts.typecheck) return "bun run typecheck";
      if (scripts["type-check"]) return "bun run type-check";
      if (scripts.tsc) return "bun run tsc";
      if (scripts["build:types"]) return "bun run build:types";
    } catch {}
  }
  if (existsSync(join(cwd, "tsconfig.json"))) {
    return "bunx tsc --noEmit";
  }
  return null;
}

function runTypecheck(cwd: string, command: string): { success: boolean; output: string } {
  try {
    execSync(command, {
      cwd,
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
      timeout: 120_000,
    });
    return { success: true, output: "" };
  } catch (error: unknown) {
    const execError = error as { stdout?: string; stderr?: string };
    const output = (execError.stdout || "") + (execError.stderr || "");
    return { success: false, output };
  }
}

export function run(): void {
  const input = readStdinJson();

  if (!input) {
    respond({ continue: true });
    return;
  }

  const config = getConfig(input.cwd);

  if (config.enabled === false) {
    respond({ continue: true });
    return;
  }

  const command = config.command || detectTypecheckCommand(input.cwd);

  if (!command) {
    console.error("[hook-typecheck-gate] No TypeScript project detected, skipping.");
    respond({ continue: true });
    return;
  }

  console.error(`[hook-typecheck-gate] Running: ${command}`);

  const { success, output } = runTypecheck(input.cwd, command);

  if (success) {
    console.error("[hook-typecheck-gate] TypeScript OK — no errors.");
    respond({ continue: true });
    return;
  }

  const lines = output.split("\n").filter((l) => l.trim());
  const errorLines = lines.filter((l) => /error TS\d+/.test(l));
  const errorCount = errorLines.length || lines.filter((l) => /error/i.test(l)).length;
  const summary = errorLines.slice(0, 5).join("\n") || lines.slice(0, 5).join("\n");
  const more = errorCount > 5 ? `\n... and ${errorCount - 5} more error(s)` : "";

  const reason = `TypeScript type check failed with ${errorCount} error(s).\n\nFix these before finishing:\n${summary}${more}`;
  console.error(`[hook-typecheck-gate] ${errorCount} TypeScript error(s) found — blocking stop.`);
  respond({ decision: "block", reason });
}

if (import.meta.main) {
  run();
}
