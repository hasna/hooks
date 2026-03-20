#!/usr/bin/env bun

/**
 * Claude Code Hook: affected-tests
 *
 * PostToolUse hook that maps edited files to their test files and runs them.
 * After any Edit/Write/NotebookEdit, finds related tests and runs them in the background.
 *
 * Test file discovery:
 *   src/foo.ts       → src/foo.test.ts, src/foo.spec.ts
 *   src/lib/bar.ts   → src/lib/bar.test.ts, test/lib/bar.test.ts
 *   components/X.tsx → components/X.test.tsx, __tests__/X.test.tsx
 */

import { readFileSync, existsSync } from "fs";
import { join, dirname, basename, extname } from "path";
import { execSync } from "child_process";

interface HookInput {
  session_id: string;
  cwd: string;
  tool_name: string;
  tool_input: Record<string, unknown>;
  tool_output?: unknown;
}

interface HookOutput {
  continue: boolean;
}

function readStdinJson(): HookInput | null {
  try {
    const input = readFileSync(0, "utf-8").trim();
    if (!input) return null;
    return JSON.parse(input);
  } catch {
    return null;
  }
}

function respond(output: HookOutput): void {
  console.log(JSON.stringify(output));
}

function isTestFile(filePath: string): boolean {
  return /\.(test|spec)\.[jt]sx?$/.test(filePath) || /_test\.(py|go|rs)$/.test(filePath) || /test_.*\.py$/.test(filePath);
}

function findTestFiles(filePath: string, cwd: string): string[] {
  if (isTestFile(filePath)) return []; // Don't run tests for editing test files directly

  const ext = extname(filePath);
  const base = basename(filePath, ext);
  const dir = dirname(filePath);

  const candidates: string[] = [];

  // Same-directory test file variants
  const testExts = [`.test${ext}`, `.spec${ext}`, `.test.ts`, `.spec.ts`, `.test.tsx`, `.spec.tsx`];
  for (const testExt of testExts) {
    candidates.push(join(dir, `${base}${testExt}`));
  }

  // __tests__ directory
  candidates.push(join(dir, "__tests__", `${base}.test${ext}`));
  candidates.push(join(dir, "__tests__", `${base}.spec${ext}`));

  // Parallel test directory (src/ → test/ or tests/)
  for (const testDir of ["test", "tests", "__tests__"]) {
    const relPath = filePath.replace(/^.*?\/(src|lib|app)\//, "");
    candidates.push(join(cwd, testDir, relPath.replace(ext, `.test${ext}`)));
    candidates.push(join(cwd, testDir, relPath.replace(ext, `.spec${ext}`)));
  }

  return candidates.filter((p) => existsSync(p));
}

function detectTestCommand(cwd: string): string {
  const pkgPath = join(cwd, "package.json");
  if (existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
      const scripts = pkg.scripts || {};
      if (scripts.test) return "bun test";
    } catch {}
  }
  return "bun test";
}

function runTests(cwd: string, testFiles: string[]): void {
  const cmd = detectTestCommand(cwd);
  const fileArgs = testFiles.map((f) => `"${f}"`).join(" ");
  const fullCmd = `${cmd} ${fileArgs}`;

  console.error(`[hook-affected-tests] Running: ${fullCmd}`);

  try {
    const output = execSync(fullCmd, {
      cwd,
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
      timeout: 60_000,
    });
    const lines = output.trim().split("\n");
    const summary = lines[lines.length - 1] || "Tests passed";
    console.error(`[hook-affected-tests] ${summary}`);
  } catch (error: unknown) {
    const execError = error as { stdout?: string; stderr?: string };
    const output = (execError.stdout || "") + (execError.stderr || "");
    const lines = output.trim().split("\n").filter((l) => l.trim());
    const summary = lines.slice(-3).join(" | ");
    console.error(`[hook-affected-tests] Tests failed: ${summary}`);
  }
}

export function run(): void {
  const input = readStdinJson();

  if (!input) {
    respond({ continue: true });
    return;
  }

  const filePath = (input.tool_input.file_path || input.tool_input.notebook_path) as
    | string
    | undefined;

  if (!filePath) {
    respond({ continue: true });
    return;
  }

  const testFiles = findTestFiles(filePath, input.cwd);

  if (testFiles.length === 0) {
    respond({ continue: true });
    return;
  }

  console.error(`[hook-affected-tests] Found ${testFiles.length} test file(s) for ${basename(filePath)}`);
  runTests(input.cwd, testFiles);

  respond({ continue: true });
}

if (import.meta.main) {
  run();
}
