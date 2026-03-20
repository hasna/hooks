# hook-failure-to-task

A PostToolUse hook that automatically creates a todo task whenever a test or build command fails. Keeps a visible record of failures so nothing gets forgotten.

## Installation

```bash
hooks install failure-to-task
```

## How it works

After every Bash tool execution:
1. Checks if the command is a test/build command (`bun test`, `npm test`, `tsc`, etc.)
2. If the exit code is non-zero → creates a task with the error details
3. Always approves (non-blocking)

## Task creation

Tasks are created via the `todos` CLI if installed. Falls back to `~/.hooks/tasks/<id>.json`.

Task format:
- **Title**: `Fix failing \`bun test\` in my-project`
- **Priority**: high
- **Tags**: `failure`, `tests` or `build`
- **Description**: includes command, exit code, and error snippet

## Detected commands

| Pattern | Category |
|---------|----------|
| `bun test`, `npm test`, `yarn test`, `pnpm test` | tests |
| `pytest`, `jest`, `vitest` | tests |
| `bun build`, `npm run build`, `yarn build` | build |
| `tsc`, `bunx tsc` | build |
| `bun run typecheck`, `npm run typecheck` | build |

## Event

- **PostToolUse** (matcher: `Bash`)
