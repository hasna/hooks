# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.4.1] - 2026-07-26

### Fixed

- `worktree-guard` / `managedWorktreeInfo()` now classify worktrees against the canonical path shape from Hasna Agent Operating Rules rule 8, as published by the `@hasna/identities` 0.4.4 global agent rules: `$HOME/.hasna/repos/worktrees/<repo-name>/<worktree-name>`. The guard previously required a 3-segment `<station-id>/<repo-slug>-<hex>/wt_<hex>` lease layout, so every rule-8-compliant worktree was classified UNMANAGED — blocking `git commit`/`git push` from it, and denying it the scoped `~/.hasna` write carve-out so that `Write`/`Edit`/`apply_patch` into a canonical worktree was blocked as a dangerous operation.
- Non-canonical shapes are now rejected with a specific reason instead of a generic "not deep enough": flat single-segment worktrees under the worktrees root, station-id/machine segments in front of the repo name, and nesting deeper than the canonical shape. Subdirectories of a canonical worktree are correctly accepted.
- The restored `~/.hasna` write carve-out covers canonical paths that are *linked* git worktrees. A canonical path holding a standalone clone (a `.git` directory) is now allowed to `git commit` but still cannot be written to by file tools, because the carve-out's anti-forgery proof requires linked-worktree provenance. That proof is deliberately unchanged; on the reference fleet this affects 38 of 203 accepted paths, which should be created with `git worktree add`.
- Classification is grounded in verified git provenance, not path shape. A path is canonical only if it is a real worktree root, no segment is a symlink, and its `.git` proves ownership of its own history — a `.git` file's `gitdir:` target must live under its repository's `worktrees/` directory and point back at this control file, and a `.git` directory must be self-contained, with no `commondir` and with real `objects`/`refs` of its own. Without those proofs, `<worktrees-root>/<flat-worktree>/<subdir>` let a single `cd` launder a forbidden flat worktree into a compliant one, and a symlink, a two-line forged `.git` file, or a `.git` directory with symlinked object storage pointed a compliant-looking path at a shared checkout, so `git commit`/`git push` landed on that checkout — exactly what rule 10 forbids. The same grounding gates the deprecated-layout tolerance, so its name pattern cannot be used as a forgery kit.
- Hook verdicts are written synchronously. `process.stdout.write` is asynchronous on a pipe, so a verdict larger than the pipe buffer could be truncated when the hook exited, and a truncated verdict is unparseable — the caller would see no decision at all.
- On the reference fleet the guard's verdict now agrees with git's own verdict for 207 of 207 canonical-path checkouts: every path it rejects is one where `git` itself refuses to operate (pruned or half-pruned worktrees), and every path it accepts is one where git works.
- Repo and worktree path segments are no longer restricted to an allowlist that rejected legal directory names (long names, `+`, `~`, spaces, non-ASCII). Segments are bounded by the filesystem limit and still refuse a leading `.` or `-` and control characters.
- Guard messages cite the canonical path template and the rule-8 remediation (`git worktree add` at the canonical path, then `repos scan`) instead of the stale `repos worktrees claim` command; the repos CLI has no worktree verb.
- The `<repo-name>` segment in guard remediation is now resolved with the exact repos CLI lookup rule 8 mandates (`repos repo --remote <host/org/name> --json`), falling back to the local checkout directory. It was previously derived from the git remote basename, which names a *different* directory for 46 of 50 indexed repos (`open-hooks` is `github.com/hasna/hooks`), so the guard used to point agents at a path that does not exist. The suggested base branch now comes from the repo's real `default_branch`. The lookup is best-effort: a missing or failing repos CLI degrades to local information.
- Worktree/repo path segments may start with an underscore (e.g. `connectors/_base`), while a leading `.` or `-` is still refused.

### Deprecated

- The pre-rule-8 station-id lease layout `<station-id>/<repo-slug>-<hex>/wt_<hex>` is no longer a compliant worktree shape and is reported as unmanaged with a migration reason. Two scoped, temporary tolerances keep existing worktrees usable while they are re-homed: git work there warns instead of being blocked, and the layout is retained read-only for the scoped dangerous-operation carve-out so it keeps its `~/.hasna` write exemption. Set `HASNA_HOOKS_LEGACY_WORKTREE_TOLERANCE=0` to turn both off once those worktrees are re-homed; the branch is removed after that. While the tolerance is on it keys off the path name, so a worktree deliberately named to match also gets the warn tier — an opt-out from a guardrail, not a hole in the provenance proof, which applies to both tiers. The write carve-out's own verification is unchanged: standalone repos, forged worktree metadata, symlink/hardlink escapes, and Git metadata targets still fail closed at either depth.

  Measured against the 764 real worktrees on the reference fleet machine, the guard's verdicts move as: 189 block → allow (rule-8-canonical worktrees that 0.4.0 wrongly blocked), 70 allow → warn (station-id lease layouts, now on the migration path), 502 block → block (already non-compliant), and 3 allow → block. Those 3 are worktrees whose repository has been pruned, where `git` itself already refuses to operate, so no working setup is stranded by the change.

