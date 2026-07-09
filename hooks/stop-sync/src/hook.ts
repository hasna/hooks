#!/usr/bin/env bun

import {
  commandExists,
  getAgentName,
  readInput,
  respond,
  runCommand,
  taskIdFrom,
  warn,
  type CodewithHookInput,
} from "../../codewith-native-common";

async function heartbeat(input: CodewithHookInput, cwd: string): Promise<string[]> {
  const notes: string[] = [];
  const agentName = getAgentName(input);
  if (!agentName) {
    notes.push("No safe agent name found; skipped heartbeat.");
    return notes;
  }
  if (commandExists("conversations")) {
    await runCommand(["conversations", "agents", "heartbeat", "--from", agentName, "--status", "online"], { cwd, timeoutMs: 2000 });
    notes.push("conversations heartbeat attempted.");
  } else {
    notes.push("conversations CLI unavailable; skipped heartbeat.");
  }
  if (commandExists("todos")) {
    await runCommand(["todos", "heartbeat", agentName], { cwd, timeoutMs: 2000 });
    notes.push("todos heartbeat attempted.");
  } else {
    notes.push("todos CLI unavailable; skipped heartbeat.");
  }
  if (commandExists("mementos")) {
    await runCommand(["mementos", "heartbeat", agentName], { cwd, timeoutMs: 2000 });
    notes.push("mementos heartbeat attempted.");
  } else {
    notes.push("mementos CLI unavailable; skipped heartbeat.");
  }
  return notes;
}

async function maybeTaskComment(input: CodewithHookInput, cwd: string): Promise<string | null> {
  if (process.env.HASNA_HOOKS_STOP_SYNC_TASK_COMMENT !== "1") return null;
  const taskId = taskIdFrom(input);
  if (!taskId) return "Task comment skipped: no task id env/input.";
  if (!commandExists("todos")) return "Task comment skipped: todos CLI unavailable.";
  const text = `Codewith Stop hook ran at turn end for session ${(input.session_id || "unknown").slice(0, 12)}; Stop is turn-end, not process exit.`;
  await runCommand(["todos", "comment", taskId, text], { cwd, timeoutMs: 3000 });
  return "Task evidence comment attempted.";
}

export async function run(): Promise<void> {
  const input = readInput();
  const cwd = input.cwd || process.cwd();
  try {
    const notes = await heartbeat(input, cwd);
    const comment = await maybeTaskComment(input, cwd);
    if (comment) notes.push(comment);
    warn(`stop-sync turn-end (not process exit): ${notes.join("; ")}`);
    respond({ continue: true, suppressOutput: true });
  } catch (error) {
    warn(`stop-sync failed open: ${error instanceof Error ? error.message : String(error)}`);
    respond({ continue: true, suppressOutput: true });
  }
}

if (import.meta.main) {
  await run();
}
