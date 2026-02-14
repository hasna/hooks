# hook-contextrefresh

Claude Code hook that re-injects important context every N prompts to prevent context decay.

## Overview

In long Claude Code sessions, important instructions can drift out of the active context window. This hook automatically re-injects content from a `.claude-context` file every N user prompts.

## Installation

```bash
bun install -g @hasna/hook-contextrefresh
hook-contextrefresh install 10  # inject every 10 prompts
```

Then create `.claude-context` in your project root with the context you want refreshed.

## Commands

```bash
hook-contextrefresh install [N]  # Install with interval (default: 10)
hook-contextrefresh uninstall    # Remove hook
hook-contextrefresh status       # Show config
```

## Configuration

In `~/.claude/settings.json`:

```json
{
  "contextRefreshConfig": {
    "enabled": true,
    "interval": 10,
    "contextFile": ".claude-context"
  }
}
```

## License

Apache-2.0
