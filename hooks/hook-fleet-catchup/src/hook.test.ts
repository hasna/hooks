import { describe, test, expect } from "bun:test";
import {
  parseJsonList,
  resolveSince,
  formatCatchup,
  truncate,
  safeIdentifier,
  safeSince,
} from "./hook";

describe("hook-fleet-catchup", () => {
  describe("parseJsonList", () => {
    test("parses a bare array", () => {
      expect(parseJsonList('[1,2]')).toEqual([1, 2]);
    });

    test("unwraps named keys in order", () => {
      expect(parseJsonList('{"blockers":[1]}', "blockers", "messages")).toEqual([1]);
      expect(parseJsonList('{"messages":[2]}', "blockers", "messages")).toEqual([2]);
    });

    test("returns empty for garbage and null", () => {
      expect(parseJsonList("nope")).toEqual([]);
      expect(parseJsonList(null)).toEqual([]);
      expect(parseJsonList('{"other":true}')).toEqual([]);
    });
  });

  describe("resolveSince", () => {
    const now = new Date("2026-07-06T12:00:00.000Z");

    test("uses the stored timestamp when valid and in the past", () => {
      expect(resolveSince(now, "2026-07-06T09:30:00.000Z")).toBe("2026-07-06T09:30:00.000Z");
    });

    test("falls back to 24h lookback when state is missing", () => {
      expect(resolveSince(now, null)).toBe("2026-07-05T12:00:00.000Z");
    });

    test("falls back when state is garbage", () => {
      expect(resolveSince(now, "not-a-date")).toBe("2026-07-05T12:00:00.000Z");
    });

    test("falls back when state is in the future (clock skew)", () => {
      expect(resolveSince(now, "2027-01-01T00:00:00.000Z")).toBe("2026-07-05T12:00:00.000Z");
    });
  });

  describe("formatCatchup", () => {
    test("returns null when everything is empty", () => {
      expect(formatCatchup([], [], null)).toBeNull();
      expect(formatCatchup([], [], '{"messages":[]}')).toBeNull();
    });

    test("includes blockers section with read-duty reminder", () => {
      const out = formatCatchup(
        [{ from: "chief", content: "[FREEZE] hold publishes", created_at: "2026-07-06T10:00:00Z" }],
        [],
        null
      );
      expect(out).toContain("UNREAD BLOCKING MESSAGES (1)");
      expect(out).toContain("[FREEZE] hold publishes");
      expect(out).toContain("stop and escalate");
    });

    test("includes notifications and digest sections", () => {
      const out = formatCatchup(
        [],
        [{ from: "bot", channel: "git-releases", preview: "released x@1.0.0" }],
        JSON.stringify({ messages: [{ from: "chief", content: "[POLICY] HACP v1.1" }] })
      );
      expect(out).toContain("CHANNEL NOTIFICATIONS since last catchup (1)");
      expect(out).toContain("#git-releases");
      expect(out).toContain("ANNOUNCEMENTS digest");
      expect(out).toContain("[POLICY] HACP v1.1");
    });

    test("skips digest section when digest JSON is invalid", () => {
      const out = formatCatchup([{ content: "x" }], [], "garbage");
      expect(out).toContain("UNREAD BLOCKING MESSAGES");
      expect(out).not.toContain("ANNOUNCEMENTS digest");
    });

    test("caps listed blockers at 10", () => {
      const blockers = Array.from({ length: 25 }, (_, i) => ({ content: `blocker-${i}` }));
      const out = formatCatchup(blockers, [], null)!;
      expect(out).toContain("UNREAD BLOCKING MESSAGES (25)");
      expect(out).toContain("blocker-9");
      expect(out).not.toContain("blocker-10");
      expect(out.split("\n").filter((l) => l.startsWith("- ")).length).toBe(10);
    });
  });

  describe("truncate", () => {
    test("passes short strings through", () => {
      expect(truncate("abc", 10)).toBe("abc");
    });

    test("truncates long strings with ellipsis", () => {
      const out = truncate("a".repeat(50), 10);
      expect(out.length).toBe(10);
      expect(out.endsWith("…")).toBe(true);
    });
  });

  describe("safeIdentifier", () => {
    test("accepts normal agent names", () => {
      expect(safeIdentifier("chief")).toBe("chief");
      expect(safeIdentifier("build-hooks_01.a")).toBe("build-hooks_01.a");
    });

    test("rejects shell metacharacters", () => {
      expect(safeIdentifier("$(rm -rf /)")).toBeNull();
      expect(safeIdentifier("a;b")).toBeNull();
      expect(safeIdentifier("a b")).toBeNull();
      expect(safeIdentifier("`x`")).toBeNull();
    });

    test("rejects empty/undefined", () => {
      expect(safeIdentifier(undefined)).toBeNull();
      expect(safeIdentifier("")).toBeNull();
    });
  });

  describe("safeSince", () => {
    test("accepts relative durations", () => {
      expect(safeSince("7d", "1d")).toBe("7d");
      expect(safeSince("24h", "1d")).toBe("24h");
    });

    test("accepts ISO timestamps", () => {
      expect(safeSince("2026-07-06T00:00:00Z", "1d")).toBe("2026-07-06T00:00:00Z");
    });

    test("falls back on anything else", () => {
      expect(safeSince("; rm -rf /", "7d")).toBe("7d");
      expect(safeSince("$(x)", "7d")).toBe("7d");
      expect(safeSince(undefined, "7d")).toBe("7d");
    });
  });
});
