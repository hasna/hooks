# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
bun install                        # Install dependencies
bun run build                      # Build CLI (bin/) + library (dist/)
bun run dev                        # Run CLI in development (interactive mode)
bun run typecheck                  # TypeScript type checking (tsc --noEmit)
bun test                           # Run all tests (592 tests, 1816+ assertions)
bun test src/lib/registry.test.ts  # Run a single test file
bun test --testNamePattern="searchHooks"  # Run tests matching pattern

# Dashboard (separate Vite + React 19 + TailwindCSS 4 app)
bun run dashboard:dev              # Dev server at localhost:5173
bun run dashboard:build            # Production build to dashboard/dist/
```

## Architecture

Lifecycle hooks library for AI coding agents (Claude Code, Gemini CLI) with four surfaces sharing a common registry and installer:

```
src/
  cli/              Commander.js CLI + React/Ink interactive TUI
    components/       App, Header, CategorySelect, HookSelect, SearchView, DataTable, InstallProgress
    index.tsx         CLI entry point — all 13 commands defined here
    cli.test.ts       CLI integration tests (subprocess spawning with temp settings)
  lib/              Core business logic
    registry.ts       Hook metadata registry — HOOKS array, CATEGORIES, search, getHook
    registry.test.ts  Registry unit tests
    installer.ts      Hook registration in agent settings files (Claude + Gemini)
    installer.test.ts Installer unit tests (filesystem mocking)
    profiles.ts       Agent profile identity system (~/.hooks/profiles/)
    profiles.test.ts  Profile unit tests
  mcp/              MCP server
    server.ts         13 tools over stdio or SSE transport (port 39427)
    server.test.ts    MCP tool integration tests
  hooks/            Hook runtime tests
    hooks.test.ts     End-to-end hook execution tests
  index.ts          Library re-exports (registry + installer + profiles)
  index.test.ts     Library export tests

hooks/              30 hook implementations (each a self-contained package)
  hook-gitguard/      Example structure for all hooks
    src/hook.ts         Main hook logic (stdin JSON -> stdout JSON)
    package.json        Package metadata
    README.md           Hook-specific documentation
    CLAUDE.md           Hook-specific agent guidance
    LICENSE             Apache-2.0
    tsconfig.json       TypeScript config
  hook-branchprotect/
  hook-checkpoint/
  ... (30 total)

dashboard/          Web dashboard (independent Vite app)
  src/data.ts         Static copy of hook data — must stay in sync with registry.ts
