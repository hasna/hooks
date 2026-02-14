# hook-protectfiles

Claude Code hook that blocks access to sensitive files like `.env`, secrets, keys, and lock files.

## Overview

Prevents Claude from reading or modifying files that contain secrets, credentials, or are auto-generated (lock files). Protects across all tool types — file operations and bash commands.

## Hook Event

- **PreToolUse** (matcher: `Edit|Write|Read|Bash`)

## Protected Files

### Always Blocked (Read + Write)

| Pattern | Description |
|---------|-------------|
| `.env`, `.env.*` | Environment variable files |
| `.secrets/` | Secrets directory |
| `credentials.json` | Credential files |
| `*.pem`, `*.key`, `*.p12`, `*.pfx` | SSL/TLS certificates and keys |
| `id_rsa`, `id_ed25519`, `id_ecdsa` | SSH keys |
| `.ssh/` | SSH directory |
| `.aws/credentials` | AWS credentials |
| `.npmrc` | npm config (may contain tokens) |
| `.netrc` | Network credentials |
| `*.keystore`, `*.jks` | Java keystores |

### Write-Only Block (Read is OK)

| Pattern | Description |
|---------|-------------|
| `package-lock.json` | npm lock file |
| `yarn.lock` | Yarn lock file |
| `bun.lock`, `bun.lockb` | Bun lock files |
| `pnpm-lock.yaml` | pnpm lock file |
| `Gemfile.lock` | Ruby lock file |
| `poetry.lock` | Poetry lock file |
| `Cargo.lock` | Rust lock file |
| `composer.lock` | PHP lock file |

## Tool Coverage

| Tool | Check Method |
|------|-------------|
| `Read` | Checks `tool_input.file_path` against protected patterns |
| `Edit` | Checks `tool_input.file_path` against protected + lock patterns |
| `Write` | Checks `tool_input.file_path` against protected + lock patterns |
| `Bash` | Scans command string for references to protected files |

## Bash Command Intelligence

For Bash commands, the hook:
- Allows git commands that naturally reference `.env` (e.g., `git add .gitignore` where `.env` appears)
- Blocks direct file access (`cat .env`, `cp .secrets/`, etc.)
- Blocks redirects to lock files (`> package-lock.json`)
- Blocks sed/awk modifications to lock files

## License

MIT
