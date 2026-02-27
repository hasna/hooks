# @hasna/hooks

Open source lifecycle hooks library for AI coding agents. 30 hooks across 10 categories, installable with a single command. Works with Claude Code and Gemini CLI.

## Features

- **30 hooks** in 10 categories (git safety, code quality, security, notifications, and more)
- **Interactive CLI** (`hooks`) with React/Ink TUI for browsing, installing, and managing hooks
- **MCP server** (13 tools) for agent-driven hook management over stdio or SSE
- **Library** for programmatic access from Node.js/Bun
- **Multi-agent support** for Claude Code and Gemini CLI with per-agent event mapping
- **Agent profiles** with unique 8-char UUID identity system
- **Zero file copy** -- hooks run from the globally installed package, nothing is copied to your project
- **Web dashboard** for browsing hooks (Vite + React 19 + TailwindCSS 4)
- **Health checks** via `hooks doctor` to verify hook installation integrity
- Global or project-scoped installation

## Installation

```bash
bun install -g @hasna/hooks
```

Or with npm:

```bash
npm install -g @hasna/hooks
```

Or use without installing:

```bash
npx @hasna/hooks
```

## Quick Start

```bash
# Interactive mode -- browse and select hooks
hooks

# Install specific hooks
hooks install gitguard branchprotect checkpoint

# Install all hooks in a category
hooks install --category "Git Safety"

# Install all 30 hooks
hooks install --all

# List all available hooks
hooks list

# Search by name, description, or tags
hooks search security

# Check health of installed hooks
hooks doctor

# Start MCP server for agent integration
hooks mcp --stdio
```

## Hook Categories

| Category | Count | Description |
|----------|------:|-------------|
| Git Safety | 3 | Block destructive git ops, protect branches, create snapshots |
| Code Quality | 6 | Check tests, lint, bugs, docs, files, and task completion |
| Security | 2 | Security audits and typosquatting prevention |
| Notifications | 5 | Phone, desktop, Slack, sound, and inter-agent messages |
| Context Management | 2 | Re-inject context and save state before compaction |
| Workflow Automation | 3 | Auto-format, auto-stage, and TDD enforcement |
| Environment | 1 | Detect nvm/virtualenv/asdf/rbenv activation needs |
| Permissions | 3 | Auto-approve safe commands, protect files, block prompt injection |
| Observability | 4 | Session logs, command logs, cost tracking, error detection |
| Agent Teams | 1 | Validate task completion criteria |

## Hook Events

| Event | Timing | Can Block | Matcher |
|-------|--------|:---------:|---------|
| PreToolUse | Before tool execution | Yes | Tool name pattern (e.g., `Bash`, `Write\|Edit`) |
| PostToolUse | After tool execution | No | Tool name pattern |
| Stop | Session ends | No | Empty string |
| Notification | System events (e.g., compaction) | No | Empty string |

Each hook receives JSON on stdin and outputs JSON on stdout:

```json
// Input (PreToolUse)
{
  "session_id": "abc123",
  "cwd": "/path/to/project",
  "tool_name": "Bash",
  "tool_input": { "command": "git push --force" }
}

// Output (block)
{ "decision": "block", "reason": "Destructive git operation blocked" }

// Output (approve)
{ "decision": "approve" }
```

## Available Hooks (30)

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
| checkbugs | PostToolUse | Checks for bugs via headless agent |
| checkdocs | PostToolUse | Checks for missing documentation and creates tasks |
| checktasks | PostToolUse | Validates task completion and tracks progress |

### Security (2)

| Hook | Event | Description |
|------|-------|-------------|
| checksecurity | PostToolUse | Runs security checks via headless agents |
| packageage | PreToolUse | Checks package age before install to prevent typosquatting |

### Notifications (5)

| Hook | Event | Description |
|------|-------|-------------|
| phonenotify | Stop | Sends push notifications to phone via ntfy.sh |
| agentmessages | Stop | Inter-agent messaging integration for service-message |
| desktopnotify | Stop | Sends native desktop notifications via osascript (macOS) or notify-send (Linux) |
| slacknotify | Stop | Sends Slack webhook notifications when Claude finishes |
| soundnotify | Stop | Plays a system sound when Claude finishes (macOS/Linux) |

### Context Management (2)

| Hook | Event | Description |
|------|-------|-------------|
| contextrefresh | Notification | Re-injects important context every N prompts to prevent drift |
| precompact | Notification | Saves session state before context compaction |

### Workflow Automation (3)

| Hook | Event | Description |
|------|-------|-------------|
| autoformat | PostToolUse | Runs project formatter (Prettier, Biome, Ruff, Black, gofmt) after file edits |
| autostage | PostToolUse | Automatically git-stages files after Claude edits them |
| tddguard | PreToolUse | Blocks implementation edits unless corresponding test files exist |

