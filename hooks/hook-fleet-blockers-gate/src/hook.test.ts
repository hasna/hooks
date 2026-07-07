import { describe, test, expect } from "bun:test";
import { isReadOnlyTool, detectFreeze, parseBlockersJson } from "./hook";

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
  });

  describe("detectFreeze", () => {
    test("finds [FREEZE] in blocker content", () => {
      const result = detectFreeze([
        { from: "chief", content: "[FREEZE] cutover in progress — stop all publishes" },
      ]);
      expect(result.frozen).toBe(true);
      expect(result.reason).toContain("chief");
      expect(result.reason).toContain("[FREEZE]");
    });

    test("finds [FREEZE] in preview field", () => {
      const result = detectFreeze([{ from: "chief", preview: "[FREEZE] db migration" }]);
      expect(result.frozen).toBe(true);
    });

    test("non-freeze blockers do not freeze", () => {
      const result = detectFreeze([
        { from: "worker", content: "please review PR #42 when you can" },
      ]);
      expect(result.frozen).toBe(false);
    });

    test("empty list does not freeze", () => {
      expect(detectFreeze([]).frozen).toBe(false);
    });

    test("garbage entries are ignored", () => {
      expect(detectFreeze([null, 42, "string", {}]).frozen).toBe(false);
    });

    test("lowercase freeze tag does not trigger (exact uppercase per HACP)", () => {
      expect(detectFreeze([{ content: "[freeze] not a real tag" }]).frozen).toBe(false);
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

});
