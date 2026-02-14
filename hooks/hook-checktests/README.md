# @hasnaxyz/hook-checktests

Claude Code hook that checks for missing tests via a headless Claude agent. Runs async (non-blocking) on PostToolUse after file edits.

## Features

- **Edit tracking**: Monitors Edit, Write, NotebookEdit tools
- **Configurable threshold**: Run after N edits (3-7, default: 3)
- **Headless review**: Spawns Claude agent to analyze test coverage
- **Task dispatch**: Creates tasks via `service-implementation task dispatch`
- **Repo pattern check**: Only runs for repos matching `[prefix]-[name]` pattern
- **Session-aware**: Only runs for sessions matching configured keywords

## Installation

### Global CLI

```bash
bun add -g @hasnaxyz/hook-checktests
hook-checktests install --global
```

### Project-specific

```bash
cd /path/to/your/project
bunx @hasnaxyz/hook-checktests install
```

## Requirements

- `claude` CLI (for headless agent)
- `service-implementation` CLI (for task dispatch)

## Usage

Once installed, the hook runs automatically after file edits.

### Commands

```bash
hook-checktests install [path]     # Install the hook
hook-checktests config [path]      # Update configuration
hook-checktests uninstall [path]   # Remove the hook
hook-checktests status             # Show hook status
hook-checktests run                # Execute hook (called by Claude Code)
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
      "matcher": { "tool_name": "^(Edit|Write|NotebookEdit)$" },
      "hooks": [{
        "type": "command",
        "command": "bunx @hasnaxyz/hook-checktests@latest run",
        "timeout": 120,
        "async": true
      }]
    }]
  },
  "checkTestsConfig": {
    "editThreshold": 3,
    "taskListId": "myproject-qa",
    "keywords": ["dev"],
    "enabled": true
  }
}
```

### Options

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `editThreshold` | number | 3 | Run review after this many edits (3-7) |
| `taskListId` | string | auto | Task list for dispatching tasks (auto-detects `*-qa`) |
| `keywords` | string[] | ["dev"] | Only run for matching sessions |
| `enabled` | boolean | true | Enable/disable the hook |

## How It Works

1. **Tracks edits**: Monitors Edit, Write, NotebookEdit tool calls
2. **Counts edits**: Increments counter for each unique file edited
3. **Threshold check**: After N edits, spawns headless Claude agent
4. **Test review**: Agent analyzes edited files for missing tests
5. **Task dispatch**: Creates tasks via `service-implementation task dispatch`
6. **Reset**: Counter resets after each review

## Test Issues Detected

The hook checks for:

- Missing unit tests for new functions/methods
- Missing integration tests for new features
- Missing edge case tests
- Missing error handling tests
- Untested code paths
- Missing mock/stub implementations
- Missing test fixtures or setup
- Missing API endpoint tests
- Missing validation tests

## Task Format

Tasks are dispatched with:

```bash
service-implementation task dispatch "myproject-qa" \
  -s "TEST: [brief description]" \
  -d "[detailed description of what tests need to be added]"
```

## Session State

State is persisted in `~/.claude/hook-state/checktests-{session_id}.json`:

```json
{
  "editCount": 2,
  "editedFiles": ["src/utils.ts", "src/api.ts"],
  "lastCheckRun": 1706500000000,
  "checkInProgress": false
}
```

## License

MIT
