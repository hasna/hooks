# hook-conflict-detect

A PreToolUse hook that checks for unresolved git merge conflict markers before editing files. Prevents editing files mid-conflict and making things worse.

## Installation

```bash
hooks install conflict-detect
```

## How it works

Before every `Edit` or `Write`:
1. Reads the target file
2. Checks for all three conflict markers: `<<<<<<<`, `=======`, `>>>>>>>`
3. If all three are present → blocks the edit with a helpful message
4. Otherwise → approves normally

## Example block message

```
File 'auth.ts' contains unresolved git merge conflicts. Resolve them before editing:

<<<<<<< HEAD
  const user = await getUser(id);
=======
>>>>>>> feature/new-auth

Run `git diff auth.ts` to see the full conflict.
```

## Why all three markers?

The hook requires all three markers to be present to avoid false positives on files that legitimately use `<` or `>` characters.

## Event

- **PreToolUse** (matcher: `Edit|Write`)