### Environment (1)

| Hook | Event | Description |
|------|-------|-------------|
| envsetup | PreToolUse | Warns when nvm, virtualenv, asdf, or rbenv may need activation before commands |

### Permissions (3)

| Hook | Event | Description |
|------|-------|-------------|
| permissionguard | PreToolUse | Auto-approves safe read-only commands and blocks dangerous operations |
| protectfiles | PreToolUse | Blocks access to .env, secrets, SSH keys, and lock files |
| promptguard | PreToolUse | Blocks prompt injection attempts and credential access requests |

### Observability (4)

| Hook | Event | Description |
|------|-------|-------------|
| sessionlog | PostToolUse | Logs every tool call to .claude/session-log-\<date\>.jsonl |
| commandlog | PostToolUse | Logs every bash command Claude runs to .claude/commands.log |
| costwatch | Stop | Estimates session token usage and warns when budget threshold is exceeded |
| errornotify | PostToolUse | Detects tool failures and logs errors to .claude/errors.log |

### Agent Teams (1)

| Hook | Event | Description |
|------|-------|-------------|
| taskgate | PostToolUse | Validates task completion criteria before allowing tasks to be marked done |

## CLI Commands

| Command | Alias | Description |
|---------|-------|-------------|
| `hooks` | `hooks interactive`, `hooks i` | Interactive hook browser (default) |
| `hooks install <names...>` | `hooks add` | Install one or more hooks |
| `hooks install --all` | | Install all 30 hooks |
| `hooks install --category <cat>` | | Install all hooks in a category |
| `hooks list` | `hooks ls` | List available hooks |
| `hooks list --registered` | `hooks list -r` | Show currently registered hooks |
| `hooks list --category <cat>` | `hooks list -c <cat>` | Filter by category |
| `hooks search <query>` | | Search hooks by name, description, or tags |
| `hooks info <name>` | | Show detailed info about a hook |
| `hooks remove <name>` | `hooks rm` | Unregister a hook |
| `hooks update [names...]` | | Re-register hooks (picks up new package version) |
| `hooks doctor` | | Check health of installed hooks |
| `hooks docs [name]` | | Show documentation (general or hook-specific) |
| `hooks categories` | | List all categories with counts |
| `hooks init` | | Register a new agent profile |
| `hooks run <name>` | | Execute a hook (called by AI agents) |
| `hooks mcp` | | Start MCP server (SSE or `--stdio`) |
| `hooks upgrade` | | Self-update to latest version |

### Scope Options

Most commands accept scope flags:

| Flag | Description |
|------|-------------|
| `--global`, `-g` | Global scope (`~/.claude/settings.json`) -- default |
| `--project`, `-p` | Project scope (`.claude/settings.json`) |
| `--json`, `-j` | Machine-readable JSON output |
| `--profile <id>` | Agent profile ID to scope hooks to |
| `--overwrite`, `-o` | Overwrite existing hook registration |

## MCP Server

Start the MCP server for AI agent integration:

```bash
# Stdio transport (for agent MCP registration)
hooks mcp --stdio

# SSE transport (default, port 39427)
hooks mcp
hooks mcp --port 8080
```

### Registration

Add to `~/.claude/mcp.json` or equivalent agent config:

```json
{
  "mcpServers": {
    "hooks": {
      "command": "hooks",
      "args": ["mcp", "--stdio"]
    }
  }
}
```

### MCP Tools (13)

| Tool | Description |
|------|-------------|
| `hooks_list` | List all available hooks, optionally filtered by category |
| `hooks_search` | Search for hooks by name, description, or tags |
| `hooks_info` | Get detailed information about a specific hook including install status |
| `hooks_install` | Install one or more hooks by name |
| `hooks_install_category` | Install all hooks in a category |
| `hooks_install_all` | Install all available hooks |
| `hooks_remove` | Remove (unregister) a hook from agent settings |
| `hooks_doctor` | Check health of installed hooks |
| `hooks_categories` | List all hook categories with counts |
| `hooks_docs` | Get documentation (general overview or hook-specific README) |
| `hooks_registered` | Get list of currently registered hooks for a scope |
| `hooks_init` | Register a new agent profile |
| `hooks_profiles` | List all registered agent profiles |

## Agent Profiles

Agents can register a profile to get a unique 8-char UUID. This identity is injected into hook input when running with `--profile`.

```bash
# Register a profile
hooks init --agent claude --name "my-agent"
# Agent profile created
#   Agent ID:   a1b2c3d4
#   Type:       claude

# Install hooks scoped to a profile
hooks install gitguard --profile a1b2c3d4

# The registered settings entry becomes:
#   hooks run gitguard --profile a1b2c3d4
```

