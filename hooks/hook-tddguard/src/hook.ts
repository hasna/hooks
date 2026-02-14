#!/usr/bin/env bun

/**
 * Claude Code Hook: tddguard
 *
 * PreToolUse hook that enforces TDD by blocking implementation file edits
 * unless a corresponding test file exists in the project.
 *
 * Rules:
 * - Test files (*.test.ts, *.spec.ts, *_test.py, test_*.py, *_test.go) → always approve
 * - Config/non-code files (*.json, *.md, *.yml, etc.) → always approve
 * - Implementation files → check if a corresponding test file exists; block if not
 */

import { readFileSync, existsSync } from "fs";
import { basename, dirname, join, extname } from "path";

interface HookInput {
  session_id: string;
  cwd: string;
  tool_name: string;
  tool_input: Record<string, unknown>;
}

interface HookOutput {
  decision: "approve" | "block";
  reason?: string;
}

/** File extensions that never need tests */
const SKIP_EXTENSIONS = new Set([
  ".json",
  ".md",
  ".yml",
  ".yaml",
  ".toml",
  ".css",
  ".scss",
  ".less",
  ".html",
  ".svg",
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".ico",
  ".lock",
  ".txt",
  ".env",
  ".gitignore",
  ".dockerignore",
  ".editorconfig",
  ".prettierrc",
  ".eslintrc",
]);

/** File basenames that never need tests */
const SKIP_BASENAMES = new Set([
  "package.json",
  "tsconfig.json",
  "biome.json",
  "vite.config.ts",
  "vite.config.js",
  "next.config.js",
  "next.config.mjs",
  "next.config.ts",
  "tailwind.config.js",
  "tailwind.config.ts",
  "postcss.config.js",
  "postcss.config.mjs",
  "jest.config.ts",
  "jest.config.js",
  "vitest.config.ts",
  "vitest.config.js",
  "Makefile",
  "Dockerfile",
  "docker-compose.yml",
  "docker-compose.yaml",
  ".babelrc",
  ".env.example",
  ".env.local",
  "CLAUDE.md",
  "README.md",
  "LICENSE",
  "CHANGELOG.md",
]);

/** Patterns that identify a test file */
const TEST_FILE_PATTERNS: RegExp[] = [
  /\.test\.[jt]sx?$/,       // *.test.ts, *.test.js, *.test.tsx, *.test.jsx
  /\.spec\.[jt]sx?$/,       // *.spec.ts, *.spec.js, *.spec.tsx, *.spec.jsx
  /_test\.py$/,              // *_test.py
  /^test_.*\.py$/,           // test_*.py
  /_test\.go$/,              // *_test.go
  /\.test\.go$/,             // *.test.go (less common but valid)
  /Test\.java$/,             // *Test.java
  /_test\.rb$/,              // *_test.rb
  /\.test\.rb$/,             // *.test.rb
  /_spec\.rb$/,              // *_spec.rb
];

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
  const name = basename(filePath);
  return TEST_FILE_PATTERNS.some((pattern) => pattern.test(name));
}

function shouldSkipFile(filePath: string): boolean {
  const name = basename(filePath);
  const ext = extname(filePath).toLowerCase();

  // Skip config and non-code files
  if (SKIP_EXTENSIONS.has(ext)) return true;
  if (SKIP_BASENAMES.has(name)) return true;

  // Skip files in common config/non-code directories
  const lowerPath = filePath.toLowerCase();
  if (lowerPath.includes("/node_modules/")) return true;
  if (lowerPath.includes("/.claude/")) return true;
  if (lowerPath.includes("/dist/")) return true;
  if (lowerPath.includes("/build/")) return true;
  if (lowerPath.includes("/.git/")) return true;

  return false;
}

/**
 * Generate possible test file paths for a given implementation file.
 * Checks the same directory, __tests__/, tests/, and test/ subdirectories.
 */
