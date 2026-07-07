#!/usr/bin/env bun

/**
 * Claude Code Hook: agent-rules-version-check
 *
 * SessionStart hook that verifies the rendered Hasna agent operating rules
 * are current on this machine. It greps the rendered instruction artifacts
 * for the managed-block sentinel:
 *
 *   <!-- hasna:agent-operating-rules v=X.Y.Z ... -->
 *
 * and compares the version against the expected state:
 *   1. HOOKS_RULES_EXPECTED_VERSION env var (explicit pin), else
 *   2. the configs CLI stored copy (`configs show <slug> --format content`), else
 *   3. cross-file consistency (all rendered artifacts must agree).
 *
 * On mismatch it WARNS via SessionStart additionalContext — it never blocks
 * the session (fail-open, deterministic commands only, bounded timeouts).
 *
 * Environment:
 * - HOOKS_RULES_CHECK_DISABLE=1        → skip entirely
 * - HOOKS_RULES_EXPECTED_VERSION=x.y.z → explicit expected version
 * - HOOKS_RULES_CONFIG_SLUG=<slug>     → configs entry holding the canonical block
 *                                        (default: agent-operating-rules)
 * - HOOKS_RULES_FILES=<a:b:c>          → override the scanned artifact paths
 * - HOOKS_FLEET_TIMEOUT_MS=<n>         → configs CLI exec timeout (default 500)
 */

import { readFileSync, existsSync, readdirSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import { execSync } from "child_process";

interface HookInput {
  session_id: string;
  cwd: string;
  hook_event_name: string;
  source?: string;
}

interface HookOutput {
  continue: boolean;
  hookSpecificOutput?: {
    hookEventName: "SessionStart";
    additionalContext: string;
  };
}

export interface SentinelHit {
  file: string;
  version: string;
}

const SENTINEL_RE = /<!--\s*hasna:agent-operating-rules\s+v=([^\s>]+)[^>]*-->/;
const DEFAULT_TIMEOUT_MS = 500;

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

function timeoutMs(): number {
  const raw = Number(process.env.HOOKS_FLEET_TIMEOUT_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_TIMEOUT_MS;
}

/** Extract the sentinel version from rendered content, or null when absent. */
export function extractSentinelVersion(content: string): string | null {
  const match = SENTINEL_RE.exec(content);
  return match ? match[1] : null;
}

/** The rendered instruction artifacts checked by default (per delivery matrix). */
export function defaultArtifactPaths(home: string): string[] {
  const paths = [
    join(home, ".claude", "CLAUDE.md"),
    join(home, ".codex", "AGENTS.md"),
    join(home, ".config", "opencode", "AGENTS.md"),
    join(home, ".cursor", "rules", "hasna-global.mdc"),
  ];

  // Claude Code managed instruction files live in a directory; include all .md files.
  const claudeInstructionsDir = join(home, ".claude", ".hasna", "instructions");
  try {
    if (existsSync(claudeInstructionsDir)) {
      for (const entry of readdirSync(claudeInstructionsDir)) {
        if (entry.endsWith(".md")) paths.push(join(claudeInstructionsDir, entry));
      }
    }
  } catch {
    // unreadable dir → skip
  }

  return paths;
}

function artifactPaths(): string[] {
  const override = process.env.HOOKS_RULES_FILES;
  if (override) {
    return override.split(":").map((p) => p.trim()).filter(Boolean);
  }
  return defaultArtifactPaths(homedir());
}

/** Scan artifacts for sentinels. Files that do not exist are skipped silently. */
export function scanArtifacts(paths: string[]): SentinelHit[] {
  const hits: SentinelHit[] = [];
  for (const path of paths) {
    try {
      if (!existsSync(path)) continue;
      const content = readFileSync(path, "utf-8");
      const version = extractSentinelVersion(content);
      if (version) hits.push({ file: path, version });
    } catch {
      // unreadable file → skip (fail-open)
    }
  }
  return hits;
}

/** Expected version from configs state; null when unavailable (fail-open). */
function expectedFromConfigs(): string | null {
  const slug = process.env.HOOKS_RULES_CONFIG_SLUG || "agent-operating-rules";
  if (!/^[A-Za-z0-9._-]{1,80}$/.test(slug)) return null;
  try {
    const out = execSync(`configs show ${slug} --format content`, {
      encoding: "utf-8",
      timeout: timeoutMs(),
      stdio: ["pipe", "pipe", "pipe"],
    });
    return extractSentinelVersion(out);
  } catch {
    return null;
  }
}

/**
 * Compare rendered sentinels against the expected version.
 * Returns a warning string, or null when everything is current/unknowable.
 */
export function evaluate(hits: SentinelHit[], expected: string | null): string | null {
  if (hits.length === 0) {
    // Rules not rendered on this machine (or runtime not installed) — nothing
    // to compare. Distribution is a separate rollout task; stay silent.
    return null;
  }

  const versions = [...new Set(hits.map((h) => h.version))];

  if (expected) {
    const stale = hits.filter((h) => h.version !== expected);
    if (stale.length > 0) {
      return (
        `Agent operating rules are OUT OF DATE on this machine (expected v${expected}):\n` +
        stale.map((h) => `- ${h.file}: v${h.version}`).join("\n") +
        `\nRe-sync before doing risky or fleet-affecting work.`
      );
    }
    return null;
  }

  // No authoritative expected version — enforce cross-artifact consistency.
  if (versions.length > 1) {
    return (
      `Agent operating rules DISAGREE across rendered artifacts (no configs state available):\n` +
      hits.map((h) => `- ${h.file}: v${h.version}`).join("\n") +
      `\nRe-render the rules so every runtime carries the same version.`
    );
  }

  return null;
}

export function run(): void {
  if (process.env.HOOKS_RULES_CHECK_DISABLE === "1") {
    respond({ continue: true });
    return;
  }

  const input = readStdinJson();
  if (!input) {
    respond({ continue: true });
    return;
  }

  const hits = scanArtifacts(artifactPaths());
  const expected = process.env.HOOKS_RULES_EXPECTED_VERSION || expectedFromConfigs();
  const warning = evaluate(hits, expected || null);

  if (warning) {
    respond({
      continue: true,
      hookSpecificOutput: {
        hookEventName: "SessionStart",
        additionalContext: `[hook-agent-rules-version-check] WARNING: ${warning}`,
      },
    });
    return;
  }

  respond({ continue: true });
}

if (import.meta.main) {
  run();
}
