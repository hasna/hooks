import { describe, expect, test } from "bun:test";
import { join } from "path";
import { mkdtempSync, readFileSync, readlinkSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { getAgentName, gitCommandInfo, managedWorktreeInfo, runCommand } from "./codewith-native-common";
import { runBoundedProcess } from "./bounded-process.js";

describe("codewith native common helpers", () => {
  test("gitCommandInfo detects global option commit/push forms and target cwd", () => {
    const base = mkdtempSync(join(tmpdir(), "hooks-common-"));
    try {
      expect(gitCommandInfo("git -c user.name=test commit -m test", base)?.action).toBe("commit");
      expect(gitCommandInfo("git -C ./repo push origin feature", base)).toMatchObject({
        action: "push",
        targetCwd: join(base, "repo"),
      });
      expect(gitCommandInfo("git --git-dir .git --work-tree . commit", base)).toMatchObject({
        action: "commit",
        targetCwd: base,
      });
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  test("managedWorktreeInfo rejects malformed fake managed-root paths", () => {
    const tmp = mkdtempSync(join(tmpdir(), "hooks-worktrees-"));
    const previous = process.env.HASNA_REPOS_WORKTREES_ROOT;
    process.env.HASNA_REPOS_WORKTREES_ROOT = join(tmp, "worktrees");
    try {
      const valid = join(tmp, "worktrees", "station01", "open-hooks-a55c105a", "wt_2ab04216a30ef5ece642792e", "repo");
      expect(managedWorktreeInfo(valid).managed).toBe(true);
      expect(managedWorktreeInfo(join(tmp, "worktrees", "station01", "open-hooks-a55c105a", "wt_fake", "repo")).managed).toBe(false);
      expect(managedWorktreeInfo(join(tmp, "worktrees", "station01", "open-hooks-nohash", "wt_2ab04216a30ef5ece642792e", "repo")).managed).toBe(false);
      expect(managedWorktreeInfo(join(tmp, "worktrees", "station01", "open-hooks-zzzzzzzz", "wt_2ab04216a30ef5ece642792e", "repo")).managed).toBe(false);
    } finally {
      if (previous === undefined) delete process.env.HASNA_REPOS_WORKTREES_ROOT;
      else process.env.HASNA_REPOS_WORKTREES_ROOT = previous;
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("getAgentName reads Codewith input.agent profile injection", () => {
    const saved = {
      HOOKS_AGENT_NAME: process.env.HOOKS_AGENT_NAME,
      CODEWITH_AGENT_NAME: process.env.CODEWITH_AGENT_NAME,
      CONVERSATIONS_AGENT_ID: process.env.CONVERSATIONS_AGENT_ID,
    };
    delete process.env.HOOKS_AGENT_NAME;
    delete process.env.CODEWITH_AGENT_NAME;
    delete process.env.CONVERSATIONS_AGENT_ID;
    try {
      expect(getAgentName({ agent: { name: "profile-agent" } })).toBe("profile-agent");
      expect(getAgentName({ agent: { agent_id: "profile_id" } })).toBe("profile_id");
    } finally {
      for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });

  test("runCommand clears shell startup injection and caps stdout", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "hooks-command-env-"));
    try {
      const startup = join(tmp, "startup.sh");
      writeFileSync(startup, "printf startup-injected");
      const env = {
        ...process.env,
        BASH_ENV: startup,
        ENV: startup,
        SYNTHETIC_SECRET_SENTINEL: "must-not-leak",
      };

      const startupResult = await runCommand(
        ["/bin/bash", "-c", 'printf "%s" "${SYNTHETIC_SECRET_SENTINEL-unset}:body"'],
        { env, timeoutMs: 2_000 },
      );
      expect(startupResult.stdout).toBe("unset:body");

      const oversized = await runCommand(
        [process.execPath, "-e", 'process.stdout.write("x".repeat(70_000))'],
        { env, timeoutMs: 2_000 },
      );
      expect(Buffer.byteLength(oversized.stdout)).toBeLessThanOrEqual(64 * 1024);
      expect((oversized as any).error).toContain("stdout exceeds");
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("runCommand timeout kills a spawned descendant", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "hooks-command-tree-"));
    const sentinel = join(tmp, "descendant-survived");
    try {
      const result = await runCommand(
        ["/bin/sh", "-c", `(sleep 0.6; printf survived > ${JSON.stringify(sentinel)}) & wait`],
        { timeoutMs: 150, network: "allow" },
      );
      expect(result.timedOut).toBe(true);
      await Bun.sleep(700);
      expect(() => readFileSync(sentinel)).toThrow();
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("runCommand denies a loopback network stub unless explicitly allowed", async () => {
    const server = Bun.serve({
      port: 0,
      fetch: () => new Response("reachable"),
    });
    const script = `fetch("http://127.0.0.1:${server.port}").then(async r => { console.log(await r.text()) }).catch(() => process.exit(23))`;
    try {
      const parentNamespace = readlinkSync("/proc/self/ns/net");
      const isolated = await runCommand(
        ["/usr/bin/readlink", "/proc/self/ns/net"],
        { timeoutMs: 2_000, network: "deny" },
      );
      expect(isolated.exitCode).toBe(0);
      expect(isolated.error).toBeNull();
      expect(isolated.stdout.trim()).not.toBe(parentNamespace);

      const denied = await runCommand(
        [process.execPath, "-e", script],
        { timeoutMs: 2_000, network: "deny" } as any,
      );
      expect(denied.exitCode).not.toBe(0);
      expect(denied.error).toBeNull();
      expect(denied.stdout).not.toContain("reachable");

      const allowed = await runCommand(
        [process.execPath, "-e", script],
        { timeoutMs: 2_000, network: "allow" } as any,
      );
      expect(allowed.exitCode).toBe(0);
      expect(allowed.stdout.trim()).toBe("reachable");
    } finally {
      server.stop(true);
    }
  });

  test("runCommand fails closed when network containment is unavailable", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "hooks-command-no-sandbox-"));
    const sentinel = join(tmp, "executed");
    try {
      const result = await runBoundedProcess(
        [process.execPath, "-e", `await Bun.write(${JSON.stringify(sentinel)}, "executed")`],
        { containmentExecutable: join(tmp, "missing-bwrap"), network: "deny" },
      );
      expect(result.exitCode).toBeNull();
      expect(result.error).toContain("requires bubblewrap");
      expect(() => readFileSync(sentinel)).toThrow();
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("runBoundedProcess rejects sensitive explicit environment names", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "hooks-command-sensitive-env-"));
    const sentinel = join(tmp, "executed");
    try {
      const result = await runBoundedProcess(
        [process.execPath, "-e", `await Bun.write(${JSON.stringify(sentinel)}, "executed")`],
        {
          env: { OPENAI_API_KEY: "synthetic-not-a-credential" },
          envAllowlist: ["OPENAI_API_KEY"],
          network: "allow",
        },
      );
      expect(result.exitCode).toBeNull();
      expect(result.error).toContain("not permitted");
      expect(() => readFileSync(sentinel)).toThrow();
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("runBoundedProcess timeout includes queue wait", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "hooks-command-queue-"));
    const sentinel = join(tmp, "queued-command-executed");
    try {
      const occupied = Array.from({ length: 4 }, () => runBoundedProcess(
        ["/bin/sh", "-c", "sleep 0.35"],
        { timeoutMs: 2_000, network: "allow" },
      ));
      const queued = await runBoundedProcess(
        [process.execPath, "-e", `await Bun.write(${JSON.stringify(sentinel)}, "executed")`],
        { timeoutMs: 50, network: "allow" },
      );

      expect(queued.timedOut).toBe(true);
      expect(queued.error).toContain("waiting for a process slot");
      expect(() => readFileSync(sentinel)).toThrow();
      const completed = await Promise.all(occupied);
      expect(completed.every((result) => result.exitCode === 0 && result.error === null)).toBe(true);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("runBoundedProcess tolerates EPIPE from an immediate-exit child", async () => {
    const result = await runBoundedProcess(
      ["/bin/true"],
      { input: "x".repeat(64 * 1024), timeoutMs: 2_000, network: "allow" },
    );
    expect(result.exitCode).toBe(0);
    expect(result.error).toBeNull();
    expect(result.timedOut).toBe(false);
  });
});
