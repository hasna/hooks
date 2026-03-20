#!/usr/bin/env bun

/**
 * Claude Code Hook: failure-to-task
 *
 * PostToolUse hook that creates a todo task when a test or build command fails.
 * Uses the `todos` CLI if available, otherwise writes to ~/.hooks/tasks/.
 */

import { readFileSync, mkdirSync, writeFileSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import { execSync } from "child_process";

interface HookInput {
  session_id: string;
  cwd: string;
  tool_name: string;
  tool_input: Record<string, unknown>;
  tool_output?: Record<string, unknown> | string;
}

interface HookOutput {
  continue: boolean;
}

const TEST_BUILD_PATTERNS: RegExp[] = [
  /\bbun\s+test\b/,
  /\bnpm\s+(run\s+)?test\b/,
  /\byarn\s+test\b/,
  /\bpnpm\s+(run\s+)?test\b/,
  /\bpytest\b/,
  /\bvitest\b/,
  /\bjest\b/,
  /\bbun\s+(run\s+)?build\b/,
  /\bnpm\s+(run\s+)?build\b/,
  /\byarn\s+build\b/,
  /\bpnpm\s+(run\s+)?build\b/,
  /\bbunx?\s+tsc\b/,
  /\bnpm\s+(run\s+)?typecheck\b/,
  /\bbun\s+(run\s+)?typecheck\b/,
];

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

function isTestOrBuild(command: string): boolean {
  return TEST_BUILD_PATTERNS.some((p) => p.test(command));
}

function getExitCode(output: unknown): number | null {
  if (typeof output !== "object" || output === null) return null;
  const o = output as Record<string, unknown>;
  const code = o.exit_code ?? o.exitCode;
  if (typeof code === "number") return code;
  if (typeof code === "string") return parseInt(code, 10);
  return null;
}

function getErrorSnippet(output: unknown): string {
  if (typeof output === "string") return output.slice(0, 600);
  if (typeof output === "object" && output !== null) {
    const o = output as Record<string, unknown>;
    return `${o.stdout || o.output || ""}\n${o.stderr || o.error || ""}`.trim().slice(0, 600);
  }
  return "";
}

function createTask(cwd: string, command: string, exitCode: number, snippet: string): void {
  const projectName = cwd.split("/").filter(Boolean).pop() || "project";
  const shortCmd = command.split(/\s+/).slice(0, 4).join(" ");
  const title = `Fix failing \`${shortCmd}\` in ${projectName}`;
  const description = [
    `A ${shortCmd.includes("test") ? "test" : "build"} command failed during a coding session.`,
    "",
    `**Command:** \`${command}\``,
    `**Exit code:** ${exitCode}`,
    `**Project:** \`${cwd}\``,
    "",
    "**Error output:**",
    "```",
    snippet || "(no output captured)",
    "```",
    "",
    "**Acceptance criteria:**",
    `- \`${command}\` passes without errors`,
  ].join("\n");

  // Try todos CLI first
  try {
    const escapedTitle = title.replace(/"/g, "'");
    const escapedDesc = description.replace(/"/g, "'").replace(/\n/g, "\\n");
    execSync(
      `todos add "${escapedTitle}" --description "${escapedDesc}" --priority high --tags "failure,${shortCmd.includes("test") ? "tests" : "build"}"`,
      { cwd, timeout: 15_000, stdio: "pipe" }
    );
    console.error(`[hook-failure-to-task] Task created via todos CLI: "${title}"`);
    return;
  } catch {
    // Fall back to local file
  }

  // Local fallback: write to ~/.hooks/tasks/
  try {
    const taskDir = join(homedir(), ".hooks", "tasks");
    mkdirSync(taskDir, { recursive: true });
    const taskId = `failure-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    const task = {
      id: taskId,
      title,
      description,
      status: "pending",
      priority: "high",
      tags: ["failure", shortCmd.includes("test") ? "tests" : "build"],
      created_at: new Date().toISOString(),
      source: "hook-failure-to-task",
      project_dir: cwd,
    };
    writeFileSync(join(taskDir, `${taskId}.json`), JSON.stringify(task, null, 2));
    console.error(`[hook-failure-to-task] Task saved locally: ${taskId}`);
  } catch (err) {
    console.error(`[hook-failure-to-task] Could not create task: ${err}`);
  }
}

export function run(): void {
  const input = readStdinJson();

  if (!input) {
    respond({ continue: true });
    return;
  }

  if (input.tool_name !== "Bash") {
    respond({ continue: true });
    return;
  }

  const command = input.tool_input?.command as string | undefined;
  if (!command || !isTestOrBuild(command)) {
    respond({ continue: true });
    return;
  }

  const exitCode = getExitCode(input.tool_output);
  if (exitCode === null || exitCode === 0) {
    respond({ continue: true });
    return;
  }

  const snippet = getErrorSnippet(input.tool_output);
  console.error(`[hook-failure-to-task] Command failed (exit ${exitCode}): ${command}`);
  createTask(input.cwd, command, exitCode, snippet);

  respond({ continue: true });
}

if (import.meta.main) {
  run();
}
