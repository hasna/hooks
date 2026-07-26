#!/usr/bin/env bun

import {
  canonicalRepoIdentity,
  canonicalWorktreeTemplate,
  classifyDangerousOperation,
  claimCommand,
  gitCommandInfo,
  gitRemoteSlug,
  gitRepoRoot,
  getCommand,
  managedWorktreeInfo,
  readInput,
  respond,
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

  // Migration shim, temporary and deliberately narrow: worktrees created under the
  // pre-rule-8 station-id lease layout are non-compliant, but they are real, active
  // worktrees. Hard-blocking their git work on day one would strand in-flight tasks
  // with no way to land, so this one recognised layout warns instead of blocking.
  // Everything else non-canonical is still blocked. Remove once they are re-homed.
  if (managed.layout === "legacy-station-lease") {
    const message = `${managed.reason}. This layout will stop being tolerated; re-home this worktree.`;
    warnings.push(message);
    return {
      output: {
        continue: true,
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          additionalContext: `[worktree-guard] ${message}`,
        },
      },
      warnings,
    };
  }

  const repoRoot = await gitRepoRoot(targetCwd);
  // Rule 8 resolution order: the repos CLI is the source of truth for <repo-name>.
  // The local checkout directory is the next best guess, and the remote slug is the
  // last resort — for most repos the remote basename is NOT the canonical repo name.
  const identity = await canonicalRepoIdentity(targetCwd);
  const repo = identity.name
    || (repoRoot ? repoRoot.split("/").filter(Boolean).pop() || null : null)
    || (await gitRemoteSlug(targetCwd))?.split("/").filter(Boolean).pop()
    || null;
  const taskId = taskIdFrom(input);
  const recommended = claimCommand(repo, taskId, identity.defaultBranch);
  const action = gitInfo?.action || null;
  const canonical = canonicalWorktreeTemplate(managed.root);
  // Rule 8 requires an exact repos-CLI lookup for <repo-name>. When that lookup did
  // not resolve, the name below is a local guess, so say so rather than imply it is
  // authoritative — the repo directory name and the remote basename often differ.
  const unverifiedRepoName = identity.name
    ? null
    : `Confirm <repo-name> with an exact repos CLI lookup first: repos repo ${repo || "<name>"} --json`;

  if (action) {
    const reason = [
      `Blocked git ${action} outside a canonical task worktree (${managed.reason || "not under managed root"}).`,
      `Command target cwd: ${targetCwd}`,
      `Canonical worktree path (Agent Operating Rules rule 8): ${canonical}`,
      `Create one first: ${recommended}`,
      ...(unverifiedRepoName ? [unverifiedRepoName] : []),
    ].join(" ");
    return { output: { decision: "block", reason }, warnings };
  }

  if (isFeatureWork(input, command)) {
    warnings.push([
      `Feature work appears to be outside a canonical task worktree (${managed.reason || "not under managed root"}).`,
      `Canonical worktree path (Agent Operating Rules rule 8): ${canonical}.`,
      `Use: ${recommended}`,
      ...(unverifiedRepoName ? [unverifiedRepoName] : []),
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
  // The verdict is written, so the hook is done. Exit rather than waiting for the
  // event loop to drain: an optional CLI consulted during evaluation may have left a
  // grandchild holding a pipe open, and a hook that has already answered must never
  // keep the caller's PreToolUse path waiting on it.
  process.exit(0);
}
