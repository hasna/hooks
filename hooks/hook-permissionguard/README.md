# hook-permissionguard

Claude Code hook that auto-approves safe read-only commands and blocks dangerous patterns.

## Overview

Reduces permission prompts for safe commands while blocking truly dangerous operations. Commands that don't match either list pass through normally.

## Hook Event

- **PreToolUse** (matcher: `Bash`)

## Auto-Approved Commands

Read-only commands that are always safe:

| Category | Commands |
|----------|----------|
| Git (read-only) | `git status`, `git log`, `git diff`, `git branch`, `git show`, `git tag` |
| File reading | `ls`, `cat`, `head`, `tail`, `wc`, `find`, `grep`, `rg`, `pwd` |
| Testing | `npm test`, `bun test`, `pytest`, `cargo test`, `go test`, `jest`, `vitest` |
| Package listing | `npm list`, `bun pm ls`, `pip list`, `cargo tree` |
| Version checks | `node -v`, `bun -v`, `python --version`, `cargo --version`, etc. |

**Note**: Piped commands (`cmd | cmd`), chained commands (`cmd && cmd`), and semicolon-separated commands (`cmd; cmd`) are never auto-approved, even if individual parts are safe.

## Blocked Commands

Dangerous patterns that are always blocked:

| Pattern | Reason |
|---------|--------|
| `rm -rf /`, `rm -rf ~`, `rm -rf $HOME` | Destructive deletion |
| `:(){ :\|:& };:` | Fork bomb |
| `dd if=`, `mkfs.`, `fdisk` | Disk destruction |
| `curl \| sh`, `wget \| sh` | Remote code execution |
| `chmod 777`, `chmod -R 777` | Insecure permissions |
| `shutdown`, `reboot` | System control |

## Behavior

1. Checks command against dangerous patterns — blocks if matched
2. Checks command against safe allowlist — auto-approves if matched
3. Everything else: approves (passes through to Claude's normal permission flow)

## License

MIT
