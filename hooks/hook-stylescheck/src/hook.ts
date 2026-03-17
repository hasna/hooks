#!/usr/bin/env bun

/**
 * Claude Code Hook: stylescheck
 *
 * PreToolUse hook that intercepts Write/Edit calls on frontend files
 * (.tsx, .jsx, .css, .html, .scss) and warns on design anti-patterns:
 * - Hardcoded hex/rgb colors outside of design tokens
 * - Inline style objects with hardcoded values
 * - Magic number font sizes and spacing values
 * - Non-design-system z-index values
 *
 * If an open-styles profile is found at ~/.hooks/styles.json, it injects
 * project-specific design context to remind the agent of the design system.
 */

import { readFileSync, existsSync } from "fs";
import { join } from "path";
import { homedir } from "os";

interface HookInput {
  session_id?: string;
  cwd?: string;
  tool_name: string;
  tool_input: Record<string, unknown>;
}

interface HookOutput {
  decision?: "approve" | "block";
  reason?: string;
}

interface StylesProfile {
  design_system?: string;
  color_tokens?: string[];
  banned_patterns?: string[];
  notes?: string;
}

const FRONTEND_EXTENSIONS = /\.(tsx|jsx|css|scss|html|svelte)$/i;

const BANNED_PATTERNS: Array<{ pattern: RegExp; message: string; severity: "warn" | "block" }> = [
  // Hardcoded hex colors
  {
    pattern: /(?<![a-zA-Z0-9_-])#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})\b/,
    message: "Hardcoded hex color found. Use design tokens or CSS variables instead (e.g. var(--color-primary) or a Tailwind color class).",
    severity: "warn",
  },
  // Hardcoded rgb/rgba colors
  {
    pattern: /rgba?\(\s*\d+\s*,\s*\d+\s*,\s*\d+/,
    message: "Hardcoded rgb/rgba color found. Use design tokens or CSS variables instead.",
    severity: "warn",
  },
  // Inline style objects with color/background
  {
    pattern: /style\s*=\s*\{\s*\{[^}]*(?:color|background|backgroundColor)\s*:/,
    message: "Inline style with color/background detected. Prefer Tailwind classes or CSS variables.",
    severity: "warn",
  },
  // Magic font sizes in px
  {
    pattern: /fontSize\s*:\s*['"]?\d+px['"]?/,
    message: "Magic pixel font size detected. Use design-system type scale (e.g. text-sm, text-base, text-lg).",
    severity: "warn",
  },
  // Magic z-index values (not 0, 10, 20, 30... multiples of 10 are ok)
  {
    pattern: /z-index\s*:\s*(?!(?:0|10|20|30|40|50|100|200|999|9999)\b)\d+/,
    message: "Non-standard z-index value. Prefer multiples of 10 or named z-index tokens.",
    severity: "warn",
  },
  // !important in CSS (outside of resets)
  {
    pattern: /!important/,
    message: "!important usage detected. This indicates specificity issues — refactor the CSS selector instead.",
    severity: "warn",
  },
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

function loadStylesProfile(): StylesProfile | null {
  const profilePath = join(homedir(), ".hooks", "styles.json");
  if (!existsSync(profilePath)) return null;
  try {
    return JSON.parse(readFileSync(profilePath, "utf-8"));
  } catch {
    return null;
  }
}

function getFilePath(input: HookInput): string | null {
  const toolInput = input.tool_input;
  // Write tool uses 'file_path', Edit tool uses 'file_path'
  const filePath = toolInput?.file_path as string | undefined;
  return filePath || null;
}

function getContent(input: HookInput): string {
  const toolInput = input.tool_input;
  // Write: 'content', Edit: 'new_string'
  const content = (toolInput?.content || toolInput?.new_string || "") as string;
  return typeof content === "string" ? content : "";
}

function checkPatterns(content: string, profile: StylesProfile | null): string[] {
  const violations: string[] = [];

  // Check banned patterns from profile
  if (profile?.banned_patterns) {
    for (const bp of profile.banned_patterns) {
      try {
        const re = new RegExp(bp, "i");
        if (re.test(content)) {
          violations.push(`Project-specific banned pattern matched: ${bp}`);
        }
      } catch {}
    }
  }

  // Check built-in patterns
  for (const { pattern, message } of BANNED_PATTERNS) {
    if (pattern.test(content)) {
      violations.push(message);
    }
  }

  return violations;
}

function buildReason(filePath: string, violations: string[], profile: StylesProfile | null): string {
  const lines: string[] = [
    `[stylescheck] Design pattern issues in ${filePath}:`,
    "",
  ];

  for (const v of violations) {
    lines.push(`  ⚠ ${v}`);
  }

  if (profile?.design_system) {
    lines.push("");
    lines.push(`  Design system: ${profile.design_system}`);
  }

  if (profile?.color_tokens && profile.color_tokens.length > 0) {
    lines.push(`  Color tokens: ${profile.color_tokens.slice(0, 8).join(", ")}${profile.color_tokens.length > 8 ? "..." : ""}`);
  }

  if (profile?.notes) {
    lines.push(`  Notes: ${profile.notes}`);
  }

  lines.push("");
  lines.push("  Please fix the issues above before proceeding. If intentional, you can proceed anyway.");

  return lines.join("\n");
}

function respond(output: HookOutput): void {
  console.log(JSON.stringify(output));
}

export function run(): void {
  const input = readStdinJson();

  if (!input) {
    respond({ decision: "approve" });
    return;
  }

  if (!["Write", "Edit"].includes(input.tool_name)) {
    respond({ decision: "approve" });
    return;
  }

  const filePath = getFilePath(input);
  if (!filePath || !FRONTEND_EXTENSIONS.test(filePath)) {
    respond({ decision: "approve" });
    return;
  }

  const content = getContent(input);
  if (!content) {
    respond({ decision: "approve" });
    return;
  }

  const profile = loadStylesProfile();
  const violations = checkPatterns(content, profile);

  if (violations.length === 0) {
    respond({ decision: "approve" });
    return;
  }

  const reason = buildReason(filePath, violations, profile);
  console.error(`[hook-stylescheck] ${violations.length} design issue(s) in ${filePath}`);
  respond({ decision: "block", reason });
}

if (import.meta.main) {
  run();
}
