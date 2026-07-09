# hook-announce-start

A SessionStart hook that fires when a session starts. Registers the agent profile, reads unread DMs/context and injects them into session context, and announces the agent's presence to the team space.

Previously bound to `Notification` (which does not fire at session start); as of 0.2.0 it binds to `SessionStart`. Reinstalling via `hooks install announce-start` migrates the settings entry to the new event automatically.

## Installation

```bash
hooks install announce-start
```

## How it works

On the `SessionStart` event:
1. **Registers profile** — runs `hooks init` to ensure agent profile exists
2. **Fetches context** — runs `conversations context` to get unread DMs, online agents, recent activity, and injects it via `hookSpecificOutput.additionalContext`
3. **Announces** — sends a start message to the configured conversation space

SessionStart also fires on resume/clear/compact; a marker file in `/tmp` ensures the announcement happens only once per session.

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

- **SessionStart** (announces once per session)
