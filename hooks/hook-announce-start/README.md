# hook-announce-start

A Notification hook that fires once at session start. Registers the agent profile, reads unread DMs/context, and announces the agent's presence to the team space.

## Installation

```bash
hooks install announce-start
```

## How it works

On the first `Notification` event per session:
1. **Registers profile** — runs `hooks init` to ensure agent profile exists
2. **Fetches context** — runs `conversations context` to get unread DMs, online agents, recent activity
3. **Announces** — sends a start message to the configured conversation space

Subsequent notifications in the same session are ignored (fires once per session via marker file in `/tmp`).

## Configuration

```bash
export HOOKS_AGENT_NAME="agent-frontend"   # Agent display name
export HOOKS_SPACE="engineering"           # Space to announce in (default: general)
```

## Requirements

Optional but recommended:
- `hooks` CLI (for `hooks init`)
- `conversations` CLI (for context + announcements)

## Event

- **Notification** (fires once per session)