## [0.4.0] - 2026-07-24

### Added

- Gradual-disclosure output flags on the CLI: `--limit`, `--all`, `--verbose` (alongside existing `--json`), plus `hooks info <name>` and `hooks docs <name> --verbose` for full detail on demand (#2).

### Changed

- Compact output by default across noisy surfaces: `hooks list`, `hooks search`, `hooks docs`, and log list/search/tail/errors now render capped, scannable summaries with hints to the detail paths. MCP list/search/docs/registered/profile/log/agent tools are also compact by default, with explicit `compact:false` / `verbose:true` escape hatches. Machine-readable `--json` paths remain full detail, and the legacy 50-row default for full MCP log rows is preserved (#2).

### Fixed

- Cross-cwd managed worktree patches: recognize absolute file-tool targets inside a different verified linked managed worktree, while failing closed for malformed/standalone repos, Git metadata, roots, symlink/hardlink escapes, and forged worktree provenance; managed-root discovery is cached across multi-file patches (#7).

## [0.3.11] - 2026-07-20

### Fixed

- `fleet-blockers-gate`: made the brake owner-scoped and reliable. It now denies mutating tools on a real code-flagged blocker (`blocking=1`) returned by `conversations blockers` — the correctly-retrieved, tamper-resistant signal — instead of scanning message text for `[FREEZE]`. Freeze TEXT in channels is now informational and never stops work, killing the phantom-freeze bug where any `[FREEZE]` string from any author wedged the fleet; and a real `blocking=1` blocker that lacked `[FREEZE]` text is no longer ignored.
- Author (`from_agent`) is unauthenticated, so it is treated as advisory context in the deny reason only and is never used as a security gate (avoids false assurance from a spoofable field).
- Raised the per-check exec timeout default from 500ms to 1500ms: the `conversations` CLI has a ~0.5s cold start, so the old budget flaked and the gate silently failed open.
- Hardened the CLI invocation (`execFileSync` with an argument array plus a leading-dash/shell-metacharacter guard) and made the freeze state engage fast while disengaging slowly via an asymmetric TTL cache.

## [0.3.10] - 2026-07-13

### Fixed

- Allowed normal child cleanup and file edits inside the current git repo root under managed `~/.hasna/repos/worktrees` paths, including fallback-shaped worktrees, while still blocking managed repo root wipes, managed worktrees root wipes, protected Hasna state, workspace roots, Hasna scope roots, and active roots.

## [0.3.9] - 2026-07-13

### Added

- Added scoped dangerous-operation blocking for Codewith-native `pre-bash` and `worktree-guard` surfaces covering protected Hasna state, workspace roots, active repo roots, and managed worktrees without banning ordinary cleanup like `rm -rf dist`.
- Added Codewith apply-patch tool coverage for `apply_patch`, `ApplyPatch`, and `functions.apply_patch` payloads, including canonical `tool_input.command` patch bodies.

### Changed

- `hooks install --target all` now excludes obsolete Gemini and targets the active supported agent set.

## [0.3.8] - 2026-07-10

### Changed

- Removed the standalone npm package manifest for `knowledge-context`; the hook is now distributed only inside `@hasna/hooks`.
- Kept `knowledge-context` available as a catalog hook via `hooks run knowledge-context`.

## [0.3.7] - 2026-07-09

### Fixed

- Filtered `knowledge-context` matches that mark themselves as historical/reference-only or not suitable for auto-loading, preventing archived startup files from being injected into normal agent context.
- `knowledge-context` now fetches extra bounded candidates internally while still rendering only the configured top item budget, so filtering stale matches can reveal useful Knowledge without bloating context.

## [0.3.6] - 2026-07-09

### Changed

- Compact `knowledge-context` citation output further by printing the full-item read command once and formatting Knowledge bullets as `item_id=... cite=...`.
- Added deterministic high-signal gating for `UserPromptSubmit` so low-signal prompts fail open instead of injecting Knowledge matches on every short user message.

## [0.3.5] - 2026-07-09

### Fixed

- Fixed `knowledge-context` helper imports so importing exported helpers does not trip the executable-entrypoint guard.

## [0.3.4] - 2026-07-09

### Changed

- Reduced `knowledge-context`'s default context pack budget to the top 3 items to keep hook-added context compact.
- Compact Knowledge citation output by omitting repeated `knowledge://item/...` source URIs when the `knowledge get --id ... --json` follow-up command already identifies the item.

## [0.3.3] - 2026-07-09

### Changed

- Improved `knowledge-context` progressive context output by surfacing Knowledge citation previews as bounded blurbs and adding `knowledge get --id ... --json` read hints for full-item follow-up.

## [0.3.2] - 2026-07-09

### Changed

- Raised `knowledge-context`'s default Knowledge CLI timeout to 5000ms and generated Codewith hook timeout to 6s so deterministic context packs can finish reliably by default.

## [0.3.1] - 2026-07-09

### Added

- `knowledge-context` catalog hook for Codewith `SessionStart`, `UserPromptSubmit`, and `SubagentStart` context injection using deterministic `knowledge context pack --from search` reads
- Codewith installer target support via `--target codewith`, emitting renderer-safe TOML fragments by default and writing Codewith config only with an explicit `--apply-codewith --codewith-config <path>`
- Multi-event registry metadata so one hook can register across multiple lifecycle events

### Changed

- Extended hook event typing with Codewith `UserPromptSubmit` and `SubagentStart` lifecycle events while preserving existing Claude/Gemini target behavior

## [0.3.0] - 2026-07-06

### Added

- SessionStart and SessionEnd hook events across the catalog, schema, installer, and docs (fleet comms Phase 0)
- `fleet-catchup` hook (SessionStart): injects unread blockers, channel notifications since last catchup, and the bounded announcements digest into agent context — deterministic CLI reads, fail-open
- `agent-rules-version-check` hook (SessionStart): compares the rendered `hasna:agent-operating-rules` sentinel version against configs state and warns on drift
- `fleet-blockers-gate` hook (PreToolUse): denies mutating tools while an unread `[FREEZE]` blocking message is active — TTL-cached, hard 500ms fail-open timeout
- SQLite migration `002_session_events` rebuilding the `hook_events` CHECK constraint (with PostgreSQL parity statements)
- `isEventSupported()` installer API; installs for targets without a session-event surface (Gemini) fail with a clear error instead of writing dead settings keys

### Changed

- `announce-start` rebound from Notification (which never fired at session start) to SessionStart; context now injected via `hookSpecificOutput.additionalContext` (0.2.0)
- Reinstalling a hook now removes its entries from every event key, migrating settings entries when a hook is rebound to a new event

### Fixed

- Hyphenated hook names (`announce-start`, `dm-inject`, `typecheck-gate`, …) were invisible to `list --installed`, `remove`, and `doctor` due to a `\w+`-only command regex
- Shell-unsafe values from env/hook input are no longer interpolated into announce/catchup CLI commands

## [0.1.1] - 2026-02-14

### Changed

- Multi-agent support, remove brand-specific mentions

## [0.1.0] - 2026-02-14

### Added

- Update registry to 30 hooks across 10 categories
- 15 new hooks across 5 new categories
- 253 tests with 1,023 assertions across all modules
- MCP server for AI agent integration
- CLI with interactive UI and non-interactive commands
- Core library with registry and installer
- 15 initial hook packages
- Initial project setup

[0.3.10]: https://github.com/hasna/hooks/compare/v0.3.9...v0.3.10
[0.3.9]: https://github.com/hasna/hooks/compare/v0.3.8...v0.3.9
[0.3.8]: https://github.com/hasna/hooks/compare/v0.3.7...v0.3.8
[0.3.7]: https://github.com/hasna/hooks/compare/v0.3.6...v0.3.7
[0.3.6]: https://github.com/hasna/hooks/compare/v0.3.5...v0.3.6
[0.3.5]: https://github.com/hasna/hooks/compare/v0.3.4...v0.3.5
[0.3.4]: https://github.com/hasna/hooks/compare/v0.3.3...v0.3.4
[0.3.3]: https://github.com/hasna/hooks/compare/v0.3.2...v0.3.3
[0.3.2]: https://github.com/hasna/hooks/compare/v0.3.1...v0.3.2
[0.3.1]: https://github.com/hasna/hooks/compare/v0.3.0...v0.3.1
[0.3.0]: https://github.com/hasna/hooks/compare/v0.1.1...v0.3.0
[0.1.1]: https://github.com/hasna/hooks/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/hasna/hooks/releases/tag/v0.1.0
