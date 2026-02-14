# hook-packageage

Claude Code hook that checks package age before install to warn on outdated or abandoned packages.

## Overview

Before `npm install`, `bun add`, `yarn add`, or `pnpm add`, this hook checks each package against the npm registry and warns if packages are stale (>1 year) or potentially abandoned (>2 years).

## Installation

```bash
bun install -g @hasna/hook-packageage
hook-packageage install
```

## Commands

```bash
hook-packageage install       # Install to Claude Code settings
hook-packageage uninstall     # Remove hook
hook-packageage status        # Check installation
hook-packageage check <pkg>   # Manually check a package
```

## Thresholds

- **>1 year** since last publish: STALE warning
- **>2 years** since last publish: ABANDONED warning
- **Deprecated** packages: always warned

## License

Apache-2.0
