# worktree-guard

Codewith-native hook installed as `hooks run worktree-guard`.

This hook is OSS-safe: optional Hasna CLIs are best-effort and missing CLIs fail open with concise warnings. Security gates only fail closed when a guarded commit/push scan runs successfully and finds possible secrets.

It blocks scoped destructive shell operations and file-tool-like payloads when
the resolved target threatens `/` or a system root (`/usr`, `/etc`, `/var`,
`/home`, …), `~/.hasna`, configured workspace roots, Hasna division/scope roots,
or active repo/worktree roots.

It shares its classifier with `pre-bash`, so it also blocks destructive targets
whose command substitution or variable expansion could collapse to empty —
`rm -rf "$(cmd)"/*` and `rm -rf "$VAR"/*`. See
[`hooks/pre-bash/README.md`](../pre-bash/README.md) for the full rules and the
recommended safe form.

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

The classification is grounded in verified git provenance, not path shape. The
two-segment path must be a real worktree root, no segment may be a symlink, and
its `.git` must prove it owns its own history: a `.git` file's `gitdir:` target
has to live under its repository's `worktrees/` directory and point back at this
control file, and a `.git` directory must not be grafted on by a `commondir`.

Shape alone proves nothing. `<root>/<flat-worktree>/<subdir>` has exactly the
canonical shape, so a `cd` would otherwise launder a forbidden flat worktree into
a compliant one; and a symlink or a two-line forged `.git` file would aim a
compliant-looking path at a shared checkout, making `git commit` land there.

Override the worktrees root with `HASNA_REPOS_WORKTREES_ROOT`.

## Deprecated: the station-id lease layout

The pre-rule-8 layout `<station-id>/<repo-slug>-<hex>/wt_<hex>` is deprecated and
is never classified as a compliant worktree. Two migration tolerances keep
existing worktrees working while they are re-homed:

- git work there warns instead of being blocked, so in-flight tasks can still land;
- it keeps its scoped `~/.hasna` write carve-out.

Both are temporary. Re-home these worktrees to the canonical path, then set
`HASNA_HOOKS_LEGACY_WORKTREE_TOLERANCE=0`; the branch is removed after that.

The tolerance still requires the same provenance proof as the canonical path — it
softens the verdict, it does not skip the check. It does key off the path name, so
a worktree deliberately named to match also gets the warn tier; that is an opt-out
from a guardrail by a cooperating agent, not a way to reach a shared checkout.

## Install for Codewith

Prefer renderer-managed configuration through open-configs. @hasna/hooks can emit the TOML fragment:

```bash
hooks install worktree-guard --target codewith
```

## License

Apache-2.0
