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

Hook event *ingestion* follows the same routing: in API mode the observability
hooks (`commandlog`, `sessionlog`, `costwatch`, `errornotify`) `POST` each event
to `/v1/log/events` on the configured authority, so `hooks log tail` sees the
events this machine just produced. If the authority is unreachable, incompletely
configured, or does not answer within the write deadline, the event is spooled
into the local SQLite database rather than dropped, and a warning is written to
stderr. Drain the spool with `hooks storage push` — rows are upserted by event
id, so draining is idempotent.

Because that spool is also the mirror `hooks storage pull` writes into, `hooks
log clear` in API mode deletes on the authority *and* in the local database. A
purge that stopped at the authority would be undone by the next `hooks storage
push`, which uploads whatever the local file still holds. Both stores are
reported: `cleared_remote` and `cleared_local` name the per-store counts and
`cleared` is the larger of the two, so clearing an unpushed spool the authority
never saw can never be reported as "nothing to clear". (`cleared` is the larger
count rather than their sum because a pulled event exists in both stores and
must not be counted twice.)

The MCP log tools (`hooks_log_list`, `hooks_log_tail`, `hooks_log_errors`,
`hooks_log_summary`) route exactly like the `hooks log` commands: the authority
in API mode, local SQLite in local mode, and a tool error rather than a stale
local answer when an API authority is configured but cannot be reached.

Every `/v1` request carries a deadline, so a hung authority can never block an
agent's tool call: hook event writes default to 3s
(`HASNA_HOOKS_API_WRITE_TIMEOUT_MS`, fallback `HOOKS_API_WRITE_TIMEOUT_MS`) and
interactive `hooks log` / `hooks storage` commands default to 30s
(`HASNA_HOOKS_API_TIMEOUT_MS`, fallback `HOOKS_API_TIMEOUT_MS`).

The `/v1` transport carries data tables only — `hook_events` and `feedback`.
`schema_migrations` and `_meta` are per-database bookkeeping and are never
exported, imported, or accepted by `/v1/storage/import`: replicating a peer's
migration ledger would let a machine on a newer release mark a migration as
applied on an authority that never ran its DDL, permanently suppressing it.

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
fallback for API-routed commands. In `remote`/`hybrid` mode the HTTP transport
is chosen only when `HASNA_HOOKS_API_URL` is set — an API key on its own never
diverts those modes away from PostgreSQL — and configuring both a database URL
and an API URL prints a precedence warning.

### Serving the API

`hooks mcp --http` serves only the shared MCP endpoint at `/mcp`. The Hooks
`/v1` data API reads and can delete hook event history, so it is opt-in:

```bash
HASNA_HOOKS_API_SERVER_KEY=... hooks mcp --http --api
```

`HASNA_HOOKS_API_SERVER_KEY` (fallback `HOOKS_API_SERVER_KEY`) is the credential
this process accepts on `/v1`. It is deliberately separate from the client-side
`HASNA_HOOKS_API_KEY` that the CLI presents to a remote authority, so one secret
never serves both trust roles. Without a server key the `/v1` data routes fail
closed with HTTP 503.

## Runtime model

This package is an npm/local CLI, MCP server, and static dashboard package. It
does not require a deployed cloud or self-hosted runtime to install or run hooks.

## Data Directory

Data is stored in `~/.hasna/hooks/`.

## License

Apache-2.0 -- see [LICENSE](LICENSE)
