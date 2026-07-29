import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { advanceState, redSignature, THRESHOLD, type SpiralState } from "./hook";

function failure(command = "bun test", code = 1, stderr = "Assertion failed\nmore detail") {
  return redSignature({
    tool_input: { command },
    tool_output: { exit_code: code, stderr },
  });
}

describe("hook-spiral-detector", () => {
  test("uses command, exit status, and only the first stderr line", () => {
    expect(failure()?.key).toBe(failure("bun test", 1, "Assertion failed\nchanged detail")?.key);
    expect(failure()?.key).not.toBe(failure("bun test --watch")?.key);
    expect(failure()?.key).not.toBe(failure("bun test", 2)?.key);
    expect(failure()?.key).not.toBe(failure("bun test", 1, "Different failure")?.key);
  });

  test("accepts tool_response and camel-case exit codes", () => {
    expect(redSignature({
      tool_input: { command: "npm test" },
      tool_response: { exitCode: 1, stderr: "red" },
    })).not.toBeNull();
  });

  test("successful or unclassified calls are not red", () => {
    expect(redSignature({ tool_input: { command: "bun test" }, tool_output: { exit_code: 0 } })).toBeNull();
    expect(redSignature({ tool_input: { command: "bun test" }, tool_output: { stderr: "red" } })).toBeNull();
  });

  test("interrupt threshold requires three consecutive identical signatures", () => {
    const red = failure()!;
    let state: SpiralState | null = null;
    for (let count = 1; count <= THRESHOLD; count++) {
      state = advanceState(state, red);
      expect(state.count).toBe(count);
    }
    expect(state!.count).toBe(3);

    state = advanceState(state, failure("bun test", 1, "A new first error"));
    expect(state.count).toBe(1);
    expect(advanceState(state, null).count).toBe(0);
  });

  test("persists per-session failures and emits a hard stop on the third", async () => {
    const stateDir = mkdtempSync(join(tmpdir(), "spiral-detector-"));
    const input = {
      session_id: "session-1",
      tool_input: { command: "bun test" },
      tool_output: { exit_code: 1, stderr: "Assertion failed\ndetail" },
    };

    async function invoke(): Promise<{ continue: boolean; stopReason?: string }> {
      const process = Bun.spawn(["bun", "run", join(import.meta.dir, "hook.ts")], {
        stdin: new Response(JSON.stringify(input)),
        stdout: "pipe",
        stderr: "pipe",
        env: { ...globalThis.process.env, HOOKS_SPIRAL_STATE_DIR: stateDir },
      });
      const [stdout, exitCode] = await Promise.all([
        new Response(process.stdout).text(),
        process.exited,
      ]);
      expect(exitCode).toBe(0);
      return JSON.parse(stdout);
    }

    try {
      expect(await invoke()).toEqual({ continue: true });
      expect(await invoke()).toEqual({ continue: true });
      const interrupted = await invoke();
      expect(interrupted.continue).toBe(false);
      expect(interrupted.stopReason).toContain("Interrupted after 3 identical command failures");
    } finally {
      rmSync(stateDir, { recursive: true, force: true });
    }
  });
});
