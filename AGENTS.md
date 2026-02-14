# AGENTS.md

Guidance for AI agents working with this repository.

## Overview

This is `@hasna/hooks`, an open-source monorepo of Claude Code hooks providing CLI installation and management of 15+ lifecycle hooks.

## Quick Commands

```bash
bun install          # Install dependencies
bun run dev          # Run CLI
bun run build        # Build
bun run typecheck    # Type check
```

## Adding Hooks

1. Copy to `hooks/hook-{name}/`
2. Ensure it follows the standard hook pattern (stdin JSON → stdout JSON)
3. Remove any internal references (hasnaxyz, etc.)
4. Verify no secrets or API keys are committed
5. Update `src/lib/registry.ts` to include the hook

## Structure

```
hooks/hook-{name}/
├── src/
│   ├── hook.ts      # Main hook logic
│   ├── cli.ts       # CLI commands
│   └── index.ts     # Exports
├── package.json
├── CLAUDE.md
└── README.md
```

## Hook Events

| Event | Timing | Can Block | Use Case |
|-------|--------|-----------|----------|
| PreToolUse | Before tool | Yes | Security, safety guards |
| PostToolUse | After tool | No | Quality checks, async tasks |
| Stop | Session end | No | Notifications, cleanup |
| Notification | On notify | No | Context management |

## Security Checks

Before committing any hook:
- [ ] No hardcoded API keys/tokens
- [ ] No internal references (hasnaxyz)
- [ ] Uses `@hasna` namespace for public packages
- [ ] .env.example has placeholders only
