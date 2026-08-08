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

## Tests

Run them with `bun test`. Bun's per-test timeout defaults to 5000ms.

Declare an explicit budget, with the reason beside the number, on any test that spawns a
subprocess more than twice or that asserts on its own elapsed time — for example
`}, 20000); // 7 CLI spawns`. A test that times itself needs a budget strictly above the total
its own assertions already permit, or the runner kills it first and a genuine regression reads
as an infrastructure timeout instead of as the assertion's message.

## Secrets

- Never commit `.env` files with real values.
- Keep credentials in your local environment only.