Profiles are stored at `~/.hooks/profiles/<agent_id>.json`.

## Library Usage

```typescript
import {
  HOOKS,
  CATEGORIES,
  searchHooks,
  getHook,
  getHooksByCategory,
  installHook,
  installHooks,
  getRegisteredHooks,
  removeHook,
  createProfile,
  listProfiles,
  type HookMeta,
  type Category,
} from "@hasna/hooks";

// Search for hooks
const securityHooks = searchHooks("security");

// Get hooks by category
const gitHooks = getHooksByCategory("Git Safety");

// Install a hook programmatically
const result = installHook("gitguard", { scope: "global" });

// Check what's registered
const registered = getRegisteredHooks("global");

// Create an agent profile
const profile = createProfile({ agent_type: "claude", name: "my-bot" });
```

## Writing a Custom Hook

Hooks follow a stdin/stdout JSON protocol. Create a new hook at `hooks/hook-<name>/`:

```
hooks/hook-myhook/
  src/
    hook.ts       # Main hook logic (stdin JSON -> stdout JSON)
  package.json
  README.md
```

### Hook Template (PreToolUse)

```typescript
#!/usr/bin/env bun
import { readFileSync } from "fs";

interface HookInput {
  session_id: string;
  cwd: string;
  tool_name: string;
  tool_input: Record<string, unknown>;
}

interface HookOutput {
  decision?: "approve" | "block";
  reason?: string;
}

// Read JSON from stdin
const input: HookInput = JSON.parse(readFileSync(0, "utf-8"));

// Your logic here
if (input.tool_name === "Bash") {
  const command = input.tool_input.command as string;
  if (command.includes("rm -rf /")) {
    console.log(JSON.stringify({ decision: "block", reason: "Dangerous command" }));
    process.exit(0);
  }
}

// Approve by default
console.log(JSON.stringify({ decision: "approve" }));
```

Key rules:
- Read from **stdin** (JSON), write to **stdout** (JSON)
- Log diagnostics to **stderr** only (stdout must be clean JSON)
- PreToolUse hooks return `{ "decision": "approve" | "block", "reason"?: string }`
- PostToolUse/Stop/Notification hooks return informational JSON (not blocking)

### Registering a Custom Hook

Add the hook to `src/lib/registry.ts` in the `HOOKS` array, then update `dashboard/src/data.ts` to keep the dashboard in sync.

## Configuration

Hooks are registered in `~/.claude/settings.json` (Claude) or `~/.gemini/settings.json` (Gemini):

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "Bash",
        "hooks": [
          { "type": "command", "command": "hooks run gitguard" }
        ]
      }
    ]
  }
}
```

Event names are mapped per agent:

| Internal Event | Claude Code | Gemini CLI |
|---------------|-------------|------------|
| PreToolUse | PreToolUse | BeforeTool |
| PostToolUse | PostToolUse | AfterTool |
| Stop | Stop | AfterAgent |
| Notification | Notification | Notification |

## Development

```bash
git clone https://github.com/hasna/hooks.git
cd hooks
bun install

bun run dev              # Run CLI in development (interactive mode)
bun run build            # Build CLI (bin/) + library (dist/)
bun run typecheck        # TypeScript type checking
bun test                 # Run all tests (592 tests, 1816+ assertions)

# Dashboard (separate Vite + React 19 app)
bun run dashboard:dev    # Dev server at localhost:5173
bun run dashboard:build  # Production build to dashboard/dist/
```

## Architecture

```
src/
  cli/          Commander.js CLI + React/Ink interactive TUI
    components/   App, Header, CategorySelect, HookSelect, SearchView, DataTable, InstallProgress
    index.tsx     CLI entry point (all commands)
  lib/          Core logic
    registry.ts   Hook metadata registry (HOOKS array, categories, search)
    installer.ts  Hook registration in agent settings files
    profiles.ts   Agent profile identity system
  mcp/          MCP server (stdio + SSE transport, 13 tools)
    server.ts     Tool definitions and transport setup
  hooks/        Hook runtime test
  index.ts      Library re-exports

hooks/          30 hook implementations
  hook-gitguard/
    src/hook.ts   Main hook logic (stdin -> stdout)
    package.json
    README.md
  hook-branchprotect/
  hook-checkpoint/
  ...

dashboard/      Web dashboard (Vite + React 19 + TailwindCSS 4)
  src/data.ts   Static copy of hook metadata (sync with registry.ts)
```

### Build Outputs

Two separate `bun build` invocations:
- **CLI binary** (`bin/index.js`) -- Commander.js + Ink/React interactive UI
- **Library** (`dist/index.js` + `dist/index.d.ts`) -- Registry + installer + profile APIs

## License

[Apache License 2.0](LICENSE)
