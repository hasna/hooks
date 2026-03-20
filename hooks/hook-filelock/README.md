# hook-filelock

A PreToolUse hook that checks file locks before any Edit/Write/NotebookEdit operation. Prevents multiple agents from editing the same file simultaneously.

## Installation

```bash
hooks install filelock
```

## How it works

Before every file edit:
1. Checks `~/.hooks/locks/<file>.lock` for an existing lock
2. If locked by another agent → blocks the edit
3. If unlocked or locked by same session → acquires the lock and approves
4. Locks auto-expire after 30 minutes

## Lock files

Locks are stored at `~/.hooks/locks/`. Each lock contains:
- `session_id` — which session holds the lock
- `agent` — optional agent name (`HOOKS_AGENT_NAME` env var)
- `locked_at` / `expires_at` — timestamps

## Configuration

Set `HOOKS_AGENT_NAME` environment variable to identify which agent holds the lock:

```bash
export HOOKS_AGENT_NAME="agent-frontend"
```

## Releasing locks

Locks expire automatically after 30 minutes. To release manually:

```bash
rm ~/.hooks/locks/<encoded-path>.lock
```

## Event

- **PreToolUse** (matcher: `Edit|Write|NotebookEdit`)
