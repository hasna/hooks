# hook-affected-tests

A PostToolUse hook that automatically finds and runs test files affected by edits. After every Edit/Write, it discovers related tests and runs them immediately so you catch regressions fast.

## Installation

```bash
hooks install affected-tests
```

## How it works

After every `Edit`, `Write`, or `NotebookEdit`:
1. Gets the edited file path
2. Looks for matching test files using standard conventions
3. Runs found tests using `bun test <file>`
4. Logs pass/fail summary to stderr

## Test file discovery

| Source file | Candidates checked |
|-------------|-------------------|
| `src/foo.ts` | `src/foo.test.ts`, `src/foo.spec.ts` |
| `src/lib/bar.ts` | `src/lib/bar.test.ts`, `src/lib/__tests__/bar.test.ts`, `test/lib/bar.test.ts` |
| `components/X.tsx` | `components/X.test.tsx`, `components/__tests__/X.test.tsx` |

If no test files are found, the hook approves silently.

## Behavior

- Editing test files themselves does **not** trigger re-running them (avoids loops)
- Tests run synchronously before approving the next tool use
- Failures are logged to stderr but do **not** block

## Event

- **PostToolUse** (matcher: `Edit|Write|NotebookEdit`)
