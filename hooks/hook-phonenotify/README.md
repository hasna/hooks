# hook-phonenotify

Claude Code hook that sends push notifications to your phone via ntfy.sh.

## Overview

Get notified on your phone when Claude finishes a task or needs your attention. Uses [ntfy.sh](https://ntfy.sh) for free, no-account-required push notifications.

## Installation

```bash
bun install -g @hasnaxyz/hook-phonenotify
hook-phonenotify install my-secret-topic
```

Then subscribe to `my-secret-topic` in the ntfy app on your phone.

## Commands

```bash
hook-phonenotify install [topic]  # Install with ntfy topic
hook-phonenotify uninstall        # Remove hook
hook-phonenotify status           # Show config
hook-phonenotify test             # Send test notification
```

## Configuration

In `~/.claude/settings.json`:

```json
{
  "phoneNotifyConfig": {
    "enabled": true,
    "topic": "your-secret-topic",
    "server": "https://ntfy.sh",
    "priority": 3
  }
}
```

## License

MIT
