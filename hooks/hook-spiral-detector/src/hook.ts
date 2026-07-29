#!/usr/bin/env bun

/** Interrupt an agent after three identical consecutive Bash failures. */

import { createHash } from "crypto";
import { homedir } from "os";
import { dirname, join } from "path";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "fs";

interface HookInput {
  session_id?: string;
  tool_input?: Record<string, unknown>;
  tool_output?: unknown;
  tool_response?: unknown;
}

export interface SpiralState {
  signature: string;
  count: number;
}

export interface RedSignature {
  key: string;
  exitCode: number;
  firstStderrLine: string;
}

export const THRESHOLD = 3;

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" ? value as Record<string, unknown> : {};
}

export function redSignature(input: HookInput): RedSignature | null {
  const command = input.tool_input?.command;
  const output = record(input.tool_output ?? input.tool_response);
  const rawCode = output.exit_code ?? output.exitCode ?? output.code;
  const exitCode = typeof rawCode === "number" ? rawCode : Number(rawCode);
  if (typeof command !== "string" || !command || !Number.isFinite(exitCode) || exitCode === 0) return null;

  const stderr = typeof output.stderr === "string" ? output.stderr : "";
  const firstStderrLine = stderr.split(/\r?\n/, 1)[0] ?? "";
  const commandHash = createHash("sha256").update(command).digest("hex");
  return {
    key: JSON.stringify([commandHash, exitCode, firstStderrLine]),
    exitCode,
    firstStderrLine,
  };
}

export function advanceState(previous: SpiralState | null, signature: RedSignature | null): SpiralState {
  if (!signature) return { signature: "", count: 0 };
  return {
    signature: signature.key,
    count: previous?.signature === signature.key ? previous.count + 1 : 1,
  };
}

function statePath(sessionId: string): string {
  const stateDir = process.env.HOOKS_SPIRAL_STATE_DIR || join(homedir(), ".hasna", "hooks", "state");
  const sessionHash = createHash("sha256").update(sessionId).digest("hex");
  return join(stateDir, `spiral-detector-${sessionHash}.json`);
}

function readState(path: string): SpiralState | null {
  try {
    const value = JSON.parse(readFileSync(path, "utf-8")) as SpiralState;
    return typeof value.signature === "string" && Number.isInteger(value.count) ? value : null;
  } catch {
    return null;
  }
}

function writeState(path: string, state: SpiralState): void {
  try {
    mkdirSync(dirname(path), { recursive: true });
    const temporary = `${path}.${process.pid}.tmp`;
    writeFileSync(temporary, JSON.stringify(state), { mode: 0o600 });
    renameSync(temporary, path);
  } catch {
    // State failures must not break normal tool execution.
  }
}

function respond(output: { continue: boolean; stopReason?: string }): void {
  console.log(JSON.stringify(output));
}

export function run(): void {
  let input: HookInput;
  try {
    input = JSON.parse(readFileSync(0, "utf-8"));
  } catch {
    respond({ continue: true });
    return;
  }

  if (!input.session_id) {
    respond({ continue: true });
    return;
  }

  const path = statePath(input.session_id);
  const signature = redSignature(input);
  const state = advanceState(readState(path), signature);
  writeState(path, state);

  if (signature && state.count >= THRESHOLD) {
    const detail = signature.firstStderrLine || "(empty stderr)";
    respond({
      continue: false,
      stopReason: `[hook-spiral-detector] Interrupted after ${state.count} identical command failures (exit ${signature.exitCode}): ${detail}`,
    });
    return;
  }

  respond({ continue: true });
}

if (import.meta.main) run();
