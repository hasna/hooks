# CLAUDE.md

## hook-packageage

A PreToolUse hook that checks package age before npm/bun install commands.

### Key Files

| File | Purpose |
|------|---------|
| `src/hook.ts` | Main hook logic — extracts packages from commands, checks npm registry |
| `src/cli.ts` | CLI — install/uninstall/status/check |

### Hook Events

- **PreToolUse** (matcher: `Bash`)

### Behavior

- Parses npm/bun/yarn/pnpm install commands to extract package names
- Checks each package against npm registry for last publish date
- Warns on stale (>1yr), abandoned (>2yr), or deprecated packages
- Non-blocking — warns but always approves (packages may still be valid)
