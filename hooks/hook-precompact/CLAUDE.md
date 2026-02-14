# CLAUDE.md

## hook-precompact

A PreCompact hook that saves session state before context compaction.

### Key Files

| File | Purpose |
|------|---------|
| `src/hook.ts` | Main hook logic — captures git state, writes handoff files |
| `src/cli.ts` | CLI — install/uninstall/status/list/latest |

### Hook Events

- **PreCompact** — fires before context compaction

### Behavior

- Saves handoff files to `.claude-handoffs/` (auto-gitignored)
- Captures: session ID, git branch/status/recent commits, timestamp
- Maintains `latest.json` for quick access to most recent handoff
- Non-blocking — failures are logged but don't interrupt
