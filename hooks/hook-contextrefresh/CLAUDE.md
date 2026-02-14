# CLAUDE.md

## hook-contextrefresh

A UserPromptSubmit hook that re-injects important context every N prompts.

### Key Files

| File | Purpose |
|------|---------|
| `src/hook.ts` | Main hook logic — tracks prompt count, injects context |
| `src/cli.ts` | CLI — install/uninstall/status |

### Hook Events

- **UserPromptSubmit** — fires before Claude processes each user prompt

### Behavior

- Tracks prompt count per session in temp files
- Every N prompts, reads `.claude-context` from project root
- Prepends context to user's prompt as a refresh
- Configurable interval and context file path
