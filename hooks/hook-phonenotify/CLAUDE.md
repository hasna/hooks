# CLAUDE.md

## hook-phonenotify

A Stop/Notification hook that sends push notifications to phone via ntfy.sh.

### Key Files

| File | Purpose |
|------|---------|
| `src/hook.ts` | Main hook logic — reads stdin, sends ntfy.sh notification |
| `src/cli.ts` | CLI — install/uninstall/status/test |

### Hook Events

- **Stop** — notifies when Claude finishes
- **Notification** — notifies when Claude needs attention

### Configuration

Reads `phoneNotifyConfig` from `~/.claude/settings.json`:
- `topic` — ntfy.sh topic name (required)
- `server` — ntfy server URL (default: https://ntfy.sh)
- `priority` — notification priority 1-5 (default: 3)
- `enabled` — toggle on/off
