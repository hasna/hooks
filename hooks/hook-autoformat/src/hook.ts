#!/usr/bin/env bun

/**
 * Claude Code Hook: autoformat
 *
 * PostToolUse hook that auto-runs the project's formatter after file edits.
 * Detects the formatter from project config files:
 *
 * - .prettierrc / prettier in package.json → bunx prettier --write <file>
 * - biome.json → bunx biome format --write <file>
 * - pyproject.toml with [tool.ruff] or [tool.black] → ruff format / black
 * - .clang-format → clang-format -i <file>
 * - Go files (.go) → gofmt -w <file>
 */

import { readFileSync, existsSync } from "fs";
import { join, extname } from "path";
import { execSync } from "child_process";

interface HookInput {
  session_id: string;
  cwd: string;
  tool_name: string;
  tool_input: Record<string, unknown>;
  tool_output?: string;
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

function hasPrettierConfig(cwd: string): boolean {
  const configFiles = [
    ".prettierrc",
    ".prettierrc.json",
    ".prettierrc.yml",
    ".prettierrc.yaml",
    ".prettierrc.js",
    ".prettierrc.cjs",
    ".prettierrc.mjs",
    "prettier.config.js",
    "prettier.config.cjs",
    "prettier.config.mjs",
  ];

  for (const file of configFiles) {
    if (existsSync(join(cwd, file))) return true;
  }

  // Check package.json for prettier key
  const packageJsonPath = join(cwd, "package.json");
  if (existsSync(packageJsonPath)) {
    try {
      const pkg = JSON.parse(readFileSync(packageJsonPath, "utf-8"));
      if (pkg.prettier) return true;
    } catch {
      // ignore
    }
  }

  return false;
}

function hasBiomeConfig(cwd: string): boolean {
  return existsSync(join(cwd, "biome.json")) || existsSync(join(cwd, "biome.jsonc"));
}

function getPythonFormatter(cwd: string): "ruff" | "black" | null {
  const pyprojectPath = join(cwd, "pyproject.toml");
  if (!existsSync(pyprojectPath)) return null;

  try {
    const content = readFileSync(pyprojectPath, "utf-8");
    if (content.includes("[tool.ruff]")) return "ruff";
    if (content.includes("[tool.black]")) return "black";
  } catch {
    // ignore
  }

  return null;
}

function hasClangFormat(cwd: string): boolean {
  return existsSync(join(cwd, ".clang-format"));
}

function isGoFile(filePath: string): boolean {
  return extname(filePath) === ".go";
}

function isPythonFile(filePath: string): boolean {
  return extname(filePath) === ".py";
}

function isFormattableByPrettier(filePath: string): boolean {
  const ext = extname(filePath).toLowerCase();
  const prettierExts = [
    ".js", ".jsx", ".ts", ".tsx", ".mjs", ".cjs",
    ".json", ".css", ".scss", ".less", ".html",
    ".md", ".mdx", ".yaml", ".yml", ".graphql",
    ".vue", ".svelte",
  ];
  return prettierExts.includes(ext);
}

function isFormattableByBiome(filePath: string): boolean {
  const ext = extname(filePath).toLowerCase();
  const biomeExts = [
    ".js", ".jsx", ".ts", ".tsx", ".mjs", ".cjs",
    ".json", ".jsonc", ".css", ".graphql",
  ];
  return biomeExts.includes(ext);
}

function isClangFormattable(filePath: string): boolean {
  const ext = extname(filePath).toLowerCase();
  const clangExts = [".c", ".cpp", ".cc", ".cxx", ".h", ".hpp", ".hxx", ".m", ".mm"];
  return clangExts.includes(ext);
}

function detectFormatter(cwd: string, filePath: string): { name: string; command: string } | null {
  // Go files always use gofmt
  if (isGoFile(filePath)) {
    return { name: "gofmt", command: `gofmt -w "${filePath}"` };
  }

  // Python files
  if (isPythonFile(filePath)) {
    const pyFormatter = getPythonFormatter(cwd);
    if (pyFormatter === "ruff") {
      return { name: "ruff", command: `ruff format "${filePath}"` };
    }
    if (pyFormatter === "black") {
      return { name: "black", command: `black "${filePath}"` };
    }
    return null;
  }

  // C/C++ files with .clang-format
  if (isClangFormattable(filePath) && hasClangFormat(cwd)) {
    return { name: "clang-format", command: `clang-format -i "${filePath}"` };
  }

  // Biome takes priority over Prettier if both exist (it's faster)
  if (hasBiomeConfig(cwd) && isFormattableByBiome(filePath)) {
    return { name: "biome", command: `bunx @biomejs/biome format --write "${filePath}"` };
  }

  // Prettier
  if (hasPrettierConfig(cwd) && isFormattableByPrettier(filePath)) {
    return { name: "prettier", command: `bunx prettier --write "${filePath}"` };
  }

  return null;
}

function runFormatter(cwd: string, name: string, command: string): void {
  try {
    execSync(command, {
      cwd,
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
      timeout: 30000, // 30s timeout
    });
    console.error(`[hook-autoformat] Formatted with ${name}`);
  } catch (error: unknown) {
    const execError = error as { stderr?: string; message?: string };
    const errorMsg = execError.stderr || execError.message || "unknown error";
    console.error(`[hook-autoformat] ${name} failed: ${errorMsg}`);
  }
}

export function run(): void {
  const input = readStdinJson();

  if (!input) {
    respond({ continue: true });
    return;
  }

  // Only process Edit and Write tools
  if (input.tool_name !== "Edit" && input.tool_name !== "Write") {
    respond({ continue: true });
    return;
  }

  const filePath = input.tool_input?.file_path as string;
  if (!filePath || typeof filePath !== "string") {
    respond({ continue: true });
    return;
  }

  const cwd = input.cwd || process.cwd();
  const formatter = detectFormatter(cwd, filePath);

  if (!formatter) {
    respond({ continue: true });
    return;
  }

  console.error(`[hook-autoformat] Running ${formatter.name} on ${filePath}`);
  runFormatter(cwd, formatter.name, formatter.command);

  respond({ continue: true });
}

if (import.meta.main) {
  run();
}
