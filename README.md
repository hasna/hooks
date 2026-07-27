# @hasna/hooks

Open source hooks library for AI coding agents - Install safety, quality, and automation hooks with a single command

[![npm](https://img.shields.io/npm/v/@hasna/hooks)](https://www.npmjs.com/package/@hasna/hooks)
[![License](https://img.shields.io/badge/license-Apache--2.0-blue)](LICENSE)

## Install

```bash
npm install -g @hasna/hooks
```

## CLI Usage

```bash
hooks --help
```

- `hooks install`
- `hooks list`
- `hooks search`
- `hooks remove`
- `hooks categories`
- `hooks info`
- `hooks doctor`
- `hooks run`

## Compact Output

CLI commands default to compact, agent-friendly output. List and search commands
show essential fields, cap terminal rows, and print hints for deeper inspection.
Use detail flags when you need more context:

```bash
hooks list                  # compact, capped list
hooks list --all            # show all rows
hooks list --verbose        # include descriptions
hooks search git --limit 5  # cap result rows
hooks info gitguard         # full metadata for one hook
hooks docs gitguard         # README preview
hooks docs gitguard --verbose
hooks list --json           # stable machine-readable full data
```

MCP tools follow the same gradual disclosure pattern: list/search/log/profile
tools return compact summaries by default, while explicit flags such as
`compact:false`, `verbose:true`, or a detail tool like `hooks_info` return full
records.

## Codewith-native hooks

@hasna/hooks includes unprefixed Codewith-native hook names:

- `session-start` — `SessionStart` digest and additional context.
- `prompt-guard` — `UserPromptSubmit` guard for pasted fake policy/freeze/run-this-now content.
- `pre-bash` — `PreToolUse` Bash gate for staged secrets scans, scoped destructive-operation blocks, and risky-op comms checks.
- `worktree-guard` — `PreToolUse` guard for managed repos worktree boundaries and file-tool-like payloads touching protected Hasna scopes.
- `stop-sync` — `Stop` turn-end heartbeat/evidence best effort.
- `knowledge-context` — deterministic Knowledge context packs for `SessionStart`, `UserPromptSubmit`, and `SubagentStart`.

For Codewith, the installer is renderer-safe by default: it emits a TOML
fragment instead of mutating managed `~/.codewith/config.toml`.

```bash
hooks install session-start prompt-guard pre-bash worktree-guard stop-sync knowledge-context --target codewith
```

The scoped destructive-operation guard does not block every cleanup command. It
blocks resolved shell/file-tool targets that threaten `/` or a system root
(`/usr`, `/etc`, `/bin`, `/lib`, `/var`, `/boot`, `/home`, `/Users`, and the
other FHS and macOS equivalents), `~/.hasna`, configured workspace roots, Hasna
division/scope roots, or active repo/worktree roots, including recursive `rm`,
`rsync --delete`, destructive `find`, and destructive `git clean` / `git reset
--hard` forms.

It also blocks by *shape*: a destructive target containing a command
substitution or variable expansion immediately followed by `/` is checked as the
shell would render it if that expansion returned empty, so
`rm -rf "$(anything)"/*` and `rm -rf "$VAR"/*` are refused whatever the
expansion is. Wrapped forms (`bash -c`, `su -c`, `eval`, `ssh host '…'`) are
unwrapped first. See [`hooks/pre-bash/README.md`](hooks/pre-bash/README.md) for
the full rules, the deliberate exemptions (`${VAR:?}`, bare `"$(cmd)"` with no
trailing separator), and the recommended safe form.

Apply that fragment through `open-configs` or the managed config renderer. A
direct write path exists only for explicit local/test use:

```bash
hooks install knowledge-context --target codewith --apply-codewith --codewith-config /tmp/codewith-config.toml
```

## Storage

Hooks stores data locally by default in `~/.hasna/hooks/` and uses SQLite
directly for hook event history. The package owns its database schema and
migrations; it does not depend on the deprecated shared runtime or its CLI.
The repo includes its own PostgreSQL migration definitions for optional remote
storage deployments. Use the `hooks log` commands to inspect hook event data.
In local mode they read SQLite; in explicit API mode they use the authenticated
Hooks `/v1` HTTP authority instead of falling back to local files.

```bash
hooks storage status --json
HASNA_HOOKS_DATABASE_URL=postgres://... hooks storage push --tables hook_events,feedback --json
hooks storage pull --json
hooks storage sync --json

HASNA_HOOKS_STORAGE_MODE=api \
HASNA_HOOKS_API_URL=https://hooks.example \
HASNA_HOOKS_API_KEY=... \
hooks log list --json
```

Configure database storage with `HASNA_HOOKS_DATABASE_URL` or fallback
`HOOKS_DATABASE_URL`. Optional storage mode env vars are
`HASNA_HOOKS_STORAGE_MODE` and `HOOKS_STORAGE_MODE`, with `local`, `hybrid`, or
`remote` values for SQLite/PostgreSQL sync. For the HTTP API backend, set
`HASNA_HOOKS_STORAGE_MODE=api` (or `self_hosted`/`cloud`) plus
`HASNA_HOOKS_API_URL` and `HASNA_HOOKS_API_KEY`. API mode disables local
fallback for API-routed commands. The existing `hooks mcp --http` server exposes
the shared MCP endpoint at `/mcp` and the Hooks API routes under `/v1`.

## Runtime model

This package is an npm/local CLI, MCP server, and static dashboard package. It
does not require a deployed cloud or self-hosted runtime to install or run hooks.

## Data Directory

Data is stored in `~/.hasna/hooks/`.

## License

Apache-2.0 -- see [LICENSE](LICENSE)
