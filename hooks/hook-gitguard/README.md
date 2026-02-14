# hook-gitguard

Claude Code hook that blocks destructive git operations.

## Overview

Prevents Claude from running irreversible git commands like `git reset --hard`, `git push --force`, `git checkout .`, `git clean -f`, and more.

## Installation

```bash
bun install -g @hasna/hook-gitguard
hook-gitguard install
```

## Blocked Operations

- `git reset --hard` — discards all uncommitted changes
- `git push --force` / `-f` — overwrites remote history
- `git checkout .` / `git checkout -- .` — discards working directory
- `git restore .` — discards working directory changes
- `git clean -f` — removes untracked files permanently
- `git branch -D` — force deletes branch without merge check
- `git stash drop` / `clear` — permanently deletes stash entries
- `git reflog expire` / `delete` — destroys recovery points
- `git gc --prune=now` — permanently removes unreachable objects

## License

Apache-2.0
