import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { Client } from "@modelcontextprotocol/sdk/client";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { getHook, type HookMeta } from "../lib/registry.js";
import { createHooksServer } from "./server.js";

type ExecutionOverrides = {
  getHook: (name: string) => HookMeta | undefined;
  getHookPath: (name: string) => string;
  getRegisteredHooks: () => string[];
  env?: NodeJS.ProcessEnv;
  containmentExecutable?: string;
  maxInputBytes?: number;
  maxStdoutBytes?: number;
  maxStderrBytes?: number;
};

const roots: string[] = [];

function meta(name: string, overrides: Partial<HookMeta> = {}): HookMeta {
  return {
    name,
    displayName: name,
    description: `test hook ${name}`,
    version: "0.0.0",
    category: "Security",
    event: "PreToolUse",
    matcher: "Bash",
    tags: ["test"],
    ...overrides,
  };
}

function fixtureHook(root: string, name: string, source: string): string {
  const directory = join(root, name);
  mkdirSync(join(directory, "src"), { recursive: true });
  const script = join(directory, "src", "hook.ts");
  writeFileSync(script, source);
  chmodSync(script, 0o755);
  return directory;
}

async function withServer(
  hooks: HookMeta[],
  paths: Map<string, string>,
  overrides: Partial<ExecutionOverrides> = {},
) {
  const hookMap = new Map(hooks.map((hook) => [hook.name, hook]));
  const execution: ExecutionOverrides = {
    getHook: (name) => hookMap.get(name),
    getHookPath: (name) => paths.get(name) ?? join("/missing", name),
    getRegisteredHooks: () => hooks.map((hook) => hook.name),
    ...overrides,
  };
  const server = createHooksServer({ execution } as any);
  const client = new Client({ name: "bounded-mcp-test", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
  return { client, server };
}

function parse(result: any): any {
  const text = result.content?.find((entry: any) => entry.type === "text")?.text ?? "";
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text, isError: result.isError === true };
  }
}

afterEach(() => {
  while (roots.length > 0) {
    rmSync(roots.pop()!, { recursive: true, force: true });
  }
});

