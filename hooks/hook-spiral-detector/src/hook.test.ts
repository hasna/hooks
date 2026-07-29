import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const homes: string[] = [];
const hookPath = join(import.meta.dir, "hook.ts");

async function invoke(home: string, input: object): Promise<Record<string, unknown>> {
  const proc = Bun.spawn(["bun", "run", hookPath], {
    stdin: new Response(JSON.stringify(input)),
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, HOME: home },
  });
  const [stdout, exitCode] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
  expect(exitCode).toBe(0);
  return JSON.parse(stdout);
}

function input(session: string, command = "bun test", exitCode = 1): object {
  return {
    session_id: session,
    tool_name: "Bash",
    tool_input: { command },
    tool_response: { exit_code: exitCode, stderr: "tests failed\nmore details" },
  };
}

afterEach(() => {
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

describe("spiral detector", () => {
  test("interrupts on the fifth identical red signature", async () => {
    const home = mkdtempSync(join(tmpdir(), "spiral-detector-"));
    homes.push(home);
    for (let attempt = 1; attempt < 5; attempt++) {
      expect(await invoke(home, input("session-1"))).toEqual({ continue: true });
    }
    expect(await invoke(home, input("session-1"))).toMatchObject({
      continue: false,
      stopReason: expect.stringContaining("after 5 identical command failures"),
    });
  });

  test("successes and changed failures reset the streak", async () => {
    const home = mkdtempSync(join(tmpdir(), "spiral-detector-"));
    homes.push(home);
    for (let attempt = 0; attempt < 4; attempt++) await invoke(home, input("session-2"));
    expect(await invoke(home, input("session-2", "bun test", 0))).toEqual({ continue: true });
    for (let attempt = 0; attempt < 4; attempt++) await invoke(home, input("session-2"));
    expect(await invoke(home, input("session-2", "bun run typecheck"))).toEqual({ continue: true });
    for (let attempt = 1; attempt < 5; attempt++) {
      expect(await invoke(home, input("session-2"))).toEqual({ continue: true });
    }
    expect(await invoke(home, input("session-2"))).toMatchObject({ continue: false });
  });

  test("supports the repository's legacy tool_output field", async () => {
    const home = mkdtempSync(join(tmpdir(), "spiral-detector-"));
    homes.push(home);
    const legacy = {
      session_id: "session-3",
      tool_name: "Bash",
      tool_input: { command: "npm test" },
      tool_output: { exitCode: "2", stderr: "same error" },
    };
    for (let attempt = 1; attempt < 5; attempt++) await invoke(home, legacy);
    expect(await invoke(home, legacy)).toMatchObject({ continue: false });
  });
});
