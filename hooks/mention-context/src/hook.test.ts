import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";

/**
 * The mention-context hook is Python, and its regression suite is Python. This
 * wrapper exists so that suite runs under the repository's existing `bun test`
 * step, with no CI workflow change and no second command for a contributor to
 * remember.
 *
 * It deliberately FAILS rather than skips when python3 is missing. A skipped
 * test and a passing one are indistinguishable in the summary line, and this
 * suite gates a defect that already reached production once: repositories were
 * reported carrying each other's git HEAD, because concurrent probes shared one
 * temp file.
 */

const SUITE = join(import.meta.dir, "test_run_capture.py");

describe("mention-context python regression suite", () => {
  test("python3 is available to run it", () => {
    const found = Bun.which("python3");
    expect(
      found,
      "python3 is not on PATH; the mention-context regression suite cannot run, " +
        "and a silent skip here would read as a pass",
    ).toBeTruthy();
  });

  test("the suite file is present", () => {
    expect(existsSync(SUITE), `missing suite at ${SUITE}`).toBe(true);
  });

  test(
    "concurrent captures do not cross temp files",
    async () => {
      const python = Bun.which("python3");
      if (!python) throw new Error("python3 not on PATH");

      const proc = Bun.spawn([python, SUITE, "-v"], {
        stdout: "pipe",
        stderr: "pipe",
      });
      const [stdout, stderr, exitCode] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
      ]);

      // unittest writes its report to stderr; surface both so a failure here is
      // diagnosable from the bun test output alone rather than needing a re-run.
      if (exitCode !== 0) {
        throw new Error(
          `python regression suite failed (exit ${exitCode})\n` +
            `--- stderr ---\n${stderr}\n--- stdout ---\n${stdout}`,
        );
      }

      // Assert the suite actually ran tests. `unittest` exits 0 when it collects
      // nothing, so a zero exit alone cannot distinguish "all passed" from
      // "nothing ran" — which is the same class of vacuous check this suite was
      // written to close.
      expect(stderr).toMatch(/Ran [1-9]\d* tests?/);
      expect(stderr).toMatch(/\bOK\b/);
    },
    120_000, // the suite forces timed interleavings; a loaded machine needs room
  );
});
