# hook-fleet-catchup

A SessionStart hook that catches an agent up on fleet communications before it starts working. Part of the Hasna fleet comms workflow (HACP read-duty).

## Installation

```bash
hooks install fleet-catchup
```

## How it works

On every `SessionStart` event it runs three deterministic, bounded reads against the local `conversations` CLI:

1. `conversations blockers -j` — unread blocking messages (must be handled before work)
2. `conversations notifications --since <last-catchup>` — channel notifications since the last catchup on this machine (bounded to 24h on first run)
3. `conversations digest announcements --unread --since 7d` — the bounded announcements digest (never hands a fresh session full history as unread)

Anything found is injected into the session via `hookSpecificOutput.additionalContext`, ending with the HACP read-duty reminder (unread `[FREEZE]` means stop and escalate).

The three reads run in parallel, so the worst-case session-start cost is one timeout, not the sum of three. Every step is fail-open: a missing CLI, dead service, timeout, or unparseable output skips that section and never blocks the session. The last-catchup cursor only advances after a successful notifications read — an outage never silently swallows the missed window.

## Configuration

```bash
export HOOKS_FLEET_CATCHUP_DISABLE=1     # Kill switch — skip entirely
export HOOKS_FLEET_AGENT="chief"         # Identity passed as --from
export HOOKS_FLEET_TIMEOUT_MS=1500       # Per-command exec timeout (default 1500)
export HOOKS_FLEET_SINCE=7d              # Announcements digest window (default 7d)
```

State: the last-catchup timestamp is stored at `~/.hasna/hooks/state/fleet-catchup.last_seen`.

## Requirements

- `conversations` CLI (@hasna/conversations) — optional; the hook is a no-op without it

## Event

- **SessionStart** (fires on startup, resume, and clear)
