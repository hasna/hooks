# CLAUDE.md

This file provides guidance to Claude Code when working with this repository.

## Project Overview

`@hasna/hooks` is an open-source monorepo of Claude Code hooks. It provides a CLI to install hooks into projects and register them in Claude settings.

## Build & Run Commands

```bash
# Install dependencies
bun install

# Run CLI in development
bun run dev

# Build for distribution
bun run build

# Type check
bun run typecheck
```

## Code Style

- TypeScript with strict mode
- ESM modules (`type: module`)
- Async/await for all async operations
- Minimal dependencies: commander, chalk, ink (for CLI)
- Type annotations required everywhere

## Project Structure

```
├── src/
│   ├── cli/           # Interactive CLI (Ink/React)
│   │   ├── components/
│   │   └── index.tsx
│   ├── lib/           # Core library
│   │   ├── installer.ts
│   │   └── registry.ts
│   └── index.ts       # Library exports
├── hooks/             # Individual hook packages
│   └── hook-*/        # Each hook
└── bin/               # Built CLI output
```

## Adding New Hooks

When adding hooks:

1. Copy to `hooks/hook-{name}/`
2. Update `src/lib/registry.ts` to include the hook
3. Ensure no secrets or API keys are committed
4. Follow the standard hook structure (src/hook.ts, src/cli.ts)

## Hook Events

- **PreToolUse**: Fires before tool execution, can block
- **PostToolUse**: Fires after tool execution, async
- **Stop**: Fires on session end, async
- **Notification**: Fires on notification events, async

## Dependencies

- commander: CLI argument parsing
- chalk: Terminal styling
- ink: React-based interactive CLI
- ink-select-input: Selection component for Ink
