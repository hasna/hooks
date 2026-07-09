#!/usr/bin/env bun

/**
 * Codewith Hook: knowledge-context
 *
 * Deterministically injects bounded Knowledge context into Codewith lifecycle
 * events. This hook never calls LLM providers, semantic search, web search, or
 * raw stores directly; it delegates to `knowledge context pack --from search`.
 */

import { readFileSync } from "fs";
import { spawn } from "child_process";

export type KnowledgeContextEvent = "SessionStart" | "UserPromptSubmit" | "SubagentStart";

interface HookInput {
  session_id?: string;
  cwd?: string;
  hook_event_name?: string;
  model?: string;
  permission_mode?: string;
  source?: string;
  prompt?: string;
  user_prompt?: string;
  agent_id?: string;
  agent_type?: string;
  turn_id?: string;
}

interface HookOutput {
  continue: boolean;
  hookSpecificOutput?: {
    hookEventName: KnowledgeContextEvent;
    additionalContext: string;
  };
}

export interface KnowledgeContextConfig {
  command: string;
  timeoutMs: number;
  maxItems: number;
  maxTokens: number;
  maxQueryChars: number;
  maxOutputChars: number;
}

export interface KnowledgeExecResult {
  ok: boolean;
  stdout?: string;
  timedOut?: boolean;
}

export type KnowledgeExecutor = (
  query: string,
  config: KnowledgeContextConfig
) => Promise<KnowledgeExecResult>;

const DEFAULT_TIMEOUT_MS = 5000;
const DEFAULT_MAX_ITEMS = 3;
const DEFAULT_MAX_TOKENS = 1200;
const DEFAULT_MAX_QUERY_CHARS = 1200;
const DEFAULT_MAX_OUTPUT_CHARS = 8000;
const SUPPORTED_EVENTS = new Set<KnowledgeContextEvent>([
  "SessionStart",
  "UserPromptSubmit",
  "SubagentStart",
]);

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

function boundedNumber(raw: string | undefined, fallback: number, min: number, max: number): number {
  const value = Number(raw);
  if (!Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(value)));
}

function commandFromEnv(raw: string | undefined): string {
  if (raw && /^[^\s\0]+$/.test(raw)) return raw;
  return "knowledge";
}

export function getConfig(env: NodeJS.ProcessEnv = process.env): KnowledgeContextConfig {
  return {
    command: commandFromEnv(env.HOOKS_KNOWLEDGE_COMMAND),
    timeoutMs: boundedNumber(env.HOOKS_KNOWLEDGE_TIMEOUT_MS, DEFAULT_TIMEOUT_MS, 100, 10_000),
    maxItems: boundedNumber(env.HOOKS_KNOWLEDGE_MAX_ITEMS, DEFAULT_MAX_ITEMS, 1, 20),
    maxTokens: boundedNumber(env.HOOKS_KNOWLEDGE_MAX_TOKENS, DEFAULT_MAX_TOKENS, 100, 8_000),
    maxQueryChars: boundedNumber(env.HOOKS_KNOWLEDGE_MAX_QUERY_CHARS, DEFAULT_MAX_QUERY_CHARS, 80, 4_000),
    maxOutputChars: boundedNumber(env.HOOKS_KNOWLEDGE_MAX_OUTPUT_CHARS, DEFAULT_MAX_OUTPUT_CHARS, 500, 20_000),
  };
}

export function isKnowledgeContextEvent(value: string | undefined): value is KnowledgeContextEvent {
  return SUPPORTED_EVENTS.has(value as KnowledgeContextEvent);
}

function stringField(input: HookInput, key: keyof HookInput): string {
  const value = input[key];
  return typeof value === "string" ? value : "";
}

