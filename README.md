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

## Cloud Sync

This package supports cloud sync via `@hasna/cloud`:

```bash
cloud setup
cloud sync push --service hooks
cloud sync pull --service hooks
```

## Data Directory

Data is stored in `~/.hasna/hooks/`.

## License

Apache-2.0 -- see [LICENSE](LICENSE)
