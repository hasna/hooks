# CLAUDE.md

Instructions for working with hook-agentmessages codebase.

## Project Overview

**hook-agentmessages** is a Claude Code hook package that integrates with service-message for automatic agent registration and message notifications.

- **Package:** `@hasna/hook-agentmessages`
- **CLI command:** `hook-agentmessages`
- **Hooks location:** `~/.claude/settings.json`

## What it Does

### SessionStart Hook (`src/session-start.ts`)

Runs when Claude Code session starts:
1. Auto-registers agent with ID format: `{type}-{shortid}` (claude-abc123, codex-xyz789)
2. Registers project from `$CLAUDE_PROJECT_DIR`
3. Creates session linked to Claude session ID
4. Exports env vars: `SMSG_AGENT_ID`, `SMSG_SESSION_ID`, `SMSG_PROJECT_ID`

### Stop Hook (`src/check-messages.ts`)

Runs after Claude finishes each response:
1. Checks for unread messages (efficient, no polling)
2. Returns notification if unread messages exist
3. 5s timeout to avoid blocking

## Development

### Key Files

```
bin/cli.ts           # CLI entry point
src/
├── session-start.ts # SessionStart hook
├── check-messages.ts # Stop hook
├── install.ts       # Install hooks to Claude Code
└── uninstall.ts     # Remove hooks
```

### Hook Input Format

Hooks receive JSON via stdin:
```json
{
  "session_id": "abc123",
  "cwd": "/path/to/project",
  "model": "claude-opus-4-5-20251101",
  "hook_event_name": "SessionStart"
}
```

### Hook Output Format

```json
{
  "decision": "continue",
  "message": "Optional message shown to Claude"
}
```

## Testing

```bash
# Test session-start hook
echo '{"session_id":"test","cwd":"/tmp"}' | bun run src/session-start.ts

# Test check-messages hook
SMSG_AGENT_ID=claude-1 bun run src/check-messages.ts

# Install/uninstall
bun run install-hook
bun run uninstall-hook

# Check status
hook-agentmessages status
```
