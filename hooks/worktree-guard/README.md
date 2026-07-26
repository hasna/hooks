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

The classification is grounded in the filesystem, not in path shape alone: the
two-segment path must really be a git worktree root, and no segment may be a
symlink. Otherwise `<root>/<flat-worktree>/<subdir>` — which has exactly the
canonical shape — would launder a forbidden flat worktree into a compliant one,
and a symlinked segment could aim a compliant-looking path at a shared checkout.

Override the worktrees root with `HASNA_REPOS_WORKTREES_ROOT`.

## Deprecated: the station-id lease layout

The pre-rule-8 layout `<station-id>/<repo-slug>-<hex>/wt_<hex>` is deprecated and
is never classified as a compliant worktree. Two migration tolerances keep
existing worktrees working while they are re-homed:

- git work there warns instead of being blocked, so in-flight tasks can still land;
- it keeps its scoped `~/.hasna` write carve-out.

Both are temporary. Re-home these worktrees to the canonical path; the tolerances
will be removed once the layout is gone.

## Install for Codewith

Prefer renderer-managed configuration through open-configs. @hasna/hooks can emit the TOML fragment:

```bash
hooks install worktree-guard --target codewith
```

## License

Apache-2.0
