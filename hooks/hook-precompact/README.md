# hook-precompact

Claude Code hook that saves session state before context compaction.

## Overview

When Claude Code compacts the context (to free up token space), important state can be lost. This hook saves a handoff file with session context, git state, and metadata before compaction occurs.

## Installation

```bash
bun install -g @hasna/hook-precompact
hook-precompact install
```

## Commands

```bash
hook-precompact install     # Install to Claude Code settings
hook-precompact uninstall   # Remove hook
hook-precompact status      # Check installation
hook-precompact list        # Show recent handoffs
hook-precompact latest      # Show latest handoff data
```

## What Gets Saved

Each handoff file (`.claude-handoffs/`) contains:
- Session ID and timestamp
- Current working directory
- Git branch, last commit, status, recent commits
- Transcript summary (when available)

## License

Apache-2.0
