import { describe, test, expect } from "bun:test";
import {
  isReadOnlyTool,
  isSafeArg,
  marksReadState,
  buildDenyReason,
  detectFreeze,
  parseBlockersJson,
  computeFreezeState,
  decide,
} from "./hook";

const NOW = new Date("2026-07-20T00:00:00.000Z");

describe("hook-fleet-blockers-gate", () => {
  describe("isReadOnlyTool", () => {
    test("built-in read-only tools pass", () => {
      expect(isReadOnlyTool("Read")).toBe(true);
      expect(isReadOnlyTool("Glob")).toBe(true);
      expect(isReadOnlyTool("Grep")).toBe(true);
      expect(isReadOnlyTool("WebFetch")).toBe(true);
      expect(isReadOnlyTool("WebSearch")).toBe(true);
    });

    test("mutating built-ins are gated", () => {
      expect(isReadOnlyTool("Bash")).toBe(false);
      expect(isReadOnlyTool("Edit")).toBe(false);
      expect(isReadOnlyTool("Write")).toBe(false);
      expect(isReadOnlyTool("NotebookEdit")).toBe(false);
      expect(isReadOnlyTool("Task")).toBe(false);
      expect(isReadOnlyTool("TodoWrite")).toBe(false);
    });

    test("read-style MCP operations pass", () => {
      expect(isReadOnlyTool("mcp__conversations__list_channels")).toBe(true);
      expect(isReadOnlyTool("mcp__conversations__get_blockers")).toBe(true);
      expect(isReadOnlyTool("mcp__todos__search_tools")).toBe(true);
      expect(isReadOnlyTool("mcp__monitor__heartbeat")).toBe(true);
    });

    test("mutating MCP operations are gated", () => {
      expect(isReadOnlyTool("mcp__conversations__send_message")).toBe(false);
      expect(isReadOnlyTool("mcp__todos__create_task")).toBe(false);
      expect(isReadOnlyTool("mcp__configs__apply_config")).toBe(false);
      expect(isReadOnlyTool("mcp__emails__delete_domain")).toBe(false);
    });

    test("missing tool name is gated (conservative)", () => {
      expect(isReadOnlyTool(undefined)).toBe(false);
      expect(isReadOnlyTool("")).toBe(false);
    });

    test("prefix matching does not overmatch (getaway is not get)", () => {
      expect(isReadOnlyTool("mcp__x__getaway_driver")).toBe(false);
      expect(isReadOnlyTool("mcp__x__listen_events")).toBe(false);
    });

    // self-lift fix: conversations read_* tools mark messages read, which would
    // clear the blocker's read_at and lift the freeze — so they must be GATED.
    test("conversations read_* tools are GATED (they mark messages read → self-lift)", () => {
      expect(isReadOnlyTool("mcp__conversations__read_messages")).toBe(false);
      expect(isReadOnlyTool("mcp__conversations__read_channel")).toBe(false);
      expect(isReadOnlyTool("mcp__conversations__read_digest")).toBe(false);
      expect(isReadOnlyTool("mcp__conversations__read_thread")).toBe(false);
      expect(isReadOnlyTool("mcp__conversations__read_channel_notifications")).toBe(false);
    });

    test("safe conversations orientation tools stay ALLOWED during a freeze", () => {
      expect(isReadOnlyTool("mcp__conversations__get_blockers")).toBe(true);
      expect(isReadOnlyTool("mcp__conversations__get_message")).toBe(true);
      expect(isReadOnlyTool("mcp__conversations__search_messages")).toBe(true);
      expect(isReadOnlyTool("mcp__conversations__list_channels")).toBe(true);
      expect(isReadOnlyTool("mcp__conversations__get_thread_replies")).toBe(true);
    });

    test("read_* gating is scoped to conversations (other servers' read_ ops unaffected)", () => {
      expect(marksReadState("mcp__conversations__read_messages")).toBe(true);
      expect(marksReadState("mcp__conversations__get_blockers")).toBe(false);
      expect(marksReadState("mcp__files__read_file")).toBe(false);
      // a non-conversations read_ op still passes the generic prefix rule
      expect(isReadOnlyTool("mcp__files__read_file")).toBe(true);
    });
  });

  describe("buildDenyReason", () => {
    const msg = buildDenyReason("Active blocking=1 blocker from bot: [FREEZE] cutover");

    test("points at the read-only get_blockers tool", () => {
      expect(msg).toContain("mcp__conversations__get_blockers");
    });

    test("warns against the self-lifting read_* tools", () => {
      expect(msg).toContain("read_messages");
      expect(msg).toContain("read_channel");
    });

    test("does not tell the agent to run the gated Bash `conversations blockers` command", () => {
      // The phrase must not appear as a bare command instruction (it is the MCP tool that is referenced).
      expect(msg).not.toContain("conversations blockers");
    });

    test("carries the underlying blocker reason", () => {
      expect(msg).toContain("Active blocking=1 blocker from bot");
    });
  });

  describe("isSafeArg (argument-injection guard)", () => {
    test("accepts fleet agent names and email-style ids", () => {
      expect(isSafeArg("lycurgus")).toBe(true);
      expect(isSafeArg("andrei@hasna.com")).toBe(true);
      expect(isSafeArg("agent_07.beta-1")).toBe(true);
    });

    test("rejects leading dash (flag injection), spaces, shell metachars, empty", () => {
      expect(isSafeArg("--from")).toBe(false);
      expect(isSafeArg("-j")).toBe(false);
      expect(isSafeArg("a b")).toBe(false);
      expect(isSafeArg("a;rm -rf /")).toBe(false);
      expect(isSafeArg("a`whoami`")).toBe(false);
      expect(isSafeArg("$(id)")).toBe(false);
      expect(isSafeArg("")).toBe(false);
      expect(isSafeArg(undefined)).toBe(false);
    });
  });

  describe("detectFreeze — blocking=1 is the only trigger", () => {
    // blocking=1 -> DENY
    test("a blocking=1 blocker freezes (author- and text-agnostic)", () => {
      const result = detectFreeze([
        { from_agent: "andrei@hasna.com", content: "[FREEZE] fleet cutover", blocking: true },
      ]);
      expect(result.frozen).toBe(true);
      expect(result.reason).toContain("blocking=1");
      expect(result.reason).toContain("andrei@hasna.com");
    });

    test("a blocking=1 blocker with NO freeze text still freezes", () => {
      const result = detectFreeze([
        { from_agent: "release-bot", content: "migration running, do not deploy", blocking: true },
      ]);
      expect(result.frozen).toBe(true);
      expect(result.reason).toContain("release-bot");
    });

    test("a blocking=1 blocker from any author freezes (author is not a security gate)", () => {
      expect(detectFreeze([{ from_agent: "some-agent", content: "hold", blocking: true }]).frozen).toBe(true);
    });

    // freeze TEXT with no blocking=1 -> ALLOW (phantom-freeze bug stays fixed)
    test("[FREEZE] text without a blocking flag does NOT freeze (phantom-freeze fix)", () => {
      expect(
        detectFreeze([{ from_agent: "andrei@hasna.com", content: "[FREEZE] heads up", blocking: false }]).frozen
      ).toBe(false);
      expect(
        detectFreeze([{ from_agent: "some-agent", content: "[FREEZE] cutover", blocking: false }]).frozen
      ).toBe(false);
    });

    test("[UNFREEZE]/severity text is ignored entirely (no text scanning)", () => {
      expect(
        detectFreeze([{ from_agent: "andrei@hasna.com", content: "[UNFREEZE] all clear", blocking: false }]).frozen
      ).toBe(false);
    });

    // no blockers -> ALLOW
    test("empty list does not freeze", () => {
      expect(detectFreeze([]).frozen).toBe(false);
    });

    test("non-blocking messages do not freeze", () => {
      expect(detectFreeze([{ from_agent: "worker", content: "please review PR #42", blocking: false }]).frozen).toBe(false);
    });

    test("garbage entries are ignored", () => {
      expect(detectFreeze([null, 42, "string", {}]).frozen).toBe(false);
    });

    test("blocking flag tolerates numeric/string encodings (1, '1', 'true')", () => {
      expect(detectFreeze([{ from_agent: "x", content: "y", blocking: 1 }]).frozen).toBe(true);
      expect(detectFreeze([{ from_agent: "x", content: "y", blocking: "1" }]).frozen).toBe(true);
      expect(detectFreeze([{ from_agent: "x", content: "y", blocking: "true" }]).frozen).toBe(true);
    });

    test("false-y blocking encodings do not freeze", () => {
      expect(detectFreeze([{ from_agent: "x", content: "y", blocking: 0 }]).frozen).toBe(false);
      expect(detectFreeze([{ from_agent: "x", content: "y", blocking: "false" }]).frozen).toBe(false);
      expect(detectFreeze([{ from_agent: "x", content: "y" }]).frozen).toBe(false);
    });

    // order-independence: a green suite must not be able to hide a "first item only" bug
    test("a blocking=1 blocker anywhere in the list freezes (order-independent)", () => {
      const result = detectFreeze([
        { from_agent: "a", content: "note 1", blocking: false },
        { from_agent: "b", content: "note 2", blocking: false },
        { from_agent: "c", content: "note 3", blocking: false },
        { from_agent: "d", content: "the real stop", blocking: true },
      ]);
      expect(result.frozen).toBe(true);
      expect(result.reason).toContain("the real stop");
    });

    test("reads the real from_agent schema field for the advisory reason", () => {
      const result = detectFreeze([
        { from_agent: "coordinator", to_agent: "worker", channel: "announcements", content: "stop", blocking: true },
      ]);
      expect(result.reason).toContain("coordinator");
    });
  });

  describe("parseBlockersJson", () => {
    test("parses a bare array", () => {
      expect(parseBlockersJson('[{"content":"x"}]')).toHaveLength(1);
    });

    test("parses wrapped blockers", () => {
      expect(parseBlockersJson('{"blockers":[{"content":"x"}]}')).toHaveLength(1);
    });

    test("parses wrapped messages", () => {
      expect(parseBlockersJson('{"messages":[{"content":"x"}]}')).toHaveLength(1);
    });

    test("returns empty on invalid JSON", () => {
      expect(parseBlockersJson("not json")).toHaveLength(0);
    });

    test("returns empty on null/empty", () => {
      expect(parseBlockersJson(null)).toHaveLength(0);
      expect(parseBlockersJson("")).toHaveLength(0);
    });
  });

  describe("computeFreezeState — fail-open + verified", () => {
    // comms error -> ALLOW (fail-open, unverified)
    test("runner error → fail-open (not frozen, unverified)", () => {
      const e = computeFreezeState(NOW, () => {
        throw new Error("conversations CLI missing / timeout");
      });
      expect(e.state.frozen).toBe(false);
      expect(e.verified).toBe(false);
    });

    // no blockers -> ALLOW (verified)
    test("empty blockers → not frozen, verified", () => {
      const e = computeFreezeState(NOW, () => "[]");
      expect(e.state.frozen).toBe(false);
      expect(e.verified).toBe(true);
    });

    // blocking=1 -> DENY
    test("blocking=1 in CLI output → frozen, verified", () => {
      const raw = JSON.stringify([{ from_agent: "bot", content: "deploy freeze", blocking: true }]);
      const e = computeFreezeState(NOW, () => raw);
      expect(e.state.frozen).toBe(true);
      expect(e.verified).toBe(true);
    });

    test("parses the real wrapped shape and stays order-independent", () => {
      const raw = JSON.stringify({
        blockers: [
          { from_agent: "a", content: "x", blocking: false },
          { from_agent: "b", content: "stop now", blocking: true },
        ],
      });
      const e = computeFreezeState(NOW, () => raw);
      expect(e.state.frozen).toBe(true);
    });

    test("malformed CLI output → fail-open (not frozen) but verified", () => {
      const e = computeFreezeState(NOW, () => "not-json-at-all");
      expect(e.state.frozen).toBe(false);
      expect(e.verified).toBe(true);
    });
  });

  describe("decide — permission gate", () => {
    const frozen = { frozen: true, reason: "Active blocking=1 blocker from bot: x" };
    const clear = { frozen: false, reason: "" };

    // HOOKS_FLEET_GATE_DISABLE=1 -> ALLOW
    test("kill switch (disabled) → allow even under a freeze", () => {
      expect(decide({ disabled: true, toolName: "Bash", freeze: frozen }).allow).toBe(true);
    });

    // read-only tool under a blocker -> ALLOW
    test("read-only tool under an active freeze → allow", () => {
      expect(decide({ disabled: false, toolName: "Read", freeze: frozen }).allow).toBe(true);
      expect(decide({ disabled: false, toolName: "mcp__conversations__get_blockers", freeze: frozen }).allow).toBe(true);
    });

    // blocking=1 + mutating -> DENY
    test("mutating tool under an active freeze → deny (with reason)", () => {
      const d = decide({ disabled: false, toolName: "Bash", freeze: frozen });
      expect(d.allow).toBe(false);
      expect(d.reason).toContain("blocking=1");
    });

    test("mutating tool with no freeze → allow", () => {
      expect(decide({ disabled: false, toolName: "Bash", freeze: clear }).allow).toBe(true);
    });
  });
});
