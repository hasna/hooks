# hook-agentmessages

Claude Code hook for service-message integration.

Automatically registers projects and sessions when Claude Code starts, and checks for unread messages after each response.

## Installation

```bash
# Install globally
bun install -g @hasnaxyz/hook-agentmessages

# Install hooks into Claude Code
hook-agentmessages install
```

## Prerequisites

Before using this hook, you must initialize an agent with service-message:

```bash
service-message init
```

This hook does NOT auto-generate agents. It only works if an agent is already configured.

## What it does

### SessionStart Hook

When a Claude Code session starts:

1. **Reads existing agent** from service-message config
2. **Registers the project** from `$CLAUDE_PROJECT_DIR` (folder name becomes project ID)
3. **Starts a session** linked to the Claude session ID
4. **Exports environment variables** for the session:
   - `SMSG_AGENT_ID`
   - `SMSG_SESSION_ID`
   - `SMSG_PROJECT_ID`

### Stop Hook

After Claude finishes each response:

1. Checks for unread messages (efficient, no polling)
2. Notifies Claude if there are pending messages
3. Runs with 5s timeout to avoid blocking

## CLI Commands

```bash
hook-agentmessages install    # Install hooks
hook-agentmessages uninstall  # Remove hooks
hook-agentmessages status     # Check installation status
```

## Configuration

Hooks are stored in `~/.claude/settings.json`:

```json
{
  "hooks": {
    "SessionStart": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "bun /path/to/hook-agentmessages/src/session-start.ts",
            "timeout": 10
          }
        ]
      }
    ],
    "Stop": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "bun /path/to/hook-agentmessages/src/check-messages.ts",
            "timeout": 5
          }
        ]
      }
    ]
  }
}
```

## Efficiency

The hook is designed to be lightweight:

- **SessionStart**: Runs once per session (10s timeout)
- **Stop**: Only checks for messages after Claude responds (5s timeout)
- **No polling**: Doesn't continuously monitor, only checks on events
- **Fast file reads**: Uses Bun's native file APIs

## Requirements

- Bun runtime
- service-message (`@hasnaxyz/service-message`) installed and initialized
- Claude Code with hooks support

## License

MIT
