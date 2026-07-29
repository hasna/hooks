# hook-spiral-detector

A PostToolUse hook that interrupts Claude Code after five consecutive Bash calls produce the same command, non-zero exit status, and first line of stderr.

## Installation

```bash
hooks install spiral-detector
```

## Behavior

- Hashes the command and error signature; command text and stderr are not persisted
- Keeps streaks separate by session
- Resets the streak after a success, a different failure, or a non-Bash tool call
- Returns `{ "continue": false }` on the fifth identical failure, stopping the agent loop
- Fails open if input or state cannot be read or written

The threshold is deliberately five: it permits a small number of legitimate retries while interrupting a repeated repair loop early.

## Event

- **PostToolUse** (all tools, so non-Bash calls can reset the streak)
