# hook-errornotify

Claude Code hook that detects tool failures and logs errors for tracking.

## Event

**PostToolUse** — fires after any tool execution completes.

## What It Does

Inspects tool output for error indicators and provides two layers of notification:

1. **stderr warnings** — immediate visibility in the terminal
2. **`.claude/errors.log`** — persistent error log file for later review

### Error Detection

The hook checks for:

- Non-zero exit codes (`exit_code`, `exitCode`, `code` fields)
- Explicit `error` field in output
- Error patterns in output text:
  - `error:`, `fatal:`, `panic:`
  - `command not found`, `permission denied`, `no such file or directory`
  - `ENOENT`, `EACCES`, `EPERM`, `ENOMEM`
  - Python/JS/Go exceptions (`TypeError`, `ImportError`, `FileNotFoundError`, etc.)
  - Python tracebacks

## Installation

Add to your `.claude/settings.json`:

```json
{
  "hooks": {
    "PostToolUse": [
      {
        "matcher": "",
        "hooks": [
          {
            "type": "command",
            "command": "bun run hooks/hook-errornotify/src/hook.ts"
          }
        ]
      }
    ]
  }
}
```

## Output

Always `{ "continue": true }` — this hook never blocks. It only observes and logs.

## Error Log Format

Errors are written to `.claude/errors.log`:

```
[2026-02-14T10:30:00.000Z] [session:abc12345] Bash: npm test — Exit code 1: Tests failed
[2026-02-14T10:31:00.000Z] [session:abc12345] Write: src/index.ts — Error: EACCES permission denied
```

## License

Apache-2.0
