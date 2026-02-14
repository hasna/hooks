# hook-commandlog

Claude Code hook that logs every bash command Claude runs to a log file.

## Overview

Every time Claude executes a Bash command, this hook appends it to `.claude/commands.log` in the project directory. Provides a clear audit trail of all shell commands run during a session.

## Event

- **PostToolUse** (matcher: `Bash`)

## Log Format

Each line in the log file:

```
[2026-02-14T10:30:00.000Z] exit=0 npm install express
[2026-02-14T10:30:05.000Z] exit=0 git status
[2026-02-14T10:30:10.000Z] ls -la src/
```

- ISO 8601 timestamp in brackets
- Exit code (if available in tool input)
- The full command string

## Behavior

- Only logs `Bash` tool calls (other tools are ignored)
- Creates `.claude/` directory if it does not exist
- Appends to the log file (never overwrites)
- Non-blocking: logging failures are logged to stderr but never interrupt Claude
- Outputs `{ "continue": true }` always

## Log Location

```
<project-root>/
└── .claude/
    └── commands.log
```

## License

MIT
