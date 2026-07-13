# pre-bash

Codewith-native hook installed as `hooks run pre-bash`.

This hook is OSS-safe: optional Hasna CLIs are best-effort and missing CLIs fail open with concise warnings. Security gates only fail closed when a guarded commit/push scan runs successfully and finds possible secrets.

It also blocks scoped destructive shell operations such as `rm -rf` only when
the resolved target threatens `~/.hasna`, configured workspace roots, Hasna
division/scope roots, or active repo/worktree roots.

## Install for Codewith

Prefer renderer-managed configuration through open-configs. @hasna/hooks can emit the TOML fragment:

```bash
hooks install pre-bash --target codewith
```

## License

Apache-2.0
