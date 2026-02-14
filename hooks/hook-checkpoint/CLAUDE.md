# CLAUDE.md

## hook-checkpoint

A PreToolUse hook that creates shadow git snapshots before file modifications.

### Key Files

| File | Purpose |
|------|---------|
| `src/hook.ts` | Main hook logic — reads stdin, creates checkpoints |
| `src/cli.ts` | CLI — install/uninstall/status/list/restore |

### Hook Events

- **PreToolUse** (matcher: `Write|Edit|NotebookEdit`)

### Behavior

- Creates `.claude-checkpoints/` shadow git repo in project root
- Copies original files before modification and commits them
- Never blocks operations — checkpoint failures are logged but ignored
- Auto-adds `.claude-checkpoints/` to `.gitignore`
