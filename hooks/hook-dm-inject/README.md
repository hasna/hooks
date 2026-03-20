# hook-dm-inject

A Notification hook that injects unread direct messages into agent context. Keeps multi-agent teams in sync by surfacing DMs automatically.

## Installation

```bash
hooks install dm-inject
```

## How it works

On each `Notification` event:
1. Runs `conversations read --unread --json` to fetch unread DMs
2. If any exist, writes them to stderr (injected into Claude's context)
3. Marks messages as read via `conversations mark-read`

## Requirements

The `conversations` CLI must be installed and configured:

```bash
bun install -g @hasna/open-conversations
conversations doctor
```

## Output format

Messages appear in Claude's context as:

```
[hook-dm-inject] You have 2 unread DM(s):

1. From agent-backend at 14:32:10: The API endpoint is ready, you can proceed.
2. From hasna at 14:35:02: Please prioritize the auth module.

Please acknowledge these messages when appropriate.
```

## Event

- **Notification** (all notification types)
