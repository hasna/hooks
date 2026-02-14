# hook-taskgate

Claude Code hook that validates task completion before allowing a task to be marked done.

## Event

**TaskCompleted** — fires when Claude attempts to mark a task as complete.

## What It Does

A lightweight gate that checks whether a task is actually done:

- **Task mentions "test" or "tests"** — verifies that test files exist in the project (looks for `*.test.*`, `*.spec.*`, `test_*`, `*_test.*`, or `test/`/`tests/`/`__tests__/` directories)
- **Task mentions "lint" or "format"** — approves (cannot verify externally)
- **All other tasks** — approves by default

This hook is designed as a starting point. Extend the validation logic in `src/hook.ts` for your own project needs.

## Installation

Add to your `.claude/settings.json`:

```json
{
  "hooks": {
    "TaskCompleted": [
      {
        "matcher": "",
        "hooks": [
          {
            "type": "command",
            "command": "bun run hooks/hook-taskgate/src/hook.ts"
          }
        ]
      }
    ]
  }
}
```

## Output

- `{ "decision": "approve" }` — task passes validation
- `{ "decision": "block", "reason": "..." }` — task fails validation, provides reason

## Extending

To add custom validation, edit `src/hook.ts` and add checks in the `run()` function before the default approve. For example:

```typescript
// Block tasks mentioning "deploy" unless a deploy script exists
if (/\bdeploy\b/.test(description)) {
  if (!existsSync(join(cwd, "deploy.sh"))) {
    respond({ decision: "block", reason: "No deploy.sh found" });
    return;
  }
}
```

## License

MIT
