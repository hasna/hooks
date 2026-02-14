# CLAUDE.md

## hook-gitguard

A PreToolUse hook that blocks destructive git operations.

### Key Files

| File | Purpose |
|------|---------|
| `src/hook.ts` | Main hook logic — pattern matching against dangerous git commands |
| `src/cli.ts` | CLI — install/uninstall/status/test |

### Hook Events

- **PreToolUse** (matcher: `Bash`)

### Behavior

- Checks Bash commands for destructive git patterns
- Blocks: reset --hard, push --force, checkout ., clean -f, branch -D, stash drop/clear
- Approves all non-git commands immediately
