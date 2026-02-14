# hook-autoformat

Claude Code hook that automatically runs the project's formatter after file edits.

## Overview

Detects and runs the appropriate formatter whenever Claude edits or writes a file. No configuration needed — it reads your project's existing formatter config.

## Supported Formatters

| Config File | Formatter | File Types |
|-------------|-----------|------------|
| `.prettierrc` / `prettier` in package.json | Prettier | JS, TS, CSS, HTML, MD, JSON, YAML, etc. |
| `biome.json` | Biome | JS, TS, JSON, CSS, GraphQL |
| `pyproject.toml` with `[tool.ruff]` | Ruff | Python |
| `pyproject.toml` with `[tool.black]` | Black | Python |
| `.clang-format` | clang-format | C, C++, Obj-C |
| (any `.go` file) | gofmt | Go |

## Hook Event

- **PostToolUse** (matcher: `Edit|Write`)

## Behavior

1. Fires after every `Edit` or `Write` tool call
2. Reads `tool_input.file_path` to get the edited file
3. Detects the project formatter from config files in the working directory
4. Runs the formatter as a subprocess
5. Logs the result to stderr
6. Always outputs `{ continue: true }`

## Priority

If both Biome and Prettier configs exist, Biome takes priority (it's faster).

## License

MIT
