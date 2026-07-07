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

## Storage

Hooks stores data locally by default in `~/.hasna/hooks/` and uses SQLite
directly for hook event history. The package owns its database schema and
migrations; it does not depend on the deprecated shared runtime or its CLI.
The repo includes its own PostgreSQL migration definitions for optional remote
storage deployments. Use the `hooks log` commands to inspect local hook event
data.

```bash
hooks storage status --json
HASNA_HOOKS_DATABASE_URL=postgres://... hooks storage push --tables hook_events,feedback --json
hooks storage pull --json
hooks storage sync --json
```

Configure database storage with `HASNA_HOOKS_DATABASE_URL` or fallback
`HOOKS_DATABASE_URL`. Optional storage mode env vars are
`HASNA_HOOKS_STORAGE_MODE` and `HOOKS_STORAGE_MODE`, with `local`, `hybrid`, or
`remote` values.

## Data Directory

Data is stored in `~/.hasna/hooks/`.

## License

Apache-2.0 -- see [LICENSE](LICENSE)
