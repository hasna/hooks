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
src/hasna-mention-warm.py      the out-of-band cache warmer — see "The two files are a pair"
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

## The two files are a pair, and each resolves the other by directory

`hasna-mention-context.py` and `hasna-mention-warm.py` must be installed **into the same
directory**. Neither takes a configured path for the other; each derives the other's
location from its own `__file__`. The coupling runs in both directions and the two
failures look nothing alike.

**Warmer missing, hook present — silent.** The hook computes
`WARM_BIN = <its own dir>/hasna-mention-warm.py` and guards the call with
`os.path.isfile`, so `request_warm()` simply returns. Nothing raises, nothing is logged,
and the prompt block still renders. What stops is the cold-cache self-heal: the hook
hands every degraded or GitHub-less token to the warmer precisely so the *next* prompt
is clean, and that hand-off never happens. A repository mentioned for the first time is
degraded once and then stays degraded on every later prompt, instead of being clean
thereafter. It does not recover on its own, because the hook's own live GitHub probe
cannot close the gap — by the measurement recorded in the hook's header, `gh api graphql`
takes 1.02–1.18 s against a whole-hook deadline of 0.900 s, so the probe is killed before
it can write the cache. The warmer is the only thing that reliably fills it.

**Hook missing, warmer present — loud.** The warmer computes
`HOOK_PATH = <its own dir>/hasna-mention-context.py` and imports it at *module scope*
(`H = load_hook()`), with no guard, to keep one definition of the cache paths, the entry
shapes and the sanitizer. An absent hook is an immediate `FileNotFoundError` and the
warmer does not start at all.

Because the warmer imports the hook, the hook's `CACHE_DIR`, cache entry shape and
sanitizer are a **contract with a second program in this directory**, not private
details. Changing them means changing both files together.

Note that the scheduled warming path does not depend on co-location: the cron entry
invokes the warmer by absolute path. Co-location is what the hook's self-heal path needs.

## Installation

This directory is the source. The hook is installed by copying
`src/hasna-mention-context.py` to the path registered in the agent's settings
(`~/.hasna/hooks/bin/hasna-mention-context.py` on the current fleet) and is registered
there by absolute path under `UserPromptSubmit`.

Copy `src/hasna-mention-warm.py` to that **same directory** in the same step, and
schedule it. On the current fleet it runs from cron at minutes 1, 11, 21, 31, 41 and 51
under `flock`, and it holds its own lock, so overlapping runs are harmless. Installing
the hook alone is a supported thing to do — the hook works without the warmer — but it
costs the self-heal described above, silently, so it should be a decision rather than an
oversight.

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
