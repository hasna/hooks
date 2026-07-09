import { describe, expect, test } from "bun:test";
import {
  buildHookOutput,
  buildKnowledgeArgs,
  buildQuery,
  extractContextText,
  getConfig,
  promptSignalScore,
  redactSecrets,
  sanitizeQuery,
  type KnowledgeContextConfig,
  type KnowledgeExecutor,
} from "./hook";

const baseConfig: KnowledgeContextConfig = {
  command: "knowledge",
  timeoutMs: 5000,
  maxItems: 3,
  maxTokens: 1200,
  minPromptChars: 6,
  minSignalScore: 3,
  maxQueryChars: 1200,
  maxOutputChars: 8000,
  requireHighSignal: true,
};

describe("hook-knowledge-context", () => {
  test("defaults Knowledge CLI timeout to 5000ms and keeps env override", () => {
    expect(getConfig({}).timeoutMs).toBe(5000);
    expect(getConfig({}).maxItems).toBe(3);
    expect(getConfig({}).minPromptChars).toBe(6);
    expect(getConfig({}).minSignalScore).toBe(3);
    expect(getConfig({}).requireHighSignal).toBe(true);
    expect(getConfig({ HOOKS_KNOWLEDGE_TIMEOUT_MS: "2345" }).timeoutMs).toBe(2345);
    expect(getConfig({ HOOKS_KNOWLEDGE_REQUIRE_HIGH_SIGNAL: "0" }).requireHighSignal).toBe(false);
  });

  test("applies bounded env overrides and rejects unsafe command override", () => {
    const config = getConfig({
      HOOKS_KNOWLEDGE_COMMAND: "/tmp/knowledge",
      HOOKS_KNOWLEDGE_MAX_ITEMS: "9",
      HOOKS_KNOWLEDGE_MAX_TOKENS: "2345",
      HOOKS_KNOWLEDGE_MIN_PROMPT_CHARS: "12",
      HOOKS_KNOWLEDGE_MIN_SIGNAL_SCORE: "4",
      HOOKS_KNOWLEDGE_MAX_QUERY_CHARS: "200",
      HOOKS_KNOWLEDGE_MAX_OUTPUT_CHARS: "9999",
    });

    expect(config.command).toBe("/tmp/knowledge");
    expect(config.maxItems).toBe(9);
    expect(config.maxTokens).toBe(2345);
    expect(config.minPromptChars).toBe(12);
    expect(config.minSignalScore).toBe(4);
    expect(config.maxQueryChars).toBe(200);
    expect(config.maxOutputChars).toBe(9999);
    expect(buildKnowledgeArgs("q", config)).toContain("9");
    expect(getConfig({ HOOKS_KNOWLEDGE_COMMAND: "bad command" }).command).toBe("knowledge");
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
      "3",
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
    expect(output.hookSpecificOutput?.additionalContext).toContain("Knowledge matches");
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
        prompt: "implement the knowledge hook context output with token=demo",
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

  test("fails open for low-signal UserPromptSubmit prompts before calling Knowledge", async () => {
    let executorCalls = 0;
    const executor: KnowledgeExecutor = async () => {
      executorCalls += 1;
      throw new Error("executor should not run for low-signal prompts");
    };

    for (const prompt of ["", "ok", "thanks", "?", "continue", "tell me again"]) {
      expect(
        await buildHookOutput({ hook_event_name: "UserPromptSubmit", cwd: "/repo", prompt }, executor)
      ).toEqual({ continue: true });
    }
    expect(executorCalls).toBe(0);
    for (const prompt of [
      "fix authz",
      "release",
      "publish npm",
      "check src/hook.ts",
      "@hasna/hooks",
      "merge PR 12",
      "review staged diff",
      "rerun tests",
    ]) {
      expect(promptSignalScore(prompt, "/home/hasna/workspace/hasna/opensource/open-hooks")).toBeGreaterThanOrEqual(3);
    }
  });

  test("can opt out of high-signal gating for UserPromptSubmit", async () => {
    const output = await buildHookOutput(
      { hook_event_name: "UserPromptSubmit", cwd: "/repo", prompt: "ok" },
      async () => ({
        ok: true,
        stdout: JSON.stringify({ context: "Forced low-signal context." }),
      }),
      { HOOKS_KNOWLEDGE_REQUIRE_HIGH_SIGNAL: "0" }
    );

    expect(output.hookSpecificOutput?.additionalContext).toContain("Forced low-signal context");
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

  test("formats citation-only packs as item_id/cite bullets with one read hint", () => {
    const text = extractContextText({
      citations: [
        {
          id: "cite_1",
          source_ref: "knowledge://item/k_one",
          quote_preview: "First preview that tells the agent why this Knowledge item might matter.",
        },
        {
          id: "cite_2",
          source_ref: "knowledge://item/k_two",
          quote_preview: "Second preview that tells the agent why this Knowledge item might matter.",
        },
      ],
    });

    expect(text).toContain("If a match looks relevant, read it with: knowledge get --id <item_id> --json");
    expect(text?.match(/knowledge get --id/g) ?? []).toHaveLength(1);
    expect(text).toContain("- item_id=k_one cite=cite_1: First preview");
    expect(text).toContain("- item_id=k_two cite=cite_2: Second preview");
    expect(text).not.toContain("open: knowledge get --id k_one --json");
    expect(text).not.toContain("(cite_1)");
    expect(text).not.toContain("source: knowledge://item/k_one");
  });

  test("extracts item_id from legacy Knowledge source paths", () => {
    const text = extractContextText({
      citations: [
        {
          id: "cite_abc",
          source_ref: "open-files://source/legacy-json/path/k_mqyrz7gt_olq82e",
          quote_preview: "Legacy file source preview.",
        },
      ],
    });

    expect(text).toContain("item_id=k_mqyrz7gt_olq82e");
    expect(text).toContain("cite=cite_abc");
    expect(text).not.toContain("source=open-files://source/legacy-json/path/k_mqyrz7gt_olq82e");
  });

  test("keeps source fallback for non-Knowledge citations without item ids", () => {
    const text = extractContextText({
      citations: [
        {
          id: "cite_url",
          source_ref: "https://example.test/doc",
          quote_preview: "External preview.",
        },
      ],
    });

    expect(text).toContain("- cite=cite_url source=https://example.test/doc: External preview.");
    expect(text).not.toContain("item_id=");
    expect(text).not.toContain("knowledge get --id");
  });

  test("cleans legacy empty-title bullet artifacts in item text", () => {
    expect(extractContextText(["- : legacy empty title preview"])).toBe("- legacy empty title preview");
    expect(extractContextText("- : legacy direct context")).toBe("- legacy direct context");
  });
});
