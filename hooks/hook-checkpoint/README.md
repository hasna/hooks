# hook-checkpoint

Claude Code hook that creates shadow git snapshots before file modifications for easy rollback.

## Overview

Before any `Write`, `Edit`, or `NotebookEdit` tool execution, this hook copies the original file into a shadow git repository (`.claude-checkpoints/`). This gives you a full history of every file before Claude modified it, without cluttering your main git history.

## Installation

```bash
bun install -g @hasnaxyz/hook-checkpoint
hook-checkpoint install
```

## Usage

```bash
hook-checkpoint install       # Install to Claude Code settings
hook-checkpoint uninstall     # Remove from Claude Code settings
hook-checkpoint status        # Check installation status
hook-checkpoint list          # Show recent checkpoints
hook-checkpoint restore <ref> # Restore files from a checkpoint
```

## How It Works

1. Hook intercepts `Write`/`Edit`/`NotebookEdit` calls (PreToolUse)
2. Copies the original file into `.claude-checkpoints/files/`
3. Commits to a shadow git repo with metadata
4. Always approves the operation (non-blocking)

The `.claude-checkpoints/` directory is automatically added to `.gitignore`.

## License

MIT
