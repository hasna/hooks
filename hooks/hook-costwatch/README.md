# hook-costwatch

Claude Code hook that estimates session token usage and warns if a budget threshold is exceeded.

## Overview

When Claude stops, this hook attempts to estimate the session's token usage by examining the transcript file size. If a budget is configured and the estimated cost exceeds it, a warning is logged to stderr.

## Event

- **Stop** (no matcher)

## Configuration

### Budget (optional)

Set a per-session budget via environment variable:

```bash
export COST_WATCH_BUDGET="5.00"  # Max $5.00 per session
```

If not set, the hook runs without budget enforcement and simply logs a reminder to check usage.

## Cost Estimation

The estimation is intentionally rough:

- **~4 characters per token** (average for English text)
- **~$30 per million tokens** (blended input/output estimate)
- Based on transcript file size, not actual API usage

This is a ballpark estimate. Always check actual usage at [console.anthropic.com](https://console.anthropic.com/).

## Behavior

- Reads the session transcript and estimates total tokens from file size
- If `COST_WATCH_BUDGET` is set and estimated cost exceeds it, logs a WARNING to stderr
- If no transcript is found, logs that cost could not be estimated
- Never blocks the session from ending
- Outputs `{ "continue": true }` always

## Example Output

```
[hook-costwatch] Session estimate: ~125.0K tokens, ~$3.75
[hook-costwatch] Budget: $5.00/session. Remember to check actual usage.
```

With budget exceeded:

```
[hook-costwatch] Session estimate: ~250.0K tokens, ~$7.50
[hook-costwatch] WARNING: Estimated cost ($7.50) exceeds budget ($5.00)!
[hook-costwatch] Check your actual usage at https://console.anthropic.com/
[hook-costwatch] Budget: $5.00/session. Remember to check actual usage.
```

## License

Apache-2.0
