# mention-context

A `UserPromptSubmit` hook. When a prompt mentions `hasna/<repo>` or `hasnaxyz/<repo>`,
it injects a short context block for that repository — local checkout HEAD, installed
version, worktrees, npm version, GitHub default branch and open PRs.

This is the first Python hook in this repository. Everything else under `hooks/` is
TypeScript. The language is not a preference: this hook runs on **every prompt
submission** under a sub-second budget, and starting a Python interpreter that exits
immediately when no token matches is measurably cheaper here than the alternative that
was available when it was written. A TypeScript port is a reasonable future change; it
is a rewrite, not a move, and it is out of scope for the defect this directory was
created to fix.

## Layout

```
src/hasna-mention-context.py   the hook
src/hook.test.ts               bun-test wrapper — runs the Python suite under `bun test`
src/test_run_capture.py        the Python regression suite
```

## Running the tests

```bash
bun test hooks/mention-context          # via the wrapper, as CI runs it
python3 hooks/mention-context/src/test_run_capture.py -v   # directly
```

The wrapper exists so the Python suite runs under the repository's existing `bun test`
step with no CI workflow change. It **fails** rather than skips when `python3` is
absent: a skip is indistinguishable from a pass in the summary line, and a regression
test that can silently not run is not a regression test.

## Installation

This directory is the source. The hook is installed by copying
`src/hasna-mention-context.py` to the path registered in the agent's settings
(`~/.hasna/hooks/bin/hasna-mention-context.py` on the current fleet) and is registered
there by absolute path under `UserPromptSubmit`.

Installation is deliberately **not** performed by merging this directory. The hook
renders into every agent's prompt on every firing, so landing the source and updating
the live path are two separately verified steps.

## The defect this directory was created to fix

`run_capture` derived its temp-file path from its `tag` argument alone, and
`probe_local_head` passed a constant `tag="gitlog"`. Repository probes run concurrently
against one shared temp directory, so every mentioned repository's `git log` wrote to
and read back the same `gitlog.out`, and the reader got whatever the last writer left.

The emitted value was always a **real sha from a real repository — just the wrong
one**, which is why it read as correct. Four consecutive firings, each a different wrong
pairing:

```
17:44   loops=82a3acf (right)   accounts=27cffd7 (right)   logs=absent
17:48   loops=27cffd7 (WRONG)   logs=82a3acf (WRONG)          <- clean swap
18:11   loops=27cffd7 (WRONG)   logs=146a70e (right)
18:17   loops=82a3acf (right)   logs=82a3acf (WRONG)          <- duplicate sha
```

The race needs two or three mentions in one prompt. `MAX_TOKENS = 3`, so a single-repo
mention produces one probe, no concurrency, and always the correct answer.

The fix is in `run_capture`, which owns path construction, rather than at the call site:
threading `org`/`word` into `probe_local_head` would have matched its siblings but left
the invariant unenforced, so a fifth call site added later would inherit the bug.
