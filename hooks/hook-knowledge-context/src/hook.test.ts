import { describe, expect, test } from "bun:test";
import {
  buildHookOutput,
  buildKnowledgeArgs,
  buildQuery,
  extractContextText,
  getConfig,
  redactSecrets,
  sanitizeQuery,
  type KnowledgeContextConfig,
  type KnowledgeExecutor,
} from "./hook";

const baseConfig: KnowledgeContextConfig = {
  command: "knowledge",
  timeoutMs: 5000,
  maxItems: 6,
  maxTokens: 1200,
  maxQueryChars: 1200,
  maxOutputChars: 8000,
};

describe("hook-knowledge-context", () => {
  test("defaults Knowledge CLI timeout to 5000ms and keeps env override", () => {
    expect(getConfig({}).timeoutMs).toBe(5000);
    expect(getConfig({ HOOKS_KNOWLEDGE_TIMEOUT_MS: "2345" }).timeoutMs).toBe(2345);
  });

  test("builds deterministic knowledge context pack args without semantic, web, or generation flags", () => {
    const args = buildKnowledgeArgs("repo hook context", baseConfig);

    expect(args).toEqual([
      "context",
      "pack",
      "repo hook context",
      "--from",
      "search",
      "--max-items",
      "6",
      "--max-tokens",
      "1200",
      "--json",
    ]);
    expect(args).not.toContain("--semantic");
    expect(args).not.toContain("--generate");
    expect(args).not.toContain("web");
    expect(args).not.toContain("ask");
    expect(args).not.toContain("build");
  });

  test("emits Codewith additionalContext for SessionStart", async () => {
    const executor: KnowledgeExecutor = async () => ({
      ok: true,
      stdout: JSON.stringify({ context: "Use hooks.json for Codewith lifecycle hooks." }),
    });

    const output = await buildHookOutput(
      {
        hook_event_name: "SessionStart",
        cwd: "/repo",
        source: "startup",
        model: "gpt-test",
      },
      executor
    );

    expect(output.continue).toBe(true);
    expect(output.hookSpecificOutput?.hookEventName).toBe("SessionStart");
    expect(output.hookSpecificOutput?.additionalContext).toContain("knowledge context pack --from search");
    expect(output.hookSpecificOutput?.additionalContext).toContain("Use hooks.json");
  });

  test("emits event-matched additionalContext for UserPromptSubmit and redacts query secrets", async () => {
    let capturedQuery = "";
    const executor: KnowledgeExecutor = async (query) => {
      capturedQuery = query;
      return {
        ok: true,
        stdout: JSON.stringify({
          items: [{ title: "Decision", text: "Prefer deterministic context packs. secret=demo" }],
        }),
      };
    };

    const output = await buildHookOutput(
      {
        hook_event_name: "UserPromptSubmit",
        cwd: "/repo",
        prompt: "implement this with token=demo",
      },
      executor
    );

    expect(output.hookSpecificOutput?.hookEventName).toBe("UserPromptSubmit");
    expect(output.hookSpecificOutput?.additionalContext).toContain("Prefer deterministic context packs");
    expect(output.hookSpecificOutput?.additionalContext).toContain("secret=<redacted>");
    expect(output.hookSpecificOutput?.additionalContext).not.toContain("secret=demo");
    expect(capturedQuery).toContain("token=<redacted>");
    expect(capturedQuery).not.toContain("token=demo");
  });

  test("emits event-matched additionalContext for SubagentStart", async () => {
    const executor: KnowledgeExecutor = async () => ({
      ok: true,
      stdout: JSON.stringify({ data: { markdown: "Subagents inherit parent scope and should stay bounded." } }),
    });

    const output = await buildHookOutput(
      {
        hook_event_name: "SubagentStart",
        cwd: "/repo",
        agent_type: "verifier",
        turn_id: "turn-1",
      },
      executor
    );

    expect(output.hookSpecificOutput?.hookEventName).toBe("SubagentStart");
    expect(output.hookSpecificOutput?.additionalContext).toContain("Subagents inherit parent scope");
  });

  test("fails open without context on executor error, timeout, or invalid JSON", async () => {
    const failed = await buildHookOutput({ hook_event_name: "SessionStart", cwd: "/repo" }, async () => ({ ok: false }));
    const timedOut = await buildHookOutput(
      { hook_event_name: "SessionStart", cwd: "/repo" },
      async () => ({ ok: false, timedOut: true })
    );
    const invalidJson = await buildHookOutput(
      { hook_event_name: "SessionStart", cwd: "/repo" },
      async () => ({ ok: true, stdout: "not json" })
    );

    expect(failed).toEqual({ continue: true });
    expect(timedOut).toEqual({ continue: true });
    expect(invalidJson).toEqual({ continue: true });
  });

  test("fails open for disabled or unsupported events", async () => {
    const executor: KnowledgeExecutor = async () => {
      throw new Error("executor should not run");
    };

    expect(
      await buildHookOutput({ hook_event_name: "PostToolUse", cwd: "/repo" }, executor)
    ).toEqual({ continue: true });
    expect(
      await buildHookOutput({ hook_event_name: "SessionStart", cwd: "/repo" }, executor, {
        HOOKS_KNOWLEDGE_CONTEXT_DISABLE: "1",
      })
    ).toEqual({ continue: true });
  });

  test("sanitizes and bounds queries", () => {
    expect(redactSecrets("password=hunter2 token=demo")).toBe(
      "password=<redacted> token=<redacted>"
    );
    expect(sanitizeQuery("a\nb\tc", 100)).toBe("a b c");
    expect(sanitizeQuery("word ".repeat(200), 20).length).toBeLessThanOrEqual(20);
  });

  test("builds event-specific queries and extracts common context pack shapes", () => {
    const config = getConfig({});

    expect(buildQuery({ hook_event_name: "SessionStart", cwd: "/repo", source: "resume" }, config)).toContain(
      "session start"
    );
    expect(buildQuery({ hook_event_name: "SubagentStart", cwd: "/repo", agent_type: "reviewer" }, config)).toContain(
      "subagent start"
    );
    expect(extractContextText({ pack: { context: "direct context" } })).toBe("direct context");
    expect(extractContextText([{ title: "One", text: "Body", uri: "knowledge://item/one" }])).toContain("Body");
  });

  test("formats citation previews as useful progressive blurbs with read commands", () => {
    const text = extractContextText({
      citations: [
        {
          id: "cite_123",
          source_ref: "knowledge://item/k_example",
          quote_preview: "A short preview that tells the agent why this Knowledge item might matter.",
        },
      ],
    });

    expect(text).toContain("Knowledge item k_example");
    expect(text).toContain("cite_123");
    expect(text).toContain("A short preview");
    expect(text).toContain("read: knowledge get --id k_example --json");
  });
});
