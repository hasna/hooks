# hook-autostage

Claude Code hook that automatically stages files after Claude edits or writes them.

## Event

**PostToolUse** (matcher: `Edit|Write`)

## What It Does

After Claude modifies a file via `Edit` or `Write`, this hook automatically runs `git add <file>` to stage the change. This keeps your git staging area in sync with Claude's edits without manual intervention.

### Safety Checks

Before staging, the hook verifies:

1. **Git repo exists** — checks that `cwd` is inside a git repository
2. **File exists** — confirms the file was actually created/modified
3. **Not gitignored** — runs `git check-ignore` to skip ignored files

### What Gets Staged

- Files modified by Claude's `Edit` tool
- Files created/written by Claude's `Write` tool

### What Does NOT Get Staged

- Files in `.gitignore` (e.g., `node_modules/`, `.env`, `dist/`)
- Files outside git repositories
- Files from other tools (Bash, Read, etc.)

## Installation

Add to your `.claude/settings.json`:

```json
{
  "hooks": {
    "PostToolUse": [
      {
        "matcher": "Edit|Write",
        "hooks": [
          {
            "type": "command",
            "command": "bun run hooks/hook-autostage/src/hook.ts"
          }
        ]
      }
    ]
  }
}
```

## Output

Always `{ "continue": true }` — this hook never blocks.

## Logs

Activity is logged to stderr:

```
[hook-autostage] Staged: src/index.ts
[hook-autostage] File is gitignored, skipping: dist/bundle.js
[hook-autostage] Not a git repo, skipping
```

## License

MIT
