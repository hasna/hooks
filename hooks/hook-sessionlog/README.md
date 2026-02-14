# hook-sessionlog

Claude Code hook that logs every tool call to a session log file.

## Overview

Every time Claude calls any tool, this hook appends a JSON line to `.claude/session-log-<date>.jsonl` in the project directory. Useful for auditing, debugging, and understanding what Claude did during a session.

## Event

- **PostToolUse** (matches all tools)

## Log Format

Each line in the `.jsonl` file is a JSON object:

```json
{
  "timestamp": "2026-02-14T10:30:00.000Z",
  "tool_name": "Edit",
  "tool_input": "{\"file_path\":\"src/index.ts\",\"old_string\":\"...\",\"new_string\":\"...\"}",
  "session_id": "abc123"
}
```

- `tool_input` is truncated to 500 characters to keep log files manageable
- One file per day: `.claude/session-log-2026-02-14.jsonl`

## Behavior

- Creates `.claude/` directory if it does not exist
- Appends to the log file (never overwrites)
- Non-blocking: logging failures are logged to stderr but never interrupt Claude
- Outputs `{ "continue": true }` always

## Log Location

```
<project-root>/
└── .claude/
    ├── session-log-2026-02-14.jsonl
    ├── session-log-2026-02-15.jsonl
    └── ...
```

## License

MIT