export function redactSecrets(text: string): string {
  let redacted = text;
  redacted = redacted.replace(
    /\b(api[_-]?key|token|secret|password|passwd|pwd)\b\s*[:=]\s*[^,\s]+/gi,
    (_match, key: string) => `${key}=<redacted>`
  );
  redacted = redacted.replace(/\bsk-[A-Za-z0-9_-]{16,}\b/g, "<redacted>");
  redacted = redacted.replace(/\bgh[pousr]_[A-Za-z0-9_]{20,}\b/g, "<redacted>");
  redacted = redacted.replace(/\bxox[baprs]-[A-Za-z0-9-]{20,}\b/g, "<redacted>");
  redacted = redacted.replace(/\bAKIA[0-9A-Z]{16}\b/g, "<redacted>");
  redacted = redacted.replace(/\bAIza[0-9A-Za-z_-]{20,}\b/g, "<redacted>");
  redacted = redacted.replace(/\b[A-Za-z0-9+/]{48,}={0,2}\b/g, "<redacted>");
  return redacted;
}

export function sanitizeQuery(text: string, maxChars: number): string {
  const normalized = text
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  const redacted = redactSecrets(normalized);
  return redacted.length > maxChars ? redacted.slice(0, maxChars).trim() : redacted;
}

export function buildQuery(input: HookInput, config: KnowledgeContextConfig): string | null {
  const cwd = stringField(input, "cwd");
  const event = stringField(input, "hook_event_name");

  if (event === "UserPromptSubmit") {
    const prompt = stringField(input, "prompt") || stringField(input, "user_prompt");
    return sanitizeQuery(`Codewith user prompt context. cwd: ${cwd}. prompt: ${prompt}`, config.maxQueryChars);
  }

  if (event === "SubagentStart") {
    const agentType = stringField(input, "agent_type") || "subagent";
    const turnId = stringField(input, "turn_id");
    return sanitizeQuery(
      `Codewith subagent start context. cwd: ${cwd}. agent type: ${agentType}. turn: ${turnId}`,
      config.maxQueryChars
    );
  }

  if (event === "SessionStart") {
    const source = stringField(input, "source") || "startup";
    const model = stringField(input, "model");
    return sanitizeQuery(`Codewith session start context. cwd: ${cwd}. source: ${source}. model: ${model}`, config.maxQueryChars);
  }

  return null;
}

export function buildKnowledgeArgs(query: string, config: KnowledgeContextConfig): string[] {
  return [
    "context",
    "pack",
    query,
    "--from",
    "search",
    "--max-items",
    String(config.maxItems),
    "--max-tokens",
    String(config.maxTokens),
    "--json",
  ];
}

export function spawnKnowledgeContextPack(query: string, config: KnowledgeContextConfig): Promise<KnowledgeExecResult> {
  const args = buildKnowledgeArgs(query, config);

  return new Promise((resolve) => {
    let stdout = "";
    let settled = false;
    let timedOut = false;
    let timer: ReturnType<typeof setTimeout>;

    const settle = (result: KnowledgeExecResult): void => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve(result);
    };

    const child = spawn(config.command, args, {
      stdio: ["ignore", "pipe", "ignore"],
      env: process.env,
    });

    timer = setTimeout(() => {
      timedOut = true;
      try {
        child.kill("SIGTERM");
      } catch {
        // ignore kill errors; close/error will settle
      }
    }, config.timeoutMs);

    child.stdout.setEncoding("utf-8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
      if (stdout.length > config.maxOutputChars * 2) {
        stdout = stdout.slice(0, config.maxOutputChars * 2);
      }
    });
    child.on("error", () => settle({ ok: false, timedOut }));
    child.on("close", (code) => settle({ ok: code === 0 && !timedOut, stdout, timedOut }));
  });
}

