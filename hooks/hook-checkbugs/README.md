# @hasnaxyz/hook-checkbugs

Claude Code hook that checks for bugs via a headless Codex agent. Runs async (non-blocking) on PostToolUse after file edits.

## Features

- **Edit tracking**: Monitors Edit, Write, NotebookEdit tools
- **Configurable threshold**: Run after N edits (3-7, default: 3)
- **Headless Codex**: Spawns Codex agent to analyze for bugs
- **Task dispatch**: Creates tasks via `service-implementation task dispatch`
- **Repo pattern check**: Only runs for repos matching `[prefix]-[name]` pattern
- **Session-aware**: Only runs for sessions matching configured keywords

## Installation

### Global CLI

```bash
bun add -g @hasnaxyz/hook-checkbugs
hook-checkbugs install --global
```

### Project-specific

```bash
cd /path/to/your/project
bunx @hasnaxyz/hook-checkbugs install
```

## Requirements

- `codex` CLI (for headless agent)
- `service-implementation` CLI (for task dispatch)

## Usage

Once installed, the hook runs automatically after file edits.

### Commands

```bash
hook-checkbugs install [path]     # Install the hook
hook-checkbugs config [path]      # Update configuration
hook-checkbugs uninstall [path]   # Remove the hook
hook-checkbugs status             # Show hook status
hook-checkbugs run                # Execute hook (called by Claude Code)
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
        "command": "bunx @hasnaxyz/hook-checkbugs@latest run",
        "timeout": 120,
        "async": true
      }]
    }]
  },
  "checkBugsConfig": {
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
| `taskListId` | string | auto | Task list for dispatching tasks (auto-detects `*-bugfixes`) |
| `keywords` | string[] | ["dev"] | Only run for matching sessions |
| `enabled` | boolean | true | Enable/disable the hook |

## How It Works

1. **Tracks edits**: Monitors Edit, Write, NotebookEdit tool calls
2. **Counts edits**: Increments counter for each unique file edited
3. **Threshold check**: After N edits, spawns headless Codex agent
4. **Bug review**: Agent analyzes edited files for potential bugs
5. **Task dispatch**: Creates tasks via `service-implementation task dispatch`
6. **Reset**: Counter resets after each review

## Bug Issues Detected

The hook checks for:

- Logic errors and off-by-one errors
- Null/undefined reference issues
- Race conditions and async bugs
- Memory leaks
- Unhandled edge cases
- Type mismatches
- Incorrect error handling
- Security vulnerabilities
- Performance issues
- Resource cleanup issues

## Task Format

Tasks are dispatched with:

```bash
service-implementation task dispatch "myproject-bugfixes" \
  -s "BUG: [severity] - [brief description]" \
  -d "[detailed description with file:line reference and suggested fix]"
```

Severity levels: CRITICAL, HIGH, MEDIUM, LOW

## Session State

State is persisted in `~/.claude/hook-state/checkbugs-{session_id}.json`:

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
