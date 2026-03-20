# hook-announce-stop

A Stop hook that automatically cleans up and announces when an agent session ends. Releases file locks, posts a summary to the team space, and adds notes to in-progress tasks.

## Installation

```bash
hooks install announce-stop
```

## How it works

On every `Stop` event:
1. **Releases file locks** — scans `~/.hooks/locks/` and removes all locks held by this session
2. **Posts summary** — sends a message to the configured conversation space via `conversations send`
3. **Updates tasks** — adds a comment to any in-progress tasks noting the session ended

## Configuration

Set environment variables to customize behavior:

```bash
export HOOKS_AGENT_NAME="agent-frontend"   # Agent display name (default: session ID)
export HOOKS_SPACE="engineering"           # Conversation space to post to (default: general)
```

## Requirements

Optional but recommended:
- `conversations` CLI for posting to spaces
- `todos` CLI for updating task status

## Event

- **Stop** — runs after Claude finishes each response
