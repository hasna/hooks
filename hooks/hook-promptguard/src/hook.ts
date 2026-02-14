#!/usr/bin/env bun

/**
 * Claude Code Hook: promptguard
 *
 * UserPromptSubmit hook that validates user prompts before Claude processes them.
 * Blocks prompts containing:
 * - Known prompt injection patterns
 * - Attempts to access credentials
 * - Social engineering attempts
 *
 * All matching is case-insensitive.
 */

import { readFileSync } from "fs";

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

/**
 * Patterns that indicate prompt injection attempts
 */
const INJECTION_PATTERNS: RegExp[] = [
  /ignore\s+(all\s+)?previous\s+instructions/i,
  /ignore\s+(all\s+)?prior\s+instructions/i,
  /ignore\s+(all\s+)?above\s+instructions/i,
  /disregard\s+(all\s+)?previous\s+instructions/i,
  /disregard\s+(all\s+)?prior\s+instructions/i,
  /forget\s+(all\s+)?previous\s+instructions/i,
  /override\s+(all\s+)?previous\s+instructions/i,
  /new\s+system\s+prompt/i,
  /your\s+system\s+prompt/i,
  /reveal\s+(your\s+)?system\s+prompt/i,
  /show\s+(me\s+)?(your\s+)?system\s+prompt/i,
  /print\s+(your\s+)?system\s+prompt/i,
  /output\s+(your\s+)?system\s+prompt/i,
  /what\s+(is|are)\s+your\s+instructions/i,
  /you\s+are\s+now\b/i,
  /from\s+now\s+on\s+you\s+are/i,
  /you\s+have\s+been\s+reprogrammed/i,
  /entering\s+(a\s+)?new\s+mode/i,
  /switch\s+to\s+(\w+\s+)?mode/i,
  /jailbreak/i,
  /DAN\s+mode/i,
];

/**
 * Patterns that attempt to access credentials
 */
const CREDENTIAL_PATTERNS: RegExp[] = [
  /show\s+(me\s+)?(the\s+)?api\s*key/i,
  /print\s+(the\s+)?api\s*key/i,
  /reveal\s+(the\s+)?api\s*key/i,
  /display\s+(the\s+)?api\s*key/i,
  /output\s+(the\s+)?api\s*key/i,
  /what\s+(is|are)\s+(the\s+)?api\s*key/i,
  /show\s+(me\s+)?(the\s+)?token/i,
  /print\s+(the\s+)?token/i,
  /reveal\s+(the\s+)?token/i,
  /display\s+(the\s+)?token/i,
  /show\s+(me\s+)?(the\s+)?password/i,
  /print\s+(the\s+)?password/i,
  /reveal\s+(the\s+)?password/i,
  /display\s+(the\s+)?password/i,
  /show\s+(me\s+)?(the\s+)?secret/i,
  /print\s+(the\s+)?secret/i,
  /reveal\s+(the\s+)?secret/i,
  /show\s+(me\s+)?(the\s+)?credentials/i,
  /reveal\s+(the\s+)?credentials/i,
  /dump\s+(all\s+)?credentials/i,
  /dump\s+(all\s+)?secrets/i,
  /dump\s+(all\s+)?tokens/i,
  /extract\s+(the\s+)?credentials/i,
  /read\s+\.env\b/i,
  /cat\s+\.env\b/i,
  /cat\s+\.secrets\//i,
];

/**
 * Patterns that indicate social engineering attempts
 */
const SOCIAL_ENGINEERING_PATTERNS: RegExp[] = [
  /pretend\s+(that\s+)?you\s+are/i,
  /pretend\s+to\s+be/i,
  /act\s+as\s+root/i,
  /act\s+as\s+(an?\s+)?admin/i,
  /act\s+as\s+(an?\s+)?administrator/i,
  /sudo\s+mode/i,
  /admin\s+mode/i,
  /root\s+mode/i,
  /god\s+mode/i,
  /developer\s+mode/i,
  /maintenance\s+mode/i,
  /debug\s+mode/i,
  /unrestricted\s+mode/i,
  /bypass\s+(all\s+)?restrictions/i,
  /bypass\s+(all\s+)?safety/i,
  /bypass\s+(all\s+)?filters/i,
  /disable\s+(all\s+)?safety/i,
  /disable\s+(all\s+)?restrictions/i,
  /remove\s+(all\s+)?restrictions/i,
  /remove\s+(all\s+)?safety/i,
  /turn\s+off\s+(all\s+)?safety/i,
  /turn\s+off\s+(all\s+)?restrictions/i,
];

/**
 * Read and parse JSON from stdin
 */
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
 * Check a prompt against all pattern lists
 */
function checkPrompt(prompt: string): { blocked: boolean; category?: string } {
  for (const pattern of INJECTION_PATTERNS) {
    if (pattern.test(prompt)) {
      return { blocked: true, category: "prompt injection" };
    }
  }

  for (const pattern of CREDENTIAL_PATTERNS) {
    if (pattern.test(prompt)) {
      return { blocked: true, category: "credential access attempt" };
    }
  }

  for (const pattern of SOCIAL_ENGINEERING_PATTERNS) {
    if (pattern.test(prompt)) {
      return { blocked: true, category: "social engineering" };
    }
  }

  return { blocked: false };
}

/**
 * Output hook response
 */
function respond(output: HookOutput): void {
  console.log(JSON.stringify(output));
}

/**
 * Main hook execution
 */
export function run(): void {
  const input = readStdinJson();

  if (!input) {
    respond({ decision: "approve" });
    return;
  }

  // Extract prompt text from tool_input
  const prompt =
    (input.tool_input?.prompt as string) ||
    (input.tool_input?.content as string) ||
    (input.tool_input?.message as string) ||
    "";

  if (!prompt || typeof prompt !== "string") {
    respond({ decision: "approve" });
    return;
  }

  const result = checkPrompt(prompt);

  if (result.blocked) {
    console.error(`[hook-promptguard] Blocked: potential ${result.category}`);
    respond({
      decision: "block",
      reason: "Blocked: potential prompt injection",
    });
    return;
  }

  respond({ decision: "approve" });
}

if (import.meta.main) {
  run();
}