```

### Two Build Targets

The `build` script produces two separate bundles:
1. **CLI binary** (`bin/index.js`, ~200KB) -- Commander.js + Ink/React interactive UI. Externals (ink, react, chalk, conf, MCP SDK) are resolved at runtime from node_modules.
2. **Library** (`dist/index.js` + `dist/index.d.ts`, ~16KB) -- Re-exports registry + installer + profile APIs for programmatic use via `@hasna/hooks` imports.

## Key Patterns

### Hook Runtime Protocol

Hooks communicate via **stdin JSON -> stdout JSON**. The agent calls `hooks run <name>`, which spawns the hook as a separate bun process:

```
Agent -> stdin JSON (HookInput) -> hook.ts -> stdout JSON (HookOutput)
```

- **HookInput**: `{ session_id, cwd, tool_name, tool_input }` (with optional `agent` object when `--profile` is used)
- **HookOutput**: `{ decision: "approve"|"block", reason?: string }` (PreToolUse) or informational JSON (PostToolUse/Stop/Notification)
- Hooks log to **stderr** to avoid corrupting stdout JSON

### Multi-Agent Installer

`src/lib/installer.ts` manages hook registration in settings files:
- **Scope**: `"global"` (`~/.claude/settings.json`) or `"project"` (`.claude/settings.json`)
- **Target**: `"claude"`, `"gemini"`, or `"all"` -- event names mapped per agent
- Event mapping: `PreToolUse -> BeforeTool`, `PostToolUse -> AfterTool`, `Stop -> AfterAgent` (for Gemini)
- Hooks are **not copied** to projects; they run from the globally-installed `@hasna/hooks` package via `hooks run <name>`
- Overwrite detection: checks if hook is already registered before installing

### Registry

`src/lib/registry.ts` is the **single source of truth** for all hook metadata. The `HOOKS` array and `CATEGORIES` constant drive the CLI, MCP server, dashboard, and tests. When adding a hook, this file must be updated first.

### Agent Profiles

`src/lib/profiles.ts` manages agent identity:
- Stored at `~/.hooks/profiles/<agent_id>.json`
- 8-char UUID generated via `crypto.randomUUID().slice(0, 8)`
- Profile data injected into HookInput when hooks run with `--profile <id>`
- `touchProfile()` updates `last_seen_at` on each hook execution

### Naming Conventions

- Hook names are **kebab-case without the `hook-` prefix** in the registry (e.g., `"gitguard"` not `"hook-gitguard"`)
- The installer normalizes names: `getHookPath("gitguard")` resolves to `hooks/hook-gitguard/`
- Hook directories always use the `hook-` prefix: `hooks/hook-<name>/`
- CLI version is read dynamically from `package.json` (not hardcoded)

## Data Model

### HookMeta (registry.ts)

```typescript
interface HookMeta {
  name: string;         // Short name: "gitguard"
  displayName: string;  // Human name: "Git Guard"
  description: string;  // One-line description
  version: string;      // Semver: "0.1.0"
  category: string;     // One of 10 CATEGORIES
  event: "PreToolUse" | "PostToolUse" | "Stop" | "Notification";
  matcher: string;      // Tool name pattern or "" for all tools
  tags: string[];       // Search tags
}
```

### 10 Categories

```typescript
const CATEGORIES = [
  "Git Safety",           // 3 hooks
  "Code Quality",         // 6 hooks
  "Security",             // 2 hooks
  "Notifications",        // 5 hooks
  "Context Management",   // 2 hooks
  "Workflow Automation",  // 3 hooks
  "Environment",          // 1 hook
  "Permissions",          // 3 hooks
  "Observability",        // 4 hooks
  "Agent Teams",          // 1 hook
] as const;               // Total: 30 hooks
```

### AgentProfile (profiles.ts)

```typescript
interface AgentProfile {
  agent_id: string;              // 8-char UUID
  agent_type: "claude" | "gemini" | "custom";
  name?: string;                 // Optional display name
  created_at: string;            // ISO timestamp
  last_seen_at: string;          // Updated on each hook run
  preferences: Record<string, unknown>;
}
```

## Hook Events

| Event | Timing | Can Block | Matcher |
|-------|--------|-----------|---------|
| PreToolUse | Before tool execution | Yes (`decision: "block"`) | Tool name pattern (e.g., `"Bash"`, `"Write\|Edit"`) |
| PostToolUse | After tool execution | No | Tool name pattern |
| Stop | Session end | No | Empty string |
| Notification | System events (e.g., compaction) | No | Empty string |

## MCP Server Tools (13)

| Tool | Parameters | Description |
|------|-----------|-------------|
| `hooks_list` | `category?` | List hooks, optionally filtered by category |
| `hooks_search` | `query` | Search hooks by name, description, or tags |
| `hooks_info` | `name` | Get detailed hook info including install status |
| `hooks_install` | `hooks[], scope?, overwrite?, profile?` | Install hooks by name |
| `hooks_install_category` | `category, scope?, overwrite?` | Install all hooks in a category |
| `hooks_install_all` | `scope?, overwrite?` | Install all 30 hooks |
| `hooks_remove` | `name, scope?` | Remove a hook from settings |
| `hooks_doctor` | `scope?` | Check health of installed hooks |
| `hooks_categories` | (none) | List categories with counts |
| `hooks_docs` | `name?` | Get documentation (general or hook-specific) |
| `hooks_registered` | `scope?` | List currently registered hooks |
| `hooks_init` | `agent_type?, name?` | Register a new agent profile |
| `hooks_profiles` | (none) | List all registered agent profiles |

Transport: stdio (for agent MCP integration) or SSE (port 39427, `/sse` endpoint).

## Hook Structure

Every hook follows a consistent structure inside `hooks/hook-<name>/`:

```
hooks/hook-<name>/
  src/
    hook.ts         # Main logic: reads stdin JSON, writes stdout JSON
    cli.ts          # Optional: per-hook CLI for install/uninstall/status
    index.ts        # Optional: library exports
  package.json      # @hasna/hook-<name> package metadata
  README.md         # Hook documentation
  CLAUDE.md         # Optional: agent guidance for this hook
  tsconfig.json     # TypeScript config
  LICENSE           # Apache-2.0
```

Not all hooks have all optional files. The minimum required files are `src/hook.ts` and `package.json`.

## Testing

Tests use Bun's built-in test runner across 7 test files:

| File | Tests | Description |
|------|------:|-------------|
| `src/lib/registry.test.ts` | Registry | HOOKS array integrity, search, category filtering |
| `src/lib/installer.test.ts` | Installer | Hook registration, scope handling, overwrite logic |
| `src/lib/profiles.test.ts` | Profiles | Create, read, update, delete, touch |
| `src/mcp/server.test.ts` | MCP | All 13 tools via in-memory MCP client |
| `src/cli/cli.test.ts` | CLI | Subprocess integration tests with temp settings files |
| `src/hooks/hooks.test.ts` | Hooks | End-to-end hook execution (stdin/stdout protocol) |
| `src/index.test.ts` | Library | Export verification |

Run with: `bun test` (592 tests, 1816+ assertions, ~24s)

## Adding a New Hook

1. Create `hooks/hook-<name>/` with at minimum `src/hook.ts` and `package.json`
2. Hook must read stdin JSON (`HookInput`), return stdout JSON (`HookOutput`) -- use `hooks/hook-gitguard/src/hook.ts` as reference
3. Add entry to `HOOKS` array in `src/lib/registry.ts` with all fields: `name`, `displayName`, `description`, `version`, `category`, `event`, `matcher`, `tags`
4. Update `dashboard/src/data.ts` to match the new registry entry
5. Run `bun test` to verify registry integrity tests pass

## TypeScript

Strict mode with `declaration: true`. JSX uses `react-jsx` transform for Ink components. Build target is ES2022 with bundler module resolution.
