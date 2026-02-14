# hook-desktopnotify

Claude Code hook that sends native desktop notifications when Claude stops.

## Overview

Get notified immediately when Claude finishes a task. Uses your OS's native notification system — no external services or accounts needed.

## Platform Support

| Platform | Method | Requirements |
|----------|--------|--------------|
| macOS | `osascript` (display notification) | None (built-in) |
| Linux | `notify-send` | `libnotify` package |

## Hook Event

- **Stop** (no matcher)

## Behavior

1. Fires when Claude stops and waits for input
2. Detects the current platform (`process.platform`)
3. Sends a native notification with the project name
4. Plays a sound on macOS (Glass)
5. Outputs `{ continue: true }`

## Notification Content

- **Title**: "Claude Code — Done"
- **Body**: "Claude has finished working on {project} and is waiting for your input."

## Linux Setup

If `notify-send` is not installed:

```bash
# Ubuntu/Debian
sudo apt install libnotify-bin

# Fedora
sudo dnf install libnotify

# Arch
sudo pacman -S libnotify
```

## License

MIT
