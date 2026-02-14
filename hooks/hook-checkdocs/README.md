# @hasnaxyz/hook-checkdocs

Claude Code hook that checks for missing documentation and creates tasks via service-implementation.

## Features

- **Async execution**: Runs in background, non-blocking
- **Headless Claude agent**: Spawns `claude -p` to check documentation
- **Task dispatch**: Creates tasks via `service-implementation task dispatch`
- **Configurable threshold**: Check after N file edits (3-7, default: 3)
- **Repo pattern check**: Only runs for repos matching `[prefix]-[name]` pattern
- **Session-aware**: Only runs for sessions matching configured keywords

## Installation

### Global CLI

```bash
bun add -g @hasnaxyz/hook-checkdocs
hook-checkdocs install --global
```

### Project-specific

```bash
cd /path/to/your/project
bunx @hasnaxyz/hook-checkdocs install
```

## Requirements

- `claude` CLI (for headless agent)
- `service-implementation` CLI (for task dispatch)

## Usage

Once installed, the hook runs automatically after file edits (Edit, Write, NotebookEdit tools).

### Commands

```bash
hook-checkdocs install [path]     # Install the hook
hook-checkdocs config [path]      # Update configuration
hook-checkdocs uninstall [path]   # Remove the hook
hook-checkdocs status             # Show hook status
hook-checkdocs run                # Execute hook (called by Claude Code)
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
        "command": "bunx @hasnaxyz/hook-checkdocs@latest run",
        "timeout": 120,
        "async": true
      }]
    }]
  },
  "checkDocsConfig": {
    "editThreshold": 3,
    "taskListId": "myproject-dev",
    "keywords": ["dev"],
    "enabled": true
  }
}
```

### Options

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `editThreshold` | number | 3 | Run check after this many edits (3-7) |
| `taskListId` | string | auto | Task list for dispatching tasks |
| `keywords` | string[] | ["dev"] | Only run for matching sessions |
| `enabled` | boolean | true | Enable/disable the hook |

## How It Works

1. **Tracks file edits**: Monitors Edit, Write, NotebookEdit tool calls
2. **Validates repo**: Only runs for repos matching `[prefix]-[name]` pattern
3. **Counts edits**: Maintains per-session edit counter
4. **Triggers check**: After N edits, spawns headless Claude agent
5. **Agent reviews**: Claude analyzes files for missing documentation
6. **Creates tasks**: Uses `service-implementation task dispatch` for each issue
7. **Non-blocking**: Runs async, doesn't block main session

## Documentation Issues Detected

The hook checks for:

- Missing function/method documentation
- Outdated README sections
- Missing API documentation
- Missing inline comments for complex logic
- Missing type definitions documentation
- Missing usage examples

## Task Format

Tasks are dispatched with:

```bash
service-implementation task dispatch "myproject-dev" \
  -s "DOCS: [brief description]" \
  -d "[detailed description of what docs need to be added/updated]"
```

## Session State

State is persisted in `~/.claude/hook-state/checkdocs-{session_id}.json`:

```json
{
  "editCount": 2,
  "editedFiles": ["src/file.ts", "src/other.ts"],
  "lastCheckRun": 1706500000000,
  "checkInProgress": false
}
```

## License

MIT
