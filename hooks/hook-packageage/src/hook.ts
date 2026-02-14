#!/usr/bin/env bun

/**
 * Claude Code Hook: packageage
 *
 * PreToolUse hook that checks package age before npm/bun install commands.
 * Warns on packages that haven't been updated in over a year (potentially
 * abandoned) or have known deprecation markers.
 *
 * Checks the npm registry for last publish date and warns accordingly.
 */

import { readFileSync } from "fs";

interface HookInput {
  session_id: string;
  cwd: string;
  tool_name: string;
  tool_input: Record<string, unknown>;
}

interface HookOutput {
  decision?: "approve" | "block";
  reason?: string;
}

const INSTALL_PATTERNS = [
  /(?:npm|bun|yarn|pnpm)\s+(?:install|add|i)\s+/,
];

const STALE_THRESHOLD_DAYS = 365; // 1 year
const ABANDONED_THRESHOLD_DAYS = 730; // 2 years

function readStdinJson(): HookInput | null {
  try {
    const input = readFileSync(0, "utf-8").trim();
    if (!input) return null;
    return JSON.parse(input);
  } catch {
    return null;
  }
}

/**
 * Extract package names from an install command
 */
function extractPackageNames(command: string): string[] {
  // Match: npm install pkg1 pkg2 / bun add pkg1 / etc.
  const match = command.match(/(?:npm|bun|yarn|pnpm)\s+(?:install|add|i)\s+(.*)/);
  if (!match) return [];

  return match[1]
    .split(/\s+/)
    .filter((arg) => !arg.startsWith("-") && !arg.startsWith("--"))
    .map((pkg) => pkg.replace(/@[\^~><=\d].*$/, "")) // strip version specifier
    .filter((pkg) => pkg.length > 0 && !pkg.startsWith(".")); // filter paths
}

/**
 * Check package age via npm registry
 */
async function checkPackageAge(packageName: string): Promise<{
  name: string;
  lastPublish: Date | null;
  daysSincePublish: number;
  deprecated: boolean;
  error?: string;
}> {
  try {
    const response = await fetch(
      `https://registry.npmjs.org/${encodeURIComponent(packageName)}`,
      { signal: AbortSignal.timeout(5000) }
    );

    if (!response.ok) {
      return { name: packageName, lastPublish: null, daysSincePublish: 0, deprecated: false, error: `HTTP ${response.status}` };
    }

    const data = await response.json() as Record<string, unknown>;

    // Check deprecation
    const distTags = data["dist-tags"] as Record<string, string> | undefined;
    const latestVersion = distTags?.latest;
    const versions = data.versions as Record<string, Record<string, unknown>> | undefined;
    const deprecated = latestVersion && versions?.[latestVersion]?.deprecated ? true : false;

    // Get last publish date
    const time = data.time as Record<string, string> | undefined;
    const modified = time?.modified;

    if (!modified) {
      return { name: packageName, lastPublish: null, daysSincePublish: 0, deprecated };
    }

    const lastPublish = new Date(modified);
    const daysSincePublish = Math.floor(
      (Date.now() - lastPublish.getTime()) / (1000 * 60 * 60 * 24)
    );

    return { name: packageName, lastPublish, daysSincePublish, deprecated };
  } catch (error) {
    return {
      name: packageName,
      lastPublish: null,
      daysSincePublish: 0,
      deprecated: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

function respond(output: HookOutput): void {
  console.log(JSON.stringify(output));
}

export async function run(): Promise<void> {
  const input = readStdinJson();

  if (!input) {
    respond({ decision: "approve" });
    return;
  }

  if (input.tool_name !== "Bash") {
    respond({ decision: "approve" });
    return;
  }

  const command = input.tool_input?.command as string;
  if (!command || typeof command !== "string") {
    respond({ decision: "approve" });
    return;
  }

  // Check if this is a package install command
  const isInstall = INSTALL_PATTERNS.some((p) => p.test(command));
  if (!isInstall) {
    respond({ decision: "approve" });
    return;
  }

  const packages = extractPackageNames(command);
  if (packages.length === 0) {
    respond({ decision: "approve" });
    return;
  }

  const warnings: string[] = [];

  // Check each package (in parallel, with timeout)
  const results = await Promise.all(packages.map(checkPackageAge));

  for (const result of results) {
    if (result.deprecated) {
      warnings.push(`${result.name}: DEPRECATED`);
    }
    if (result.daysSincePublish > ABANDONED_THRESHOLD_DAYS) {
      warnings.push(`${result.name}: possibly abandoned (last updated ${result.daysSincePublish} days ago)`);
    } else if (result.daysSincePublish > STALE_THRESHOLD_DAYS) {
      warnings.push(`${result.name}: stale (last updated ${result.daysSincePublish} days ago)`);
    }
  }

  if (warnings.length > 0) {
    const reason = `Package age warnings:\n${warnings.map((w) => `  - ${w}`).join("\n")}\n\nConsider using more actively maintained alternatives.`;
    console.error(`[hook-packageage] ${reason}`);
    // Warn but don't block — just inject the warning
    respond({ decision: "approve", reason });
    return;
  }

  respond({ decision: "approve" });
}

if (import.meta.main) {
  run();
}
