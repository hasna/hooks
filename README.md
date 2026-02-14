# Hooks

Open source library of 15 Claude Code hooks. Install any hook with a single command.

## Quick Start

```bash
# Interactive mode - browse and select hooks
npx @hasna/hooks

# Install specific hooks
npx @hasna/hooks install gitguard branchprotect checkpoint

# List all available hooks
npx @hasna/hooks list
```

## Installation

```bash
# Global install
bun install -g @hasna/hooks

# Or use npx (no install needed)
npx @hasna/hooks
```

## NPM Auth (Optional)

If you need a scoped registry token (publish or private installs), copy an example file and set `NPM_TOKEN`:

```bash
cp .npmrc.example .npmrc
```

See `CONTRIBUTING.md` for publishing and secrets guidance.

## Usage

### Interactive Mode

Run without arguments to browse hooks by category:

```bash
hooks
```

### Install Hooks

```bash
# Install one or more hooks
hooks install gitguard branchprotect checkpoint

# Hooks are installed to .hooks/ and registered in ~/.claude/settings.json
```

### Search

```bash
# Search by name, description, or tags
hooks search security
hooks search git
```

### List by Category

```bash
hooks list --category "Git Safety"
hooks list --category "Code Quality"
```

### Hook Info

```bash
hooks info gitguard
```

### Check Registered Hooks

```bash
hooks list --registered
```

### Remove

```bash
hooks remove gitguard
```

## Available Hooks (15)

### Git Safety (3)
| Hook | Event | Description |
|------|-------|-------------|
| gitguard | PreToolUse | Blocks destructive git operations like reset --hard, push --force, clean -f |
| branchprotect | PreToolUse | Prevents editing files directly on main/master branch |
| checkpoint | PreToolUse | Creates shadow git snapshots before file modifications for easy rollback |

### Code Quality (6)
| Hook | Event | Description |
|------|-------|-------------|
| checktests | PostToolUse | Checks for missing tests after file edits |
| checklint | PostToolUse | Runs linting after file edits and creates tasks for errors |
| checkfiles | PostToolUse | Runs headless agent to review files and create tasks |
| checkbugs | PostToolUse | Checks for bugs via Codex headless agent |
| checkdocs | PostToolUse | Checks for missing documentation and creates tasks |
| checktasks | PostToolUse | Validates task completion and tracks progress |

### Security (2)
| Hook | Event | Description |
|------|-------|-------------|
| checksecurity | PostToolUse | Runs security checks via Claude and Codex headless agents |
| packageage | PreToolUse | Checks package age before install to prevent typosquatting |

### Notifications (2)
| Hook | Event | Description |
|------|-------|-------------|
| phonenotify | Stop | Sends push notifications to phone via ntfy.sh |
| agentmessages | Stop | Inter-agent messaging integration for service-message |

### Context Management (2)
| Hook | Event | Description |
|------|-------|-------------|
| contextrefresh | Notification | Re-injects important context every N prompts to prevent drift |
| precompact | Notification | Saves session state before context compaction |

## How Hooks Work

Claude Code hooks are lifecycle interceptors that run during agent sessions:

- **PreToolUse**: Runs before a tool executes. Can **block** the operation.
- **PostToolUse**: Runs after a tool executes. Async, non-blocking.
- **Stop**: Runs when a session ends. Async, non-blocking.
- **Notification**: Runs on notification events. Async, non-blocking.

Each hook receives JSON on stdin and outputs JSON on stdout:

```json
// PreToolUse input
{
  "session_id": "abc123",
  "cwd": "/path/to/project",
  "tool_name": "Bash",
  "tool_input": { "command": "git push --force" }
}

// PreToolUse output (block)
{ "decision": "block", "reason": "Destructive git operation blocked" }

// PreToolUse output (approve)
{ "decision": "approve" }
```

## Hook Structure

Each hook follows a consistent structure:

```
hook-{name}/
├── src/
│   ├── hook.ts     # Main hook logic (stdin → stdout)
│   ├── cli.ts      # CLI for install/uninstall/status
│   └── index.ts    # Library exports
├── package.json
├── CLAUDE.md
├── README.md
└── tsconfig.json
```

## Installing Individual Hooks

You can also install hooks individually as npm packages:

```bash
bun install -g @hasna/hook-gitguard
bun install -g @hasna/hook-branchprotect
bun install -g @hasna/hook-checkpoint
```

Then use their built-in CLI:

```bash
hook-gitguard install    # Register in Claude settings
hook-gitguard status     # Check if registered
hook-gitguard uninstall  # Unregister
```

## Configuration

Hooks are registered in `~/.claude/settings.json`:

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "Bash",
        "hooks": [
          { "type": "command", "command": "hook-gitguard" }
        ]
      }
    ]
  }
}
```

## Development

```bash
# Install dependencies
bun install

# Run CLI in development
bun run dev

# Build
bun run build

# Type check
bun run typecheck
```

## Contributing

1. Fork the repository
2. Create a new hook in `hooks/hook-{name}/`
3. Follow the existing hook patterns
4. Submit a pull request

## License

MIT
