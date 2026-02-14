# @hasna/hook-checksecurity

Claude Code hook that runs security checks via Claude and Codex headless agents. This is a **blocker** hook on the Stop event.

## Features

- **Stop event blocker**: Runs before session ends
- **Dual agent review**: Spawns both Claude and Codex for thorough coverage
- **Task dispatch**: Creates security tasks via `service-implementation task dispatch`
- **Repo pattern check**: Only runs for repos matching `[prefix]-[name]` pattern
- **One-time per session**: Only runs once (state flag prevents re-runs)
- **Session-aware**: Only runs for sessions matching configured keywords

## Installation

### Global CLI

```bash
bun add -g @hasna/hook-checksecurity
hook-checksecurity install --global
```

### Project-specific

```bash
cd /path/to/your/project
bunx @hasna/hook-checksecurity install
```

## Requirements

- `claude` CLI (for headless agent)
- `codex` CLI (optional, for additional security review)
- `service-implementation` CLI (for task dispatch)

## Usage

Once installed, the hook runs automatically on the Stop event.

### Commands

```bash
hook-checksecurity install [path]     # Install the hook
hook-checksecurity config [path]      # Update configuration
hook-checksecurity uninstall [path]   # Remove the hook
hook-checksecurity status             # Show hook status
hook-checksecurity run                # Execute hook (called by Claude Code)
```

### Options

- `--global`, `-g`: Apply to global settings (`~/.claude/settings.json`)
- `/path/to/repo`: Apply to specific project path

## Configuration

Configuration is stored in `.claude/settings.json`:

```json
{
  "hooks": {
    "Stop": [{
      "hooks": [
        {
          "type": "command",
          "command": "bunx @hasna/hook-checksecurity@latest run",
          "timeout": 300
        },
        {
          "type": "command",
          "command": "bunx @hasna/hook-checktasks@latest run"
        }
      ]
    }]
  },
  "checkSecurityConfig": {
    "taskListId": "myproject-dev",
    "keywords": ["dev"],
    "enabled": true
  }
}
```

### Options

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `taskListId` | string | auto | Task list for dispatching security tasks |
| `keywords` | string[] | ["dev"] | Only run for matching sessions |
| `enabled` | boolean | true | Enable/disable the hook |

## How It Works

1. **Stop event triggers**: When user tries to end session
2. **Validates repo pattern**: Only runs for `[prefix]-[name]` folders
3. **Checks session state**: Skips if already ran this session
4. **Runs Claude security check**: Headless agent scans for vulnerabilities
5. **Runs Codex security check**: Additional headless agent review
6. **Creates tasks**: Both agents dispatch tasks via `service-implementation`
7. **hook-checktasks blocks**: If tasks exist, session is blocked

## Security Issues Detected

The hook checks for:

- Injection vulnerabilities (SQL, XSS, command injection)
- Authentication/authorization issues
- Sensitive data exposure
- Insecure configurations
- Dependency vulnerabilities
- Hardcoded secrets or credentials
- Input validation issues
- CSRF vulnerabilities
- Insecure deserialization

## Task Format

Tasks are dispatched with:

```bash
service-implementation task dispatch "myproject-dev" \
  -s "SECURITY: [severity] - [brief description]" \
  -d "[detailed description with file:line reference and remediation]"
```

Severity levels: CRITICAL, HIGH, MEDIUM, LOW

## Session State

State is persisted in `~/.claude/hook-state/checksecurity-{session_id}.json`:

```json
{
  "securityChecked": true,
  "lastCheckRun": 1706500000000
}
```

## Hook Ordering

For proper operation, checksecurity should run **before** checktasks:

```json
{
  "hooks": {
    "Stop": [{
      "hooks": [
        { "command": "bunx @hasna/hook-checksecurity@latest run" },
        { "command": "bunx @hasna/hook-checktasks@latest run" }
      ]
    }]
  }
}
```

## License

Apache-2.0
