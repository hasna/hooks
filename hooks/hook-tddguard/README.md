# hook-tddguard

Claude Code hook that enforces Test-Driven Development by blocking implementation file edits unless a corresponding test file exists.

## Overview

Before allowing edits to implementation files, this hook checks whether a corresponding test file exists. If no test file is found, the edit is blocked with a message to write tests first.

## Event

- **PreToolUse** (matcher: `Edit|Write`)

## Behavior

- **Test files** (`*.test.ts`, `*.spec.ts`, `*_test.py`, `test_*.py`, `*_test.go`) are always approved
- **Config files** (`*.json`, `*.md`, `*.yml`, `*.yaml`, `*.toml`, `*.css`, `*.html`) are always approved
- **Implementation files** are checked for a corresponding test file:
  - Same directory: `foo.test.ts`, `foo.spec.ts`
  - `__tests__/` subdirectory
  - `tests/` subdirectory
  - Python: `test_foo.py`, `foo_test.py`
  - Go: `foo_test.go`
- If no test file exists, the edit is **blocked**

## Supported Languages

| Language | Test File Patterns |
|----------|--------------------|
| TypeScript/JavaScript | `*.test.ts`, `*.spec.ts`, `*.test.js`, `*.spec.js` |
| Python | `test_*.py`, `*_test.py` |
| Go | `*_test.go` |
| Java | `*Test.java` |
| Ruby | `*_test.rb`, `*_spec.rb` |

## Example

```
# Editing src/utils.ts without src/utils.test.ts existing:
# → BLOCKED: "Write tests first (TDD). No test file found for utils.ts."

# Editing src/utils.test.ts:
# → APPROVED (always)

# Editing src/utils.ts WITH src/utils.test.ts existing:
# → APPROVED
```

## License

Apache-2.0
