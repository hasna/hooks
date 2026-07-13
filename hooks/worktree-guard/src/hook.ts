#!/usr/bin/env bun

import {
  classifyDangerousOperation,
  claimCommand,
  gitCommandInfo,
  gitRemoteSlug,
  gitRepoRoot,
  getCommand,
  managedWorktreeInfo,
  readInput,
  respond,
  runIdFrom,
  taskIdFrom,
  warn,
  type CodewithHookInput,
} from "../../codewith-native-common";

const FEATURE_TOOLS = new Set(["Write", "Edit", "MultiEdit", "NotebookEdit", "apply_patch", "ApplyPatch", "functions.apply_patch"]);

function isFeatureWork(input: CodewithHookInput, command: string): boolean {
  if (typeof input.tool_name === "string" && FEATURE_TOOLS.has(input.tool_name)) return true;
  if (input.tool_name === "Bash" && (gitCommandInfo(command) || /\b(?:git\s+add|(?:npm|pnpm|yarn|bun)\s+(?:test|run|install|build)|apply_patch|python|node|bunx)\b/.test(command))) return true;
  return false;
}

export async function evaluate(input: CodewithHookInput): Promise<{ output: Record<string, unknown>; warnings: string[] }> {
  const warnings: string[] = [];
  if (input.hook_event_name !== "PreToolUse") return { output: { continue: true }, warnings };

  const dangerous = await classifyDangerousOperation(input);
  if (dangerous.block) {
    return { output: { decision: "block", reason: dangerous.reason }, warnings };
  }

  const cwd = input.cwd || process.cwd();
  const command = getCommand(input);
  const gitInfo = gitCommandInfo(command, cwd);
  const targetCwd = gitInfo?.targetCwd || cwd;
  const managed = managedWorktreeInfo(targetCwd);
  if (managed.managed) return { output: { continue: true }, warnings };

  const repoRoot = await gitRepoRoot(targetCwd);
  const repo = await gitRemoteSlug(targetCwd) || (repoRoot ? repoRoot.split("/").filter(Boolean).pop() || null : null);
  const taskId = taskIdFrom(input);
  const runId = runIdFrom(input);
  const recommended = claimCommand(repo, taskId, runId);
  const action = gitInfo?.action || null;

  if (action) {
    const reason = [
      `Blocked git ${action} outside a managed repos worktree (${managed.reason || "not under managed root"}).`,
      `Command target cwd: ${targetCwd}`,
      `Managed root: ${managed.root}`,
      `Claim a task worktree first: ${recommended}`,
    ].join(" ");
    return { output: { decision: "block", reason }, warnings };
  }

  if (isFeatureWork(input, command)) {
    warnings.push([
      `Feature work appears to be outside a managed repos worktree (${managed.reason || "not under managed root"}).`,
      `Use: ${recommended}`,
    ].join(" "));
    return {
      output: {
        continue: true,
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          additionalContext: warnings.map((w) => `[worktree-guard] ${w}`).join("\n"),
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
    warn(`worktree-guard failed open: ${error instanceof Error ? error.message : String(error)}`);
    respond({ continue: true });
  }
}

if (import.meta.main) {
  await run();
}
