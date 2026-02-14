# hook-slacknotify

Claude Code hook that sends a Slack webhook notification when Claude Code finishes working.

## Overview

When Claude stops, this hook sends a notification to a configured Slack channel via an incoming webhook URL. Useful for being notified when long-running tasks complete.

## Event

- **Stop** (no matcher)

## Configuration

Configure the webhook URL via one of:

### 1. Environment Variable (preferred)

```bash
export SLACK_WEBHOOK_URL="https://hooks.slack.com/services/T.../B.../xxx"
```

### 2. Settings File

Add to `~/.claude/settings.json`:

```json
{
  "slackNotifyConfig": {
    "webhookUrl": "https://hooks.slack.com/services/T.../B.../xxx",
    "enabled": true
  }
}
```

## Slack Message Format

The hook sends a message with:

```json
{
  "text": "Claude Code finished in <project-name>",
  "blocks": [{
    "type": "section",
    "text": {
      "type": "mrkdwn",
      "text": "*Claude Code* finished working in `<cwd>`"
    }
  }]
}
```

## Behavior

- If no webhook URL is configured, logs a warning to stderr and continues
- If the webhook request fails, logs the error to stderr and continues
- Never blocks the session from ending
- Outputs `{ "continue": true }` always

## License

MIT
