# hook-typecheck-gate

A Stop hook that runs TypeScript type checking before Claude finishes. Blocks the session if type errors are found, forcing Claude to fix them first.

## Installation

```bash
hooks install typecheck-gate
```

## How it works

On every `Stop` event:
1. Detects the TypeScript check command (from `package.json` scripts or `tsconfig.json`)
2. Runs the command
3. If it passes → allows Claude to stop
4. If it fails → blocks stop with error details, forcing Claude to fix them

## Configuration

Add to `~/.claude/settings.json` or `.claude/settings.json`:

```json
{
  "typecheckGateConfig": {
    "enabled": true,
    "command": "bun run typecheck"
  }
}
```

| Option | Default | Description |
|--------|---------|-------------|
| `enabled` | `true` | Enable/disable the hook |
| `command` | auto-detect | Override the typecheck command |

## Auto-detection

If no `command` is configured, the hook detects the right command:
1. Checks `package.json` scripts: `typecheck`, `type-check`, `tsc`, `build:types`
2. Falls back to `bunx tsc --noEmit` if `tsconfig.json` exists
3. Skips silently if no TypeScript project detected

## Event

- **Stop** — runs after Claude finishes each response
