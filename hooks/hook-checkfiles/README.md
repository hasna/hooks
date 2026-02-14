# @hasna/hook-checkfiles

Claude Code hook that runs a headless agent to review files and create tasks via service-implementation.

## Features

- **Async execution**: Runs in background, non-blocking
- **Headless Claude agent**: Spawns `claude -p` to review files
- **Task dispatch**: Creates tasks via `service-implementation task dispatch`
- **Configurable threshold**: Review after N file edits (3-7, default: 3)
- **Session-aware**: Only runs for sessions matching configured keywords

## Installation

### Global CLI

```bash
bun add -g @hasna/hook-checkfiles
hook-checkfiles install --global
```

### Project-specific

```bash
cd /path/to/your/project
bunx @hasna/hook-checkfiles install
```

## Requirements

- `claude` CLI (for headless agent)
- `service-implementation` CLI (for task dispatch)

## Usage

Once installed, the hook runs automatically after file edits (Edit, Write, NotebookEdit tools).

### Commands

```bash
hook-checkfiles install [path]     # Install the hook
hook-checkfiles config [path]      # Update configuration
hook-checkfiles uninstall [path]   # Remove the hook
hook-checkfiles status             # Show hook status
hook-checkfiles run                # Execute hook (called by Claude Code)
```

### Options

- `--global`, `-g`: Apply to global settings (`~/.claude/settings.json`)
- `/path/to/repo`: Apply to specific project path

## Configuration

Configuration is stored in `.claude/settings.json`:

```json
{
  "hooks": {
    "PostToolUse": [{
      "matcher": {
        "tool_name": "^(Edit|Write|NotebookEdit)$"
      },
      "hooks": [{
        "type": "command",
        "command": "bunx @hasna/hook-checkfiles@latest run",
        "timeout": 120,
        "async": true
      }]
    }]
  },
  "checkFilesConfig": {
    "editThreshold": 3,
    "taskListId": "myproject-bugfixes",
    "keywords": ["dev"],
    "enabled": true
  }
}
```

### Options

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `editThreshold` | number | 3 | Run review after this many edits (3-7) |
| `taskListId` | string | auto | Task list for dispatching tasks |
| `keywords` | string[] | ["dev"] | Only run for matching sessions |
| `reviewPrompt` | string | default | Custom prompt for headless agent |
| `enabled` | boolean | true | Enable/disable the hook |

## How It Works

1. **Tracks file edits**: Monitors Edit, Write, NotebookEdit tool calls
2. **Counts edits**: Maintains per-session edit counter
3. **Triggers review**: After N edits, spawns headless Claude agent
4. **Agent reviews**: Claude analyzes files for issues
5. **Creates tasks**: Uses `service-implementation task dispatch` for each issue
6. **Non-blocking**: Runs async, doesn't block main session

## Headless Agent

The hook spawns:

```bash
claude -p "<review prompt>" \
  --permission-mode acceptEdits \
  --allowedTools "Bash,Read" \
  --no-session-persistence
```

The agent:
- Reads the edited files
- Identifies bugs, security issues, performance problems
- Creates tasks via `service-implementation task dispatch`

## Task Format

Tasks are dispatched with:

```bash
service-implementation task dispatch "myproject-bugfixes" \
  -s "REVIEW: [brief issue description]" \
  -d "[detailed description with file:line reference]"
```

## Session State

State is persisted in `~/.claude/hook-state/checkfiles-{session_id}.json`:

```json
{
  "editCount": 2,
  "editedFiles": ["src/file.ts", "src/other.ts"],
  "lastReviewRun": 1706500000000,
  "reviewInProgress": false
}
```

## License

Apache-2.0
