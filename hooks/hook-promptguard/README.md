# hook-promptguard

Claude Code hook that blocks prompt injection, credential extraction, and social engineering attempts.

## Event

**UserPromptSubmit** — fires before Claude processes a user prompt.

## What It Does

Scans user prompts for malicious patterns and blocks them before Claude sees them:

### Prompt Injection
- "ignore previous instructions", "disregard prior instructions"
- "new system prompt", "reveal system prompt", "what are your instructions"
- "you are now", "from now on you are", "entering new mode"
- "jailbreak", "DAN mode"

### Credential Access
- "show me the api key", "print the token", "reveal password"
- "dump credentials", "dump secrets", "extract credentials"
- "read .env", "cat .secrets/"

### Social Engineering
- "pretend you are", "act as root", "act as admin"
- "sudo mode", "god mode", "developer mode", "unrestricted mode"
- "bypass restrictions", "disable safety", "remove restrictions"

All matching is **case-insensitive**.

## Installation

Add to your `.claude/settings.json`:

```json
{
  "hooks": {
    "UserPromptSubmit": [
      {
        "matcher": "",
        "hooks": [
          {
            "type": "command",
            "command": "bun run hooks/hook-promptguard/src/hook.ts"
          }
        ]
      }
    ]
  }
}
```

## Output

- `{ "decision": "approve" }` — prompt is safe
- `{ "decision": "block", "reason": "Blocked: potential prompt injection" }` — prompt blocked

## Customization

Add or remove patterns in the `INJECTION_PATTERNS`, `CREDENTIAL_PATTERNS`, or `SOCIAL_ENGINEERING_PATTERNS` arrays in `src/hook.ts`.

## License

MIT
