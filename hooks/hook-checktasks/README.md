# @hasnaxyz/hook-checktasks

A Claude Code hook that prevents Claude from stopping when there are pending tasks.

## What it does

This hook intercepts Claude's "Stop" event and:

1. Checks configured task lists for pending/in-progress tasks
2. If tasks remain → **blocks the stop** and prompts Claude to continue
3. If all complete → allows stop

## Installation

### 1. Install the CLI globally

```bash
bun add -g @hasnaxyz/hook-checktasks
# or
npm install -g @hasnaxyz/hook-checktasks
```

### 2. Install the hook

```bash
# Auto-detect (git repo → project, else → prompt)
hook-checktasks install

# Install globally
hook-checktasks install --global

# Install to specific path
hook-checktasks install /path/to/project
```

The installer will prompt you to configure:
- **Task list ID**: specific list or leave empty for all lists
- **Keywords**: session/list name keywords to trigger the check (default: "dev")

## Configuration

### Update configuration

```bash
hook-checktasks config              # Current project
hook-checktasks config --global     # Global settings
```

### Check status

```bash
hook-checktasks status
```

Shows:
- Where hook is installed (global/project)
- Current configuration
- Available task lists

### Uninstall

```bash
hook-checktasks uninstall           # Current project
hook-checktasks uninstall --global  # Global
hook-checktasks uninstall /path     # Specific path
```

## How Configuration Works

Configuration is stored in `.claude/settings.json`:

```json
{
  "hooks": {
    "Stop": [{ "hooks": [{ "type": "command", "command": "bunx @hasnaxyz/hook-checktasks run" }] }]
  },
  "checkTasksConfig": {
    "taskListId": "myproject-dev",
    "keywords": ["dev"],
    "enabled": true
  }
}
```

### Config Options

| Option | Description | Default |
|--------|-------------|---------|
| `taskListId` | Specific task list to check, or `undefined` for all lists | `undefined` (all) |
| `keywords` | Keywords to match in session/list names | `["dev"]` |
| `enabled` | Enable/disable the hook | `true` |

### Priority

1. Project settings (`.claude/settings.json`)
2. Global settings (`~/.claude/settings.json`)
3. Environment variables (legacy)

### Legacy Environment Variables

Still supported for backwards compatibility:

```bash
CLAUDE_CODE_TASK_LIST_ID=myproject-dev claude
CHECK_TASKS_KEYWORDS=dev,sprint claude
CHECK_TASKS_DISABLED=1 claude
```

## CLI Commands

```
hook-checktasks install [path]     Install the hook
hook-checktasks config [path]      Update configuration
hook-checktasks uninstall [path]   Remove the hook
hook-checktasks status             Show hook status
hook-checktasks run                Execute hook (called by Claude Code)

Options:
  --global, -g   Apply to global settings
  /path/to/repo  Apply to specific project
```

## How it Works

```
Claude tries to stop
        │
        ▼
    Stop hook fires
        │
        ▼
    Read config from settings.json
        │
        ▼
    Check matching task lists
        │
        ├── Tasks remaining → BLOCK stop, prompt to continue
        │
        └── All complete → ALLOW stop
```

## License

MIT
