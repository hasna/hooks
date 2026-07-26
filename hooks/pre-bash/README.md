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
