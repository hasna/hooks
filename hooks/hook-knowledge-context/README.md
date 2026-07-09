# hook-knowledge-context

Codewith lifecycle hook that injects deterministic Knowledge context packs.

## Installation

```bash
hooks install knowledge-context --target codewith
```

By default this prints a Codewith TOML fragment and does not mutate managed
Codewith config. Apply that fragment through `open-configs` or the managed
config renderer. For explicit local testing only:

```bash
hooks install knowledge-context --target codewith --apply-codewith --codewith-config /tmp/codewith-config.toml
```

## How it works

On `SessionStart`, `UserPromptSubmit`, and `SubagentStart`, the hook builds a
small redacted query from the hook input and runs:

```bash
knowledge context pack <query> --from search --max-items <n> --max-tokens <n> --json
```

The hook intentionally does not pass `--semantic`, does not call web search,
does not call ask/build/generate flows, and does not crawl raw stores directly.
For `UserPromptSubmit`, the hook first applies a deterministic high-signal gate
so short acknowledgements and casual follow-ups do not inject Knowledge context.
When Knowledge returns a nonempty context pack, the hook redacts credential-like
text from that pack and emits Codewith-native
`hookSpecificOutput.additionalContext` with the same event name. Citation-only
packs are expanded into progressive context lines with bounded previews and a
single `knowledge get --id <item_id> --json` hint so agents can decide which
full items are worth opening.

Example injected context:

```text
[hook-knowledge-context] Knowledge matches (UserPromptSubmit; top 3, deterministic search):

If a match looks relevant, read it with: knowledge get --id <item_id> --json

- item_id=k_example cite=cite_123: Bounded preview text...
```

All failures are fail-open: missing CLI, timeout, nonzero exit, malformed JSON,
bad stdin, or empty packs return `{"continue":true}` without context.

## Configuration

```bash
export HOOKS_KNOWLEDGE_CONTEXT_DISABLE=1    # Kill switch
export HOOKS_KNOWLEDGE_COMMAND=knowledge    # CLI command/path
export HOOKS_KNOWLEDGE_TIMEOUT_MS=5000      # Per-call timeout
export HOOKS_KNOWLEDGE_MAX_ITEMS=3          # Context pack item budget
export HOOKS_KNOWLEDGE_MAX_TOKENS=1200      # Context pack token budget
export HOOKS_KNOWLEDGE_REQUIRE_HIGH_SIGNAL=1
export HOOKS_KNOWLEDGE_MIN_PROMPT_CHARS=6
export HOOKS_KNOWLEDGE_MIN_SIGNAL_SCORE=3
export HOOKS_KNOWLEDGE_MAX_QUERY_CHARS=1200 # Redacted query bound
export HOOKS_KNOWLEDGE_MAX_OUTPUT_CHARS=8000
```

All numeric env overrides are bounded. `HOOKS_KNOWLEDGE_COMMAND` accepts only a
single command/path token; unsafe values with whitespace fall back to
`knowledge`.

## Events

- `SessionStart`
- `UserPromptSubmit`
- `SubagentStart`
