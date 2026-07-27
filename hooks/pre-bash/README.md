# pre-bash

Codewith-native hook installed as `hooks run pre-bash`.

This hook is OSS-safe: optional Hasna CLIs are best-effort and missing CLIs fail open with concise warnings. Security gates only fail closed when a guarded commit/push scan runs successfully and finds possible secrets.

It also blocks scoped destructive shell operations such as recursive `rm`,
`rsync --delete`, destructive `find`, and destructive `git clean` / `git reset
--hard` forms when the resolved target threatens a protected root.

## Protected roots

- `/` and the system directories (`/usr`, `/etc`, `/bin`, `/lib`, `/var`, `/boot`,
  `/home`, `/Users`, and the other FHS and macOS equivalents). Add machine-specific
  entries with `HASNA_PROTECTED_SYSTEM_ROOTS` (colon-separated). `/tmp` is not
  protected — scratch cleanup there is routine.
- `~/.hasna`, configured workspace roots, Hasna division/scope roots, and active
  repo/worktree roots.

These match in *root* mode: wiping a root or its contents (`rm -rf /usr`,
`rm -rf /usr/*`) blocks, while a targeted delete beneath one
(`rm -rf /usr/local/lib/my-build`) is allowed.

## Expansions that can collapse to empty

A destructive target containing a command substitution, backtick substitution or
variable expansion is checked twice: as written, and as the shell would render it
if the expansion returned empty. `rm -rf "$(anything)"/*`, `` rm -rf `cmd`/* ``,
`rm -rf "$VAR"/*` and `rm -rf "${VAR}"/*` are blocked by shape, whatever the
expansion is.

This exists because of a realized incident: `bun pm cache` exits non-zero with an
empty stdout when no `package.json` is found walking up from cwd, so
`rm -rf "$(bun pm cache)"/*` ran as `rm -rf /*`. Redirecting stderr does not help
— it discards the diagnostic, not the path.

Two forms are deliberately not blocked:

- `${VAR:?}` / `${VAR:?message}`, which POSIX guarantees non-empty. (`${VAR?}`
  without the colon permits an empty value and is *not* exempt.)
- A bare `rm -rf "$(cmd)"` with no trailing separator, which degrades to
  `rm -rf ""` — rejected by `rm` without deleting anything.

The recommended form is to resolve the path first and assert it:

```bash
dir="$(bun pm cache)" || exit 1
case "$dir" in /|"") exit 1;; esac
rm -rf -- "$dir"
```

## Globs

A glob threatens a protected root when it can match that root or an ancestor of it, or when it
wipes the root's contents wholesale. Matching is per path component, so a trailing literal
bounds the delete: `rm -rf */node_modules` at a monorepo root is allowed, while `rm -rf /*/*`
is not.

A glob directly under a protected root is refused only when it is *unanchored* — when no
literal text survives once the wildcards are removed. `[a-z]*`, `?*`, `.??*` and `*.*` are
unanchored and blocked; `*.log`, `tmp-*`, `.turbo*` and `snapshot-[0-9]*` keep their literal
anchor and are allowed.

Bracket expressions that this matcher does not model exactly — POSIX `[:class:]`, `[=equiv=]`,
`[.collate.]`, backslash escapes, anything unterminated — are treated as **matching**, never as
not-matching. An under-match would leave a protected root unmatched and allow the delete, so
ambiguity resolves toward refusing.

## Working directory

`cd`, `pushd`, `pushd -n`, `popd` and `cd -` are tracked, per subshell, with a directory stack.
A `cd` inside `( … )` or a pipeline stage applies within that shell and does not escape it.

## Wrappers

Commands are unwrapped before scanning: `bash -c` / `sh -c` / `zsh -c`, `su -c`,
`runuser -c`, `eval`, and `ssh host '…'`, including nested combinations. `cd` is
tracked within a command, and a `for VAR in <glob>` binding is followed into
`rm -rf "$VAR"`. Remote (`ssh`) layers only consider absolute targets, because a
remote relative path cannot be resolved against the local working directory.

## Install for Codewith

Prefer renderer-managed configuration through open-configs. @hasna/hooks can emit the TOML fragment:

```bash
hooks install pre-bash --target codewith
```

## License

Apache-2.0
