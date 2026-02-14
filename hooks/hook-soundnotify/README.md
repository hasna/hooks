# hook-soundnotify

Claude Code hook that plays a sound when Claude finishes a session.

## Event

**Stop** — fires when Claude's session ends.

## What It Does

Plays a system sound to notify you that Claude has finished working. Useful when you tab away and want an audible alert.

### Platform Support

| Platform | Player | Default Sound |
|----------|--------|---------------|
| macOS | `afplay` | `/System/Library/Sounds/Glass.aiff` |
| Linux | `paplay` / `aplay` | `/usr/share/sounds/freedesktop/stereo/complete.oga` |

### Configuration

Set `HOOKS_SOUND_FILE` environment variable to use a custom sound:

```bash
export HOOKS_SOUND_FILE="/path/to/your/sound.wav"
```

## Installation

Add to your `.claude/settings.json`:

```json
{
  "hooks": {
    "Stop": [
      {
        "matcher": "",
        "hooks": [
          {
            "type": "command",
            "command": "bun run hooks/hook-soundnotify/src/hook.ts"
          }
        ]
      }
    ]
  }
}
```

## Output

Always `{ "continue": true }` — sound plays asynchronously (fire-and-forget) and never blocks session exit.

## How It Works

1. Looks for a sound file (env var > platform default)
2. Spawns the audio player as a detached child process
3. Immediately returns without waiting for playback to finish
4. The sound plays in the background after Claude exits

## License

Apache-2.0
