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
migrations; it does not depend on the deprecated shared runtime or its CLI. Use
the `hooks log` commands to inspect local hook event data.

## Data Directory

Data is stored in `~/.hasna/hooks/`.

## License

Apache-2.0 -- see [LICENSE](LICENSE)
