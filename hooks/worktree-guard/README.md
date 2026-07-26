# worktree-guard

Codewith-native hook installed as `hooks run worktree-guard`.

This hook is OSS-safe: optional Hasna CLIs are best-effort and missing CLIs fail open with concise warnings. Security gates only fail closed when a guarded commit/push scan runs successfully and finds possible secrets.

It blocks scoped destructive shell operations and file-tool-like payloads when
the resolved target threatens `~/.hasna`, configured workspace roots, Hasna
division/scope roots, or active repo/worktree roots.

## Canonical worktree path

Git work is expected to happen in a task-specific worktree at the canonical path
from Hasna Agent Operating Rules rule 8 (published by `@hasna/identities`):

```
$HOME/.hasna/repos/worktrees/<repo-name>/<worktree-name>
```

Repo name, then worktree name. Anything else is reported as unmanaged, with a
reason: a flat single-segment worktree directly under the worktrees root, a
station-id or machine segment in front of the repo name, and any deeper nesting
are all rejected. Subdirectories of a canonical worktree are accepted.

Override the worktrees root with `HASNA_REPOS_WORKTREES_ROOT`.

The pre-rule-8 station-id lease layout
(`<station-id>/<repo-slug>-<hex>/wt_<hex>`) is deprecated. It is never treated as
a compliant worktree, but it keeps its scoped `~/.hasna` write carve-out so that
worktrees created before rule 8 are not stranded mid-migration.

## Install for Codewith

Prefer renderer-managed configuration through open-configs. @hasna/hooks can emit the TOML fragment:

```bash
hooks install worktree-guard --target codewith
```

## License

Apache-2.0