describe("bounded MCP hook execution", () => {
  test("hooks_run enforces input and output caps before returning", async () => {
    const root = mkdtempSync(join(tmpdir(), "hooks-mcp-caps-"));
    roots.push(root);
    const sentinel = join(root, "executed");
    const paths = new Map([
      ["caps", fixtureHook(root, "caps", `
        const input = await Bun.stdin.text();
        await Bun.write(${JSON.stringify(sentinel)}, input);
        process.stdout.write(JSON.stringify({ payload: "x".repeat(256) }));
        process.stderr.write("e".repeat(256));
      `)],
    ]);
    const { client } = await withServer([meta("caps", { network: "allow" })], paths, {
      maxInputBytes: 64,
      maxStdoutBytes: 80,
      maxStderrBytes: 32,
    });
    try {
      const oversizedInput = parse(await client.callTool({
        name: "hooks_run",
        arguments: { name: "caps", input: { payload: "i".repeat(128) } },
      }));
      expect(oversizedInput.error).toContain("input exceeds 64 bytes");
      expect(existsSync(sentinel)).toBe(false);

      const oversizedOutput = parse(await client.callTool({
        name: "hooks_run",
        arguments: { name: "caps", input: {} },
      }));
      expect(oversizedOutput.error).toMatch(/stdout exceeds 80 bytes|stderr exceeds 32 bytes/);
      expect(Buffer.byteLength(oversizedOutput.stderr ?? "")).toBeLessThanOrEqual(32);
    } finally {
      await client.close();
    }
  });

  test("hooks_run timeout kills the hook descendant process tree", async () => {
    const root = mkdtempSync(join(tmpdir(), "hooks-mcp-tree-"));
    roots.push(root);
    const sentinel = join(root, "descendant-survived");
    const paths = new Map([
      ["tree", fixtureHook(root, "tree", `
        const { spawn } = await import("node:child_process");
        spawn("/bin/sh", ["-c", ${JSON.stringify(`sleep 0.5; printf survived > ${sentinel}`)}]);
        await new Promise(() => {});
      `)],
    ]);
    const { client } = await withServer([meta("tree", { network: "allow" })], paths);
    try {
      const data = parse(await client.callTool({
        name: "hooks_run",
        arguments: { name: "tree", input: {}, timeout_ms: 100 },
      }));
      expect(data.timedOut).toBe(true);
      expect(data.error).toContain("timed out");
      await Bun.sleep(650);
      expect(existsSync(sentinel)).toBe(false);
    } finally {
      await client.close();
    }
  });

  test("hooks_run applies declared deny and allow network policies", async () => {
    const root = mkdtempSync(join(tmpdir(), "hooks-mcp-network-"));
    roots.push(root);
    const server = Bun.serve({ port: 0, fetch: () => new Response("reachable") });
    const source = `
      const input = JSON.parse(await Bun.stdin.text());
      try {
        const response = await fetch(input.url);
        process.stdout.write(JSON.stringify({ value: await response.text() }));
      } catch { process.exit(23); }
    `;
    const paths = new Map([
      ["local", fixtureHook(root, "local", source)],
      ["remote", fixtureHook(root, "remote", source)],
    ]);
    const { client } = await withServer([
      meta("local"),
      meta("remote", { network: "allow" }),
    ], paths);
    try {
      const url = `http://127.0.0.1:${server.port}`;
      const denied = parse(await client.callTool({
        name: "hooks_run",
        arguments: { name: "local", input: { url } },
      }));
      expect(denied.exitCode).not.toBe(0);
      expect(denied.output).not.toEqual({ value: "reachable" });

      const allowed = parse(await client.callTool({
        name: "hooks_run",
        arguments: { name: "remote", input: { url } },
      }));
      expect(allowed.exitCode).toBe(0);
      expect(allowed.output).toEqual({ value: "reachable" });
    } finally {
      server.stop(true);
      await client.close();
    }
  });

  test("hooks_run fails closed before execution when containment is missing", async () => {
    const root = mkdtempSync(join(tmpdir(), "hooks-mcp-containment-"));
    roots.push(root);
    const sentinel = join(root, "executed");
    const paths = new Map([
      ["local", fixtureHook(root, "local", `await Bun.write(${JSON.stringify(sentinel)}, "executed")`)],
    ]);
    const { client } = await withServer([meta("local")], paths, {
      containmentExecutable: join(root, "missing-bwrap"),
    });
    try {
      const data = parse(await client.callTool({
        name: "hooks_run",
        arguments: { name: "local", input: {} },
      }));
      expect(data.error).toContain("requires bubblewrap");
      expect(existsSync(sentinel)).toBe(false);
    } finally {
      await client.close();
    }
  });

  test("MCP schemas allow further network restriction but reject elevation", async () => {
    const root = mkdtempSync(join(tmpdir(), "hooks-mcp-elevation-"));
    roots.push(root);
    const paths = new Map([
      ["local", fixtureHook(root, "local", 'console.log(JSON.stringify({ decision: "approve" }))')],
    ]);
    const { client } = await withServer([meta("local")], paths);
    try {
      const elevated = await client.callTool({
        name: "hooks_run",
        arguments: { name: "local", input: {}, network: "allow" },
      });
      expect(elevated.isError).toBe(true);

      const restricted = parse(await client.callTool({
        name: "hooks_run",
        arguments: { name: "local", input: {}, network: "deny" },
      }));
      expect(restricted.output).toEqual({ decision: "approve" });
    } finally {
      await client.close();
    }
  });

  test("hooks_batch_run bounds batch size and shares the process queue deadline", async () => {
    const root = mkdtempSync(join(tmpdir(), "hooks-mcp-batch-"));
    roots.push(root);
    const paths = new Map([
      ["slow", fixtureHook(root, "slow", 'await Bun.sleep(300); console.log("{}")')],
    ]);
    const hook = meta("slow", { network: "allow" });
    const { client } = await withServer([hook], paths);
    try {
      const tooMany = await client.callTool({
        name: "hooks_batch_run",
        arguments: { hooks: Array.from({ length: 33 }, () => ({ name: "slow", input: {} })) },
      });
      expect(tooMany.isError).toBe(true);

      const data = parse(await client.callTool({
        name: "hooks_batch_run",
        arguments: {
          hooks: Array.from({ length: 5 }, () => ({ name: "slow", input: {} })),
          timeout_ms: 100,
        },
      }));
      expect(data.count).toBe(5);
      expect(data.results.some((result: any) => result.error?.includes("waiting for a process slot"))).toBe(true);
    } finally {
      await client.close();
    }
  });

  test("hooks_preview skips mutation-unsafe hooks and injects dry_run into capable hooks", async () => {
    const root = mkdtempSync(join(tmpdir(), "hooks-mcp-preview-"));
    roots.push(root);
    const sentinel = join(root, "preview-mutated");
    const source = `
      const input = JSON.parse(await Bun.stdin.text());
      if (input.dry_run !== true) await Bun.write(${JSON.stringify(sentinel)}, "mutated");
      console.log(JSON.stringify({ decision: "approve", dry_run: input.dry_run === true }));
    `;
    const paths = new Map([
      ["unsafe", fixtureHook(root, "unsafe", source)],
      ["safe", fixtureHook(root, "safe", source)],
    ]);
    const { client } = await withServer([
      meta("unsafe", { network: "allow" }),
      meta("safe", { network: "allow", dryRun: true }),
    ], paths);
    try {
      const data = parse(await client.callTool({
        name: "hooks_preview",
        arguments: { tool_name: "Bash", tool_input: { command: "echo safe" } },
      }));
      expect(data.results.find((result: any) => result.name === "unsafe")).toMatchObject({
        decision: "indeterminate",
        skipped: true,
      });
      expect(data.results.find((result: any) => result.name === "safe").raw.dry_run).toBe(true);
      expect(data.decision).toBe("indeterminate");
      expect(data.indeterminate_by).toEqual(["unsafe"]);
      expect(existsSync(sentinel)).toBe(false);
    } finally {
      await client.close();
    }
  });

  test("hooks_preview sends the PreToolUse event to real dangerous-command guards", async () => {
    const preBash = getHook("pre-bash")!;
    const worktreeGuard = getHook("worktree-guard")!;
    const paths = new Map([
      ["pre-bash", join(import.meta.dir, "..", "..", "hooks", "pre-bash")],
      ["worktree-guard", join(import.meta.dir, "..", "..", "hooks", "worktree-guard")],
    ]);
    const { client } = await withServer([preBash, worktreeGuard], paths);
    try {
      const data = parse(await client.callTool({
        name: "hooks_preview",
        arguments: { tool_name: "Bash", tool_input: { command: "rm -rf /" } },
      }));

      expect(data.results.find((result: any) => result.name === "pre-bash")).toMatchObject({
        decision: "block",
      });
      expect(data.results.find((result: any) => result.name === "worktree-guard")).toMatchObject({
        decision: "block",
      });
      expect(data.decision).toBe("block");
      expect(data.blocked_by).toBe("pre-bash");
    } finally {
      await client.close();
    }
  });

  test("hooks_preview retains missing metadata and invalid matchers as indeterminate", async () => {
    const invalid = meta("invalid", { matcher: "[" });
    const { client } = await withServer([invalid], new Map(), {
      getRegisteredHooks: () => ["ghost", "invalid"],
    });
    try {
      const data = parse(await client.callTool({
        name: "hooks_preview",
        arguments: { tool_name: "Bash", tool_input: { command: "echo safe" } },
      }));

      expect(data.decision).toBe("indeterminate");
      expect(data.result).not.toBe("no_hooks_match");
      expect(data.matching_hooks).toEqual([]);
      expect(data.results).toHaveLength(2);
      expect(data.results.find((result: any) => result.name === "ghost")).toMatchObject({
        decision: "indeterminate",
      });
      expect(data.results.find((result: any) => result.name === "ghost").error).toContain("metadata");
      expect(data.results.find((result: any) => result.name === "invalid")).toMatchObject({
        decision: "indeterminate",
      });
      expect(data.results.find((result: any) => result.name === "invalid").error).toContain("matcher");
      expect(data.indeterminate_by).toEqual(["ghost", "invalid"]);
    } finally {
      await client.close();
    }
  });

  test("hooks_preview distinguishes valid event and tool nonmatches from corrupt registration", async () => {
    const { client } = await withServer([
      meta("different-tool", { matcher: "Write" }),
      meta("different-event", { event: "PostToolUse", matcher: "Bash" }),
    ], new Map());
    try {
      const data = parse(await client.callTool({
        name: "hooks_preview",
        arguments: { tool_name: "Bash", tool_input: { command: "echo safe" } },
      }));

      expect(data).toEqual({
        tool_name: "Bash",
        matching_hooks: [],
        result: "no_hooks_match",
        decision: "approve",
      });
    } finally {
      await client.close();
    }
  });

  test("hooks_preview keeps block precedence while retaining an invalid matcher", async () => {
    const root = mkdtempSync(join(tmpdir(), "hooks-mcp-preview-invalid-block-"));
    roots.push(root);
    const paths = new Map([
      ["blocker", fixtureHook(root, "blocker", 'console.log(JSON.stringify({ decision: "block", reason: "dangerous" }))')],
    ]);
    const { client } = await withServer([
      meta("blocker", { network: "allow", dryRun: true }),
      meta("invalid", { matcher: "[" }),
    ], paths);
    try {
      const data = parse(await client.callTool({
        name: "hooks_preview",
        arguments: { tool_name: "Bash", tool_input: { command: "echo safe" } },
      }));

      expect(data.decision).toBe("block");
      expect(data.blocked_by).toBe("blocker");
      expect(data.matching_hooks).toEqual(["blocker"]);
      expect(data.results.find((result: any) => result.name === "blocker")).toMatchObject({
        decision: "block",
      });
      expect(data.results.find((result: any) => result.name === "invalid")).toMatchObject({
        decision: "indeterminate",
      });
      expect(data.indeterminate_by).toEqual(["invalid"]);
    } finally {
      await client.close();
    }
  });

  test("hooks_preview keeps approval indeterminate when a registered matcher is invalid", async () => {
    const root = mkdtempSync(join(tmpdir(), "hooks-mcp-preview-invalid-approve-"));
    roots.push(root);
    const paths = new Map([
      ["explicit", fixtureHook(root, "explicit", 'console.log(JSON.stringify({ decision: "approve" }))')],
    ]);
    const { client } = await withServer([
      meta("explicit", { network: "allow", dryRun: true }),
      meta("invalid", { matcher: "[" }),
    ], paths);
    try {
      const data = parse(await client.callTool({
        name: "hooks_preview",
        arguments: { tool_name: "Bash", tool_input: { command: "echo safe" } },
      }));

      expect(data.decision).toBe("indeterminate");
      expect(data.matching_hooks).toEqual(["explicit"]);
      expect(data.results.find((result: any) => result.name === "explicit")).toMatchObject({
        decision: "approve",
      });
      expect(data.results.find((result: any) => result.name === "invalid")).toMatchObject({
        decision: "indeterminate",
      });
      expect(data.indeterminate_by).toEqual(["invalid"]);
    } finally {
      await client.close();
    }
  });

  test("hooks_preview reports missing scripts and containment failures as indeterminate", async () => {
    const root = mkdtempSync(join(tmpdir(), "hooks-mcp-preview-failures-"));
    roots.push(root);
    const sentinel = join(root, "executed");
    const paths = new Map([
      ["contained", fixtureHook(root, "contained", `
        await Bun.write(${JSON.stringify(sentinel)}, "executed");
        console.log(JSON.stringify({ decision: "approve" }));
      `)],
    ]);
    const { client } = await withServer([
      meta("missing", { dryRun: true }),
      meta("contained", { dryRun: true }),
    ], paths, {
      containmentExecutable: join(root, "missing-bwrap"),
    });
    try {
      const data = parse(await client.callTool({
        name: "hooks_preview",
        arguments: { tool_name: "Bash", tool_input: { command: "echo safe" } },
      }));

      expect(data.results.find((result: any) => result.name === "missing")).toMatchObject({
        decision: "indeterminate",
        error: "script not found",
      });
      expect(data.results.find((result: any) => result.name === "contained")).toMatchObject({
        decision: "indeterminate",
      });
      expect(data.results.find((result: any) => result.name === "contained").error).toContain("requires bubblewrap");
      expect(data.decision).toBe("indeterminate");
      expect(data.indeterminate_by).toEqual(["missing", "contained"]);
      expect(existsSync(sentinel)).toBe(false);
    } finally {
      await client.close();
    }
  });

  test("hooks_preview keeps block precedence over nonzero and timeout failures", async () => {
    const root = mkdtempSync(join(tmpdir(), "hooks-mcp-preview-precedence-"));
    roots.push(root);
    const paths = new Map([
      ["nonzero", fixtureHook(root, "nonzero", "process.exit(7)")],
      ["timeout", fixtureHook(root, "timeout", "await new Promise(() => {})")],
      ["blocker", fixtureHook(root, "blocker", 'console.log(JSON.stringify({ decision: "block", reason: "dangerous" }))')],
    ]);
    const { client } = await withServer([
      meta("nonzero", { network: "allow", dryRun: true }),
      meta("timeout", { network: "allow", dryRun: true }),
      meta("blocker", { network: "allow", dryRun: true }),
    ], paths);
    try {
      const data = parse(await client.callTool({
        name: "hooks_preview",
        arguments: {
          tool_name: "Bash",
          tool_input: { command: "echo safe" },
          timeout_ms: 100,
        },
      }));

      expect(data.results.find((result: any) => result.name === "nonzero")).toMatchObject({
        decision: "indeterminate",
        exitCode: 7,
      });
      expect(data.results.find((result: any) => result.name === "timeout")).toMatchObject({
        decision: "indeterminate",
        timedOut: true,
      });
      expect(data.results.find((result: any) => result.name === "blocker")).toMatchObject({
        decision: "block",
        reason: "dangerous",
      });
      expect(data.decision).toBe("block");
      expect(data.blocked_by).toBe("blocker");
      expect(data.indeterminate_by).toEqual(["nonzero", "timeout"]);
    } finally {
      await client.close();
    }
  });

  test("hooks_preview approves when every matching guard completes and approves", async () => {
    const root = mkdtempSync(join(tmpdir(), "hooks-mcp-preview-approve-"));
    roots.push(root);
    const paths = new Map([
      ["explicit", fixtureHook(root, "explicit", 'console.log(JSON.stringify({ decision: "approve" }))')],
      ["continuing", fixtureHook(root, "continuing", "console.log(JSON.stringify({ continue: true }))")],
    ]);
    const { client } = await withServer([
      meta("explicit", { network: "allow", dryRun: true }),
      meta("continuing", { network: "allow", dryRun: true }),
    ], paths);
    try {
      const data = parse(await client.callTool({
        name: "hooks_preview",
        arguments: { tool_name: "Bash", tool_input: { command: "echo safe" } },
      }));

      expect(data.results.map((result: any) => result.decision)).toEqual(["approve", "approve"]);
      expect(data.decision).toBe("approve");
      expect(data.indeterminate_by).toEqual([]);
    } finally {
      await client.close();
    }
  });

  test("hooks_preview keeps malformed, ambiguous, and signaled guards indeterminate", async () => {
    const root = mkdtempSync(join(tmpdir(), "hooks-mcp-preview-hostile-output-"));
    roots.push(root);
    const paths = new Map([
      ["malformed", fixtureHook(root, "malformed", 'console.log("not-json")')],
      ["empty", fixtureHook(root, "empty", "")],
      ["nondecision", fixtureHook(root, "nondecision", "console.log(JSON.stringify({ dry_run: true }))")],
      ["ambiguous", fixtureHook(root, "ambiguous", `
        console.log(JSON.stringify({
          continue: true,
          hookSpecificOutput: { permissionDecision: "ask" },
        }));
      `)],
      ["signaled", fixtureHook(root, "signaled", 'process.kill(process.pid, "SIGTERM")')],
    ]);
    const { client } = await withServer([
      meta("malformed", { network: "allow", dryRun: true }),
      meta("empty", { network: "allow", dryRun: true }),
      meta("nondecision", { network: "allow", dryRun: true }),
      meta("ambiguous", { network: "allow", dryRun: true }),
      meta("signaled", { network: "allow", dryRun: true }),
    ], paths);
    try {
      const data = parse(await client.callTool({
        name: "hooks_preview",
        arguments: { tool_name: "Bash", tool_input: { command: "echo safe" } },
      }));

      expect(data.results.map((result: any) => result.decision)).toEqual([
        "indeterminate",
        "indeterminate",
        "indeterminate",
        "indeterminate",
        "indeterminate",
      ]);
      expect(data.results.find((result: any) => result.name === "ambiguous").error).toContain("ambiguous");
      const signaled = data.results.find((result: any) => result.name === "signaled");
      expect(signaled.decision).toBe("indeterminate");
      expect(signaled.exitCode).not.toBe(0);
      expect(signaled.error).toMatch(/signal|exited with code/);
      expect(data.decision).toBe("indeterminate");
      expect(data.indeterminate_by).toEqual([
        "malformed",
        "empty",
        "nondecision",
        "ambiguous",
        "signaled",
      ]);
    } finally {
      await client.close();
    }
  });

  test("MCP execution exposes CLAUDE_ENV_FILE only to its declared hook capability", async () => {
    const root = mkdtempSync(join(tmpdir(), "hooks-mcp-env-"));
    roots.push(root);
    const envFile = join(root, "claude-env");
    const source = 'console.log(JSON.stringify({ value: process.env.CLAUDE_ENV_FILE ?? "unset" }))';
    const paths = new Map([
      ["agentmessages", fixtureHook(root, "agentmessages", source)],
      ["ordinary", fixtureHook(root, "ordinary", source)],
    ]);
    const { client } = await withServer([
      meta("agentmessages", { network: "allow", envAllowlist: ["CLAUDE_ENV_FILE"] }),
      meta("ordinary", { network: "allow" }),
    ], paths, {
      env: { PATH: process.env.PATH ?? "", CLAUDE_ENV_FILE: envFile },
    });
    try {
      const capable = parse(await client.callTool({
        name: "hooks_run",
        arguments: { name: "agentmessages", input: {} },
      }));
      const ordinary = parse(await client.callTool({
        name: "hooks_run",
        arguments: { name: "ordinary", input: {} },
      }));
      expect(capable.output.value).toBe(envFile);
      expect(ordinary.output.value).toBe("unset");
    } finally {
      await client.close();
    }
  });
});
