# hook-agent-rules-version-check

A SessionStart hook that verifies the rendered Hasna agent operating rules are current on this machine, warning the agent when they drift. Part of the Hasna fleet comms workflow.

## Installation

```bash
hooks install agent-rules-version-check
```

## How it works

On `SessionStart` it greps the rendered instruction artifacts for the managed-block sentinel:

```html
<!-- hasna:agent-operating-rules v=X.Y.Z ... -->
```

Default artifacts scanned (missing files are skipped silently):

- `~/.claude/CLAUDE.md` and `~/.claude/.hasna/instructions/*.md`
- `~/.codex/AGENTS.md`
- `~/.config/opencode/AGENTS.md`
- `~/.cursor/rules/hasna-global.mdc`

The expected version is resolved in order:

1. `HOOKS_RULES_EXPECTED_VERSION` env var (explicit pin)
2. the configs CLI stored copy: `configs show agent-operating-rules --format content` (bounded timeout, fail-open)
3. cross-artifact consistency — with no authoritative source, all rendered artifacts must agree

On mismatch it injects a WARNING via `hookSpecificOutput.additionalContext` telling the agent to re-sync before risky or fleet-affecting work. It never blocks the session, and it stays silent when no sentinel is rendered at all (distribution not yet rolled out on this machine).

## Configuration

```bash
export HOOKS_RULES_CHECK_DISABLE=1              # Kill switch — skip entirely
export HOOKS_RULES_EXPECTED_VERSION=1.2.0       # Explicit expected version
export HOOKS_RULES_CONFIG_SLUG=agent-operating-rules  # configs entry to consult
export HOOKS_RULES_FILES="/a.md:/b.md"          # Override scanned paths (colon-separated)
export HOOKS_FLEET_TIMEOUT_MS=500               # configs CLI timeout (default 500)
```

## Requirements

- `configs` CLI (@hasna/configs) — optional; without it the hook falls back to cross-artifact consistency checking

## Event

- **SessionStart**
