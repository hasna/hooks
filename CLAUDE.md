# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

`@hasna/hooks` is a monorepo of 30 hooks for AI coding agents (Claude Code, Gemini CLI). It provides:
- An interactive CLI (`hooks`) to browse, install, and manage hooks
- A programmatic library for embedding in tools
- An MCP server for agent-driven hook management
- A web dashboard for browsing hooks

## Commands

```bash
bun install                        # Install dependencies
bun run build                      # Build CLI (bin/) + library (dist/)
bun run dev                        # Run CLI in development (interactive mode)
bun run typecheck                  # TypeScript type checking
bun test                           # Run all tests (253 tests, 1023+ assertions)
bun test src/lib/registry.test.ts  # Run a single test file
bun test --testNamePattern="searchHooks"  # Run tests matching pattern

# Dashboard (separate Vite + React 19 + TailwindCSS 4 app)
bun run dashboard:dev              # Dev server at localhost:5173
bun run dashboard:build            # Production build to dashboard/dist/
```

## Architecture

### Two Build Targets

The `build` script produces two separate bundles:
1. **CLI binary** (`bin/index.js`, ~200KB) — Commander.js + Ink/React interactive UI. Externals (ink, react, chalk, conf, MCP SDK) are resolved at runtime from node_modules.
2. **Library** (`dist/index.js`, ~16KB) — Re-exports registry + installer APIs for programmatic use via `@hasna/hooks` imports.

### Hook Runtime Protocol

Hooks communicate via **stdin JSON → stdout JSON**. The agent calls `hooks run <name>`, which spawns the hook as a separate bun process:

```
Agent → stdin JSON (HookInput) → hook.ts → stdout JSON (HookOutput)
```

- **HookInput**: `{ session_id, cwd, tool_name, tool_input }`
- **HookOutput**: `{ decision: "approve"|"block", reason?: string }` (PreToolUse) or async info (PostToolUse/Stop/Notification)
- Hooks log to **stderr** to avoid corrupting JSON output

### Multi-Agent Installer

`src/lib/installer.ts` manages hook registration in settings files:
- **Scope**: `"global"` (~/.claude/settings.json) or `"project"` (.claude/settings.json)
- **Target**: `"claude"`, `"gemini"`, or `"all"` — event names are mapped per-agent (e.g., PreToolUse → BeforeTool for Gemini)
- Hooks are **not copied** to projects; they run from the globally-installed `@hasna/hooks` package via `hooks run <name>`

### Registry

`src/lib/registry.ts` is the single source of truth for all hook metadata. The `HOOKS` array and `CATEGORIES` constant drive the CLI, MCP server, dashboard, and tests. When adding a hook, this file must be updated.

### MCP Server

`src/mcp/server.ts` exposes 11 tools over stdio or SSE (port 39427) so agents can install/manage hooks programmatically without the CLI.

### Dashboard

`dashboard/` is an independent Vite app (React 19, TailwindCSS 4, TanStack Table, Radix UI). It uses a **static copy** of hook data in `dashboard/src/data.ts` — this must be kept in sync with `src/lib/registry.ts`.

## Adding New Hooks

1. Create `hooks/hook-{name}/` with: `src/hook.ts` (runtime), optional `src/cli.ts`, `package.json`, `README.md`
2. Hook must read stdin JSON, return stdout JSON — use `hooks/hook-gitguard/src/hook.ts` as reference
3. Add entry to `HOOKS` array in `src/lib/registry.ts` with all fields (name, displayName, description, version, category, event, matcher, tags)
4. Update `dashboard/src/data.ts` to match

## Hook Events

| Event | Timing | Can Block | Matcher |
|-------|--------|-----------|---------|
| PreToolUse | Before tool execution | Yes (`decision: "block"`) | Tool name pattern (e.g., `"Bash"`, `"Write\|Edit"`) |
| PostToolUse | After tool execution | No | Tool name pattern |
| Stop | Session end | No | Empty string |
| Notification | System events (e.g., compaction) | No | Empty string |

## Key Conventions

- All packages use `@hasna` npm namespace with `Apache-2.0` license
- Version in CLI is read dynamically from `package.json` (not hardcoded)
- Hook names are kebab-case without the `hook-` prefix in the registry (e.g., `"gitguard"` not `"hook-gitguard"`)
- The installer normalizes names: `getHookPath("gitguard")` resolves to `hooks/hook-gitguard/`
