# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
