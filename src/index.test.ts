/**
 * Tests for the library public API (src/index.ts).
 * Ensures all exported functions and types are accessible.
 */

import { describe, test, expect } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import {
  HOOKS,
  CATEGORIES,
  getHook,
  getHooksByCategory,
  searchHooks,
  resolveHookNetworkAccess,
  resolveHookEnvironmentAllowlist,
  installHook,
  installHooks,
  getInstalledHooks,
  getRegisteredHooks,
  getRegisteredHooksForTarget,
  removeHook,
  hookExists,
  getHookPath,
  getSettingsPath,
  installHookForProject,
  installHooksForProject,
  listProjectHooks,
  removeProjectHook,
  runHook,
  type HookMeta,
  type Category,
  type InstallResult,
  type InstallOptions,
  type Scope,
  type Target,
  type HookInput,
  type HookOutput,
  type HookAgentInfo,
  type RunHookOptions,
  type RunHookResult,
} from "./index.js";

describe("library exports", () => {
  test("HOOKS is an array of 48 hooks", () => {
    expect(Array.isArray(HOOKS)).toBe(true);
    expect(HOOKS).toHaveLength(48);
  });

  test("CATEGORIES is an array of 10 categories", () => {
    expect(CATEGORIES).toHaveLength(10);
  });

  test("getHook is a function", () => {
    expect(typeof getHook).toBe("function");
    expect(getHook("gitguard")?.name).toBe("gitguard");
  });

  test("getHooksByCategory is a function", () => {
    expect(typeof getHooksByCategory).toBe("function");
    expect(getHooksByCategory("Git Safety")).toHaveLength(5);
  });

  test("searchHooks is a function", () => {
    expect(typeof searchHooks).toBe("function");
    expect(searchHooks("git").length).toBeGreaterThan(0);
  });

  test("installHook is a function", () => {
    expect(typeof installHook).toBe("function");
  });

  test("installHooks is a function", () => {
    expect(typeof installHooks).toBe("function");
  });

  test("getInstalledHooks is a function", () => {
    expect(typeof getInstalledHooks).toBe("function");
  });

  test("getRegisteredHooks is a function", () => {
    expect(typeof getRegisteredHooks).toBe("function");
  });

  test("removeHook is a function", () => {
    expect(typeof removeHook).toBe("function");
  });

  test("hookExists is a function", () => {
    expect(typeof hookExists).toBe("function");
  });

  test("getHookPath is a function", () => {
    expect(typeof getHookPath).toBe("function");
  });

  test("getSettingsPath is a function", () => {
    expect(typeof getSettingsPath).toBe("function");
  });

  test("getRegisteredHooksForTarget is a function", () => {
    expect(typeof getRegisteredHooksForTarget).toBe("function");
  });

  test("installHookForProject is a function", () => {
    expect(typeof installHookForProject).toBe("function");
  });

  test("installHooksForProject is a function", () => {
    expect(typeof installHooksForProject).toBe("function");
  });

  test("listProjectHooks is a function", () => {
    expect(typeof listProjectHooks).toBe("function");
    expect(Array.isArray(listProjectHooks())).toBe(true);
  });

  test("removeProjectHook is a function", () => {
    expect(typeof removeProjectHook).toBe("function");
  });

  test("runHook is a function", () => {
    expect(typeof runHook).toBe("function");
  });

  test("standalone hooks declare the exact audited remote-access set", () => {
    expect(HOOKS.filter((hook) => hook.network === "allow").map((hook) => hook.name)).toEqual([
      "packageage",
      "phonenotify",
      "slacknotify",
      "session-start",
      "stop-sync",
      "fleet-catchup",
      "fleet-blockers-gate",
    ]);
    expect(getHook("pre-bash")?.network).toBe("deny");
    expect(getHook("worktree-guard")?.network).toBe("deny");
    expect(getHook("gitguard")?.network).toBeUndefined();
    expect(getHook("agentmessages")?.network).toBeUndefined();
    expect(getHook("knowledge-context")?.network).toBeUndefined();
    expect(resolveHookNetworkAccess(getHook("announce-start")!)).toBe("deny");
    expect(getHook("agent-rules-version-check")?.network).toBeUndefined();
    for (const shellInterpolatingHook of ["failure-to-task", "announce-stop", "dm-inject"]) {
      expect(getHook(shellInterpolatingHook)?.network).toBeUndefined();
    }
    for (const detachedProviderHook of ["checktests", "checkfiles", "checkbugs", "checkdocs", "checksecurity"]) {
      expect(getHook(detachedProviderHook)?.network).toBeUndefined();
    }
    expect(resolveHookNetworkAccess(getHook("session-start")!, "deny")).toBe("deny");
    expect(resolveHookNetworkAccess(getHook("phonenotify")!, "allow")).toBe("allow");
    expect(() => resolveHookNetworkAccess(getHook("pre-bash")!, "allow")).toThrow("cannot be elevated");
    expect(() => resolveHookNetworkAccess(getHook("gitguard")!, "allow")).toThrow("cannot be elevated");
  });

  test("runHook cannot elevate a local-only guard to network allow", async () => {
    let message = "";
    try {
      await runHook("pre-bash", { hook_event_name: "PreToolUse" }, { network: "allow" });
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toContain("cannot be elevated");
  });

  test("runHook environment capabilities cannot be elevated across hooks", () => {
    expect(resolveHookEnvironmentAllowlist(getHook("agentmessages")!)).toEqual(["CLAUDE_ENV_FILE"]);
    expect(() => resolveHookEnvironmentAllowlist(
      getHook("gitguard")!,
      ["CLAUDE_ENV_FILE"],
    )).toThrow("does not declare environment capability");
  });

  test("runHook preserves network access only for a declared remote hook", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "hooks-sdk-network-"));
    let requests = 0;
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: () => {
        requests += 1;
        return new Response("ok");
      },
    });
    try {
      mkdirSync(join(tmp, ".claude"), { recursive: true });
      writeFileSync(join(tmp, ".claude", "settings.json"), JSON.stringify({
        phoneNotifyConfig: {
          enabled: true,
          topic: "synthetic-network",
          server: `http://127.0.0.1:${server.port}`,
        },
      }));

      const result = await runHook("phonenotify", {
        hook_event_name: "Stop",
        cwd: tmp,
      }, {
        env: { HOME: tmp, PATH: process.env.PATH ?? "" },
      });

      expect(result.exitCode).toBe(0);
      expect(result.error).toBeNull();
      expect(result.output.continue).toBe(true);
      expect(requests).toBe(1);

      const denied = await runHook("phonenotify", {
        hook_event_name: "Stop",
        cwd: tmp,
      }, {
        network: "deny",
        env: { HOME: tmp, PATH: process.env.PATH ?? "" },
      });
      expect(denied.exitCode).toBe(0);
      expect(denied.output.continue).toBe(true);
      expect(requests).toBe(1);
    } finally {
      server.stop();
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("runHook propagates dry-run before stop-sync mutations", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "hooks-sdk-dry-run-"));
    const bin = join(tmp, "bin");
    const mutationLog = join(tmp, "mutations.log");
    try {
      mkdirSync(bin, { recursive: true });
      const fake = `#!/bin/sh\nprintf '%s\\n' "$0 $*" >> ${JSON.stringify(mutationLog)}\nprintf '{}\\n'\n`;
      for (const name of ["conversations", "todos", "mementos"]) {
        const path = join(bin, name);
        writeFileSync(path, fake);
        chmodSync(path, 0o755);
      }

      const result = await runHook("stop-sync", {
        hook_event_name: "Stop",
        session_id: "sdk-dry-run",
        agent: { agent_id: "synthetic-agent", agent_type: "codewith", name: "synthetic-agent" },
      }, {
        dryRun: true,
        env: {
          PATH: bin,
          HOME: tmp,
          HASNA_HOOKS_STOP_SYNC_TASK_COMMENT: "1",
        },
      });

      expect(result.exitCode).toBe(0);
      expect(result.output.continue).toBe(true);
      expect(result.error).toBeNull();
      expect(existsSync(mutationLog)).toBe(false);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("runHook is routed through the shared input cap", async () => {
    const result = await runHook("stop-sync", {
      hook_event_name: "Stop",
      session_id: "sdk-input-cap",
    }, { dryRun: true, maxInputBytes: 1 });

    expect(result.exitCode).toBe(1);
    expect(result.error).toContain("hook input exceeds");
    expect(result.output).toEqual({ raw: "" });
  });
});