function getPossibleTestPaths(filePath: string, cwd: string): string[] {
  const dir = dirname(filePath);
  const name = basename(filePath);
  const ext = extname(filePath);
  const nameWithoutExt = name.slice(0, name.length - ext.length);

  const testPaths: string[] = [];
  const resolvedDir = filePath.startsWith("/") ? dir : join(cwd, dir);

  // TypeScript/JavaScript patterns
  if ([".ts", ".tsx", ".js", ".jsx"].includes(ext)) {
    const testExts = ext.includes("x") ? [ext] : [ext];
    for (const testExt of testExts) {
      // Same directory: foo.test.ts, foo.spec.ts
      testPaths.push(join(resolvedDir, `${nameWithoutExt}.test${testExt}`));
      testPaths.push(join(resolvedDir, `${nameWithoutExt}.spec${testExt}`));
      // __tests__/ directory
      testPaths.push(join(resolvedDir, "__tests__", `${nameWithoutExt}.test${testExt}`));
      testPaths.push(join(resolvedDir, "__tests__", `${nameWithoutExt}.spec${testExt}`));
      // tests/ directory (sibling)
      testPaths.push(join(resolvedDir, "tests", `${nameWithoutExt}.test${testExt}`));
      testPaths.push(join(resolvedDir, "tests", `${nameWithoutExt}.spec${testExt}`));
      // Parent __tests__/
      testPaths.push(join(resolvedDir, "..", "__tests__", `${nameWithoutExt}.test${testExt}`));
      testPaths.push(join(resolvedDir, "..", "__tests__", `${nameWithoutExt}.spec${testExt}`));
    }
  }

  // Python patterns
  if (ext === ".py") {
    // Same directory: test_foo.py, foo_test.py
    testPaths.push(join(resolvedDir, `test_${name}`));
    testPaths.push(join(resolvedDir, `${nameWithoutExt}_test.py`));
    // tests/ directory
    testPaths.push(join(resolvedDir, "tests", `test_${name}`));
    testPaths.push(join(resolvedDir, "tests", `${nameWithoutExt}_test.py`));
    // Parent tests/
    testPaths.push(join(resolvedDir, "..", "tests", `test_${name}`));
    testPaths.push(join(resolvedDir, "..", "tests", `${nameWithoutExt}_test.py`));
  }

  // Go patterns
  if (ext === ".go") {
    testPaths.push(join(resolvedDir, `${nameWithoutExt}_test.go`));
  }

  // Java patterns
  if (ext === ".java") {
    testPaths.push(join(resolvedDir, `${nameWithoutExt}Test.java`));
    // Common Maven/Gradle structure: src/test/java mirrors src/main/java
    const testDir = resolvedDir.replace("/src/main/", "/src/test/");
    if (testDir !== resolvedDir) {
      testPaths.push(join(testDir, `${nameWithoutExt}Test.java`));
    }
  }

  // Ruby patterns
  if (ext === ".rb") {
    testPaths.push(join(resolvedDir, `${nameWithoutExt}_test.rb`));
    testPaths.push(join(resolvedDir, `${nameWithoutExt}_spec.rb`));
    testPaths.push(join(resolvedDir, "test", `${nameWithoutExt}_test.rb`));
    testPaths.push(join(resolvedDir, "spec", `${nameWithoutExt}_spec.rb`));
  }

  return testPaths;
}

function hasCorrespondingTest(filePath: string, cwd: string): boolean {
  const possiblePaths = getPossibleTestPaths(filePath, cwd);
  return possiblePaths.some((testPath) => existsSync(testPath));
}

function getFilePath(toolInput: Record<string, unknown>): string | null {
  return (toolInput.file_path as string) || null;
}

export function run(): void {
  const input = readStdinJson();

  if (!input) {
    respond({ decision: "approve" });
    return;
  }

  const filePath = getFilePath(input.tool_input);
  if (!filePath) {
    respond({ decision: "approve" });
    return;
  }

  // Always approve test files
  if (isTestFile(filePath)) {
    respond({ decision: "approve" });
    return;
  }

  // Skip files that don't need tests
  if (shouldSkipFile(filePath)) {
    respond({ decision: "approve" });
    return;
  }

  // Check if a corresponding test file exists
  if (hasCorrespondingTest(filePath, input.cwd)) {
    respond({ decision: "approve" });
    return;
  }

  // No test file found — block the edit
  const name = basename(filePath);
  console.error(`[hook-tddguard] No test file found for ${name}. Write tests first (TDD).`);
  respond({
    decision: "block",
    reason: `Write tests first (TDD). No test file found for "${name}". Create a test file before editing implementation code.`,
  });
}

if (import.meta.main) {
  run();
}
