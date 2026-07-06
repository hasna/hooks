import { describe, test, expect } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { extractSentinelVersion, scanArtifacts, evaluate, defaultArtifactPaths } from "./hook";

describe("hook-agent-rules-version-check", () => {
  describe("extractSentinelVersion", () => {
    test("extracts version from a full sentinel", () => {
      expect(
        extractSentinelVersion("x\n<!-- hasna:agent-operating-rules v=1.2.3 sha256=abc123 -->\ny")
      ).toBe("1.2.3");
    });

    test("extracts version without sha", () => {
      expect(extractSentinelVersion("<!-- hasna:agent-operating-rules v=0.9.0 -->")).toBe("0.9.0");
    });

    test("tolerates extra whitespace", () => {
      expect(extractSentinelVersion("<!--  hasna:agent-operating-rules   v=2.0.0  -->")).toBe("2.0.0");
    });

    test("returns null when no sentinel present", () => {
      expect(extractSentinelVersion("# just a doc\nno sentinel here")).toBeNull();
    });

    test("does not match other hasna sentinels", () => {
      expect(extractSentinelVersion("<!-- hasna:hacp v=1.0.0 -->")).toBeNull();
    });
  });

  describe("scanArtifacts", () => {
    test("collects sentinel hits and skips missing/plain files", () => {
      const dir = mkdtempSync(join(tmpdir(), "rules-check-"));
      try {
        const withSentinel = join(dir, "a.md");
        const withoutSentinel = join(dir, "b.md");
        writeFileSync(withSentinel, "<!-- hasna:agent-operating-rules v=1.0.0 -->");
        writeFileSync(withoutSentinel, "# no sentinel");

        const hits = scanArtifacts([withSentinel, withoutSentinel, join(dir, "missing.md")]);
        expect(hits).toHaveLength(1);
        expect(hits[0]).toEqual({ file: withSentinel, version: "1.0.0" });
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  });

  describe("defaultArtifactPaths", () => {
    test("covers the delivery-matrix runtimes", () => {
      const paths = defaultArtifactPaths("/home/u");
      expect(paths).toContain("/home/u/.claude/CLAUDE.md");
      expect(paths).toContain("/home/u/.codex/AGENTS.md");
      expect(paths).toContain("/home/u/.config/opencode/AGENTS.md");
      expect(paths).toContain("/home/u/.cursor/rules/hasna-global.mdc");
    });
  });

  describe("evaluate", () => {
    test("silent when nothing is rendered", () => {
      expect(evaluate([], "1.0.0")).toBeNull();
      expect(evaluate([], null)).toBeNull();
    });

    test("silent when all artifacts match the expected version", () => {
      const hits = [
        { file: "/a.md", version: "1.0.0" },
        { file: "/b.md", version: "1.0.0" },
      ];
      expect(evaluate(hits, "1.0.0")).toBeNull();
    });

    test("warns and lists stale artifacts on mismatch", () => {
      const hits = [
        { file: "/a.md", version: "1.0.0" },
        { file: "/b.md", version: "0.9.0" },
      ];
      const warning = evaluate(hits, "1.0.0");
      expect(warning).toContain("OUT OF DATE");
      expect(warning).toContain("/b.md: v0.9.0");
      expect(warning).not.toContain("/a.md");
    });

    test("without expected version, warns when artifacts disagree", () => {
      const hits = [
        { file: "/a.md", version: "1.0.0" },
        { file: "/b.md", version: "1.1.0" },
      ];
      const warning = evaluate(hits, null);
      expect(warning).toContain("DISAGREE");
      expect(warning).toContain("/a.md: v1.0.0");
      expect(warning).toContain("/b.md: v1.1.0");
    });

    test("without expected version, silent when artifacts agree", () => {
      const hits = [
        { file: "/a.md", version: "1.0.0" },
        { file: "/b.md", version: "1.0.0" },
      ];
      expect(evaluate(hits, null)).toBeNull();
    });
  });
});
