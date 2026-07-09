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
When Knowledge returns a nonempty context pack, the hook redacts credential-like
text from that pack and emits Codewith-native
`hookSpecificOutput.additionalContext` with the same event name. Citation-only
packs are expanded into progressive context lines with a bounded preview and a
`knowledge get --id ... --json` read hint so agents can decide which full items
are worth opening.

All failures are fail-open: missing CLI, timeout, nonzero exit, malformed JSON,
bad stdin, or empty packs return `{"continue":true}` without context.

## Configuration

```bash
export HOOKS_KNOWLEDGE_CONTEXT_DISABLE=1    # Kill switch
export HOOKS_KNOWLEDGE_COMMAND=knowledge    # CLI command/path
export HOOKS_KNOWLEDGE_TIMEOUT_MS=5000      # Per-call timeout
export HOOKS_KNOWLEDGE_MAX_ITEMS=6          # Context pack item budget
export HOOKS_KNOWLEDGE_MAX_TOKENS=1200      # Context pack token budget
export HOOKS_KNOWLEDGE_MAX_QUERY_CHARS=1200 # Redacted query bound
export HOOKS_KNOWLEDGE_MAX_OUTPUT_CHARS=8000
```

## Events

- `SessionStart`
- `UserPromptSubmit`
- `SubagentStart`
