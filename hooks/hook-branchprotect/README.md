# hook-branchprotect

Claude Code hook that prevents editing files on main/master branch.

## Overview

Forces a feature branch workflow by blocking all Write/Edit/NotebookEdit operations when the current git branch is `main` or `master`.

## Installation

```bash
bun install -g @hasna/hook-branchprotect
hook-branchprotect install
```

## How It Works

1. Intercepts Write/Edit/NotebookEdit tool calls (PreToolUse)
2. Checks the current git branch via `git rev-parse --abbrev-ref HEAD`
3. Blocks if on `main` or `master`, suggests creating a feature branch
4. Approves all operations on any other branch

## License

Apache-2.0
