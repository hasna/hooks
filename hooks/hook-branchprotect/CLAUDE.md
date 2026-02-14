# CLAUDE.md

## hook-branchprotect

A PreToolUse hook that prevents file modifications on protected branches (main/master).

### Key Files

| File | Purpose |
|------|---------|
| `src/hook.ts` | Main hook logic — checks current branch, blocks on main/master |
| `src/cli.ts` | CLI — install/uninstall/status |

### Hook Events

- **PreToolUse** (matcher: `Write|Edit|NotebookEdit`)

### Behavior

- Checks current git branch before allowing file modifications
- Blocks Write/Edit/NotebookEdit on main/master branches
- Suggests creating a feature branch in the block message
- Approves everything on non-protected branches or non-git directories
