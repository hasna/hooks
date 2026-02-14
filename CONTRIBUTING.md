# Contributing

Thanks for helping improve the hooks. Please follow these guidelines so we can keep publishing safe and consistent.

## NPM Auth (Optional)

If you need a scoped registry token (publish or private installs), copy an example file and set `NPM_TOKEN`:

```bash
cp .npmrc.example .npmrc
```

- Do not commit `.npmrc` files with real tokens.
- Use environment variables in CI: `NPM_TOKEN` only.

## Adding a New Hook

1. Create the hook directory: `hooks/hook-{name}/`
2. Follow the standard structure:
   ```
   hook-{name}/
   ├── src/
   │   ├── hook.ts     # Main hook logic
   │   ├── cli.ts      # CLI commands
   │   └── index.ts    # Exports
   ├── package.json
   ├── CLAUDE.md
   ├── README.md
   └── tsconfig.json
   ```
3. Register it in `src/lib/registry.ts`
4. Test with `bun run dev`

## Hook Conventions

- Hooks receive JSON on stdin and output JSON on stdout
- PreToolUse hooks return `{ "decision": "approve" | "block", "reason": "..." }`
- PostToolUse/Stop/Notification hooks return `{ "continue": true }`
- Log diagnostic info to stderr, not stdout
- No external dependencies (use Node.js builtins only)

## Secrets

- Never commit `.env` files with real values.
- Keep credentials in your local environment only.
