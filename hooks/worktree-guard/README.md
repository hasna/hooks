# worktree-guard

Codewith-native hook installed as `hooks run worktree-guard`.

This hook is OSS-safe: optional Hasna CLIs are best-effort and missing CLIs fail open with concise warnings. Security gates only fail closed when a guarded commit/push scan runs successfully and finds possible secrets.

It blocks scoped destructive shell operations and file-tool-like payloads when
the resolved target threatens `~/.hasna`, configured workspace roots, Hasna
division/scope roots, or active repo/worktree roots.

## Install for Codewith

Prefer renderer-managed configuration through open-configs. @hasna/hooks can emit the TOML fragment:

```bash
hooks install worktree-guard --target codewith
```

## License

Apache-2.0