function firstString(obj: Record<string, unknown>, keys: string[]): string | null {
  for (const key of keys) {
    const value = obj[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return null;
}

function firstSourceString(obj: Record<string, unknown>): string | null {
  const direct = firstString(obj, ["source_ref", "source_uri", "source", "uri", "ref", "url", "citation"]);
  if (direct) return direct;

  const source = obj.source;
  if (source && typeof source === "object") {
    return firstString(source as Record<string, unknown>, ["uri", "ref", "url", "id"]);
  }

  return null;
}

function firstArray(obj: Record<string, unknown>, keys: string[]): unknown[] | null {
  for (const key of keys) {
    const value = obj[key];
    if (Array.isArray(value)) return value;
  }
  return null;
}

export function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  if (max <= 3) return text.slice(0, max);
  return `${text.slice(0, max - 3)}...`;
}

function compactText(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function knowledgeItemId(source: string | null): string | null {
  const match = source?.match(/^knowledge:\/\/item\/([^/?#\s]+)$/);
  return match?.[1] ?? null;
}

function formatPackItems(items: unknown[]): string | null {
  const lines: string[] = [];

  for (const [index, item] of items.entries()) {
    if (typeof item === "string" && item.trim()) {
      lines.push(`- ${truncate(item.trim(), 900)}`);
      continue;
    }
    if (!item || typeof item !== "object") continue;

    const obj = item as Record<string, unknown>;
    const citationId = firstString(obj, ["id", "citation_id", "citationId"]);
    const source = firstSourceString(obj);
    const itemId = knowledgeItemId(source);
    const title =
      firstString(obj, ["title", "name"]) ||
      itemId ||
      citationId ||
      `item ${index + 1}`;
    const body = firstString(obj, [
      "summary",
      "text",
      "content",
      "snippet",
      "preview",
      "quote_preview",
      "quotePreview",
      "excerpt",
      "body",
      "description",
    ]);
    if (!body && !source) continue;

    const suffixParts = [
      citationId && citationId !== title ? citationId : null,
      source && !itemId ? `source: ${truncate(source, 180)}` : null,
    ].filter(Boolean);
    const suffix = suffixParts.length > 0 ? ` (${suffixParts.join("; ")})` : "";
    lines.push(`- ${truncate(title, 160)}${suffix}${body ? `: ${truncate(compactText(body), 520)}` : ""}`);
    if (itemId) {
      lines.push(`  open: knowledge get --id ${itemId} --json`);
    }
  }

  return lines.length > 0 ? lines.join("\n") : null;
}

export function extractContextText(pack: unknown): string | null {
  if (typeof pack === "string") {
    return pack.trim() || null;
  }
  if (Array.isArray(pack)) {
    return formatPackItems(pack);
  }
  if (!pack || typeof pack !== "object") {
    return null;
  }

  const obj = pack as Record<string, unknown>;
  const direct = firstString(obj, ["additionalContext", "context", "markdown", "content", "text", "summary"]);
  if (direct) return direct;

  for (const key of ["pack", "contextPack", "context_pack", "data", "result"]) {
    const nested = obj[key];
    const text = extractContextText(nested);
    if (text) return text;
  }

  const items = firstArray(obj, ["items", "results", "sources", "citations"]);
  return items ? formatPackItems(items) : null;
}

export function formatAdditionalContext(
  event: KnowledgeContextEvent,
  context: string,
  config: KnowledgeContextConfig
): string {
  const header = `[hook-knowledge-context] Deterministic Knowledge context (${event}; knowledge context pack --from search):`;
  const safeContext = redactSecrets(context.trim());
  return `${header}\n\n${truncate(safeContext, Math.max(0, config.maxOutputChars - header.length - 2))}`;
}

export async function buildHookOutput(
  input: HookInput | null,
  executor: KnowledgeExecutor = spawnKnowledgeContextPack,
  env: NodeJS.ProcessEnv = process.env
): Promise<HookOutput> {
  if (env.HOOKS_KNOWLEDGE_CONTEXT_DISABLE === "1") {
    return { continue: true };
  }

  if (!input) {
    return { continue: true };
  }

  const event = input.hook_event_name;
  if (!isKnowledgeContextEvent(event)) {
    return { continue: true };
  }

  const config = getConfig(env);
  const query = buildQuery(input, config);
  if (!query) {
    return { continue: true };
  }

  try {
    const result = await executor(query, config);
    if (!result.ok || !result.stdout) {
      return { continue: true };
    }

    const parsed = JSON.parse(result.stdout);
    const context = extractContextText(parsed);
    if (!context) {
      return { continue: true };
    }

    return {
      continue: true,
      hookSpecificOutput: {
        hookEventName: event,
        additionalContext: formatAdditionalContext(event, context, config),
      },
    };
  } catch {
    return { continue: true };
  }
}

export async function run(): Promise<void> {
  respond(await buildHookOutput(readStdinJson()));
}

if (import.meta.main) {
  void run();
}
