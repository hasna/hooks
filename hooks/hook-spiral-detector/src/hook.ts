#!/usr/bin/env bun

/** Interrupt a session after five consecutive identical Bash failures. */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

interface HookInput {
  session_id?: string;
  tool_name?: string;
  tool_input?: Record<string, unknown>;
  tool_response?: unknown;
  tool_output?: unknown;
}

interface State {
  signature: string;
  count: number;
}

const THRESHOLD = 5;
const STATE_DIR = join(homedir(), ".hasna", "hooks", "state", "spiral-detector");

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function statePath(sessionId: string): string {
  return join(STATE_DIR, `${hash(sessionId)}.json`);
}

function readState(path: string): State {
  try {
    const state = JSON.parse(readFileSync(path, "utf8")) as State;
    if (typeof state.signature === "string" && Number.isInteger(state.count) && state.count > 0) return state;
  } catch {}
  return { signature: "", count: 0 };
}

function clearState(path: string): void {
  try {
    if (existsSync(path)) unlinkSync(path);
  } catch {}
}

function redSignature(input: HookInput): string | null {
  if (input.tool_name !== "Bash" || typeof input.tool_input?.command !== "string") return null;
  const output = input.tool_response ?? input.tool_output;
  if (!output || typeof output !== "object") return null;
  const record = output as Record<string, unknown>;
  const rawCode = record.exit_code ?? record.exitCode ?? record.code;
  const exitCode = typeof rawCode === "string" ? Number(rawCode) : rawCode;
  if (typeof exitCode !== "number" || !Number.isFinite(exitCode) || exitCode === 0) return null;
  const stderr = typeof record.stderr === "string" ? record.stderr : "";
  const firstLine = stderr.split(/\r?\n/, 1)[0] ?? "";
  return hash(`${hash(input.tool_input.command)}\0${exitCode}\0${firstLine}`);
}

export function processInput(input: HookInput): { continue: boolean; stopReason?: string } {
  if (!input.session_id) return { continue: true };
  const path = statePath(input.session_id);
  const signature = redSignature(input);
  if (!signature) {
    clearState(path);
    return { continue: true };
  }

  const previous = readState(path);
  const count = previous.signature === signature ? previous.count + 1 : 1;
  try {
    mkdirSync(STATE_DIR, { recursive: true });
    writeFileSync(path, JSON.stringify({ signature, count }));
  } catch {
    return { continue: true };
  }

  return count >= THRESHOLD
    ? { continue: false, stopReason: `Spiral detector interrupted the session after ${count} identical command failures. Change the command or underlying state before resuming.` }
    : { continue: true };
}

export function run(): void {
  try {
    const input = JSON.parse(readFileSync(0, "utf8")) as HookInput;
    console.log(JSON.stringify(processInput(input)));
  } catch {
    console.log(JSON.stringify({ continue: true }));
  }
}

if (import.meta.main) run();
