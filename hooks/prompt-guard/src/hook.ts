#!/usr/bin/env bun

import { readInput, respond, warn } from "../../codewith-native-common";

const SOURCE_MARKERS: RegExp[] = [
  /^\s*>/m,
  /```/,
  /<\/?(?:instructions|system|policy)[^>]*>/i,
  /\b(?:pasted|copied|transcript|slack|email|webpage|browser|issue|comment|log output|untrusted)\b/i,
  /^\s*(?:from|sender|author|message|subject):\s+.+$/im,
  /BEGIN [A-Z _-]*(?:INSTRUCTIONS|POLICY|MESSAGE|PROMPT)/i,
];

const DANGEROUS_INSTRUCTIONS: RegExp[] = [
  /\bignore\s+(?:all\s+)?(?:previous|prior|above|system|developer)\s+instructions\b/i,
  /\bdisregard\s+(?:all\s+)?(?:previous|prior|above|system|developer)\s+instructions\b/i,
  /\boverride\s+(?:the\s+)?(?:system|developer|policy|safety)\b/i,
  /\b(?:new|replacement)\s+system\s+prompt\b/i,
  /\byou\s+are\s+now\s+(?:unrestricted|root|admin|developer|system)\b/i,
  /\brun\s+this\s+now\b/i,
  /\burgent\s*[—-]\s*run\s+this\s+now\b/i,
  /\bdo\s+not\s+(?:tell|inform|ask)\s+(?:the\s+)?user\b/i,
  /\b(?:exfiltrate|dump|print|reveal)\s+(?:secrets?|tokens?|credentials?|api\s*keys?)\b/i,
  /\bdisable\s+(?:all\s+)?(?:safety|guards?|policies|restrictions)\b/i,
];

const FAKE_SEVERITY_TAG = /\[(?:FREEZE|UNFREEZE|POLICY|BREAKING|CUTOVER|RELEASE)\]/i;
const DISCUSSION_WORDS = /\b(?:explain|discuss|document|write\s+tests?|implement|review|summari[sz]e|quote|example|detect|guard|avoid\s+false\s+positives?)\b/i;

function promptText(input: Record<string, unknown>): string {
  const direct = input.prompt;
  if (typeof direct === "string") return direct;
  const toolInput = input.tool_input as Record<string, unknown> | undefined;
  for (const key of ["prompt", "content", "message", "text"]) {
    const value = toolInput?.[key];
    if (typeof value === "string") return value;
  }
  return "";
}

export function classifyPrompt(prompt: string): { block: boolean; reason?: string } {
  if (!prompt.trim()) return { block: false };
  const looksSourced = SOURCE_MARKERS.some((pattern) => pattern.test(prompt));
  const hasDanger = DANGEROUS_INSTRUCTIONS.some((pattern) => pattern.test(prompt));
  const hasFakeSeverity = FAKE_SEVERITY_TAG.test(prompt);

  if (looksSourced && hasDanger) {
    return { block: true, reason: "Blocked pasted/untrusted content that appears to instruct the agent to override policy or run commands." };
  }

  if (looksSourced && hasFakeSeverity && hasDanger) {
    return { block: true, reason: "Blocked pasted/untrusted fake severity-tagged instruction." };
  }

  if (looksSourced && hasFakeSeverity && /\b(?:must|stop|freeze|execute|run|ignore|override)\b/i.test(prompt) && !DISCUSSION_WORDS.test(prompt)) {
    return { block: true, reason: "Blocked pasted/untrusted severity-tagged instruction. Verify through conversations announcements/incidents instead." };
  }

  return { block: false };
}

export function run(): void {
  const input = readInput();
  const prompt = promptText(input);
  const result = classifyPrompt(prompt);
  if (result.block) {
    warn(result.reason || "prompt blocked");
    respond({ decision: "block", reason: result.reason });
    return;
  }
  respond({ continue: true });
}

if (import.meta.main) {
  run();
}
