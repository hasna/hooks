# hook-spiral-detector

A synchronous PostToolUse hook that stops the agent after the same Bash command fails three consecutive times with the same exit status and first line of stderr.

## Why three?

One failure is normal and a second may be a legitimate retry. Three identical failures indicate that the repair loop has not changed its observable red state, while still interrupting early enough to preserve the session budget. A different command, exit status, first stderr line, or a successful Bash call resets the count.

## Installation

```bash
hooks install spiral-detector
```

State is isolated by session under `~/.hasna/hooks/state/`. When the threshold is reached, the hook returns `{"continue":false,"stopReason":"..."}` so the runtime stops processing instead of merely adding advice to the model's context.

## Event

- **PostToolUse** (matcher: `Bash`)
