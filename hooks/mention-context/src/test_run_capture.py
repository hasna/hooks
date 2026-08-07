#!/usr/bin/env python3
"""Regression suite for the shared-temp-file race in hasna-mention-context.py.

THE DEFECT. `run_capture` derived its output path from its `tag` argument alone,
and `probe_local_head` passed a constant `tag="gitlog"`. Repository probes run
concurrently against one shared temp directory, so every mentioned repository's
`git log` wrote to and read back the same `gitlog.out` and the reader got
whatever the last writer left. The emitted sha was always a real sha from a real
repository, just the wrong one.

WHY THESE TESTS ARE TIMED RATHER THAN LOOPED. A race reproduced by "run it many
times and hope" passes on broken code whenever the interleaving happens not to
occur, which makes it worthless as a gate. Both tests below instead FORCE the
losing interleaving with a controlled delay, so they fail on the unfixed code on
every run rather than on some runs.

The construction, which is the whole idea:

    EARLY WRITER, LATE READER   writes at t=0,     exits and reads at t=SLOW
    LATE WRITER,  EARLY READER  writes and exits and reads at t=FAST

    t=0     both open(path,"wb") -> truncate
    t=0     early's process writes its marker
    t=FAST  late's process overwrites the same path, then reads -> its own value
    t=SLOW  early reads -> LATE'S VALUE, not its own          <- the defect

With one file per call the two never interact and both read their own output.
"""

import importlib.util
import os
import shutil
import subprocess
import sys
import tempfile
import threading
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
HOOK_PATH = os.path.join(HERE, "hasna-mention-context.py")

# Timings. SLOW must stay comfortably under probe_local_head's hardcoded 2.0 s
# subprocess timeout, or a slow machine turns a real pass into a spurious
# failure. The gap between them is the margin that makes the interleaving
# deterministic; 0.55 s absorbs a great deal of scheduler jitter.
SLOW_S = 0.80
FAST_S = 0.25


def load_hook():
    """Import the hook by path. Its filename is not a legal module name, and it
    guards main() behind __name__ == "__main__", so importing runs no hook."""
    spec = importlib.util.spec_from_file_location("hasna_mention_context", HOOK_PATH)
    if spec is None or spec.loader is None:
        raise RuntimeError("could not load a module spec for %s" % HOOK_PATH)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


mod = load_hook()


def run_pair(first, second):
    """Run two callables on two threads released simultaneously by a barrier.

    Returns {name: value}. A barrier rather than two bare start() calls, because
    the interleaving depends on both calls entering the region together.
    """
    results = {}
    errors = {}
    barrier = threading.Barrier(2)

    def wrap(name, fn):
        def run():
            try:
                barrier.wait(timeout=10)
                results[name] = fn()
            except BaseException as exc:      # noqa: BLE001 - surfaced below
                errors[name] = exc
        return run

    threads = [threading.Thread(target=wrap(n, f), daemon=True)
               for n, f in (first, second)]
    for t in threads:
        t.start()
    for t in threads:
        t.join(timeout=30)
    for t in threads:
        if t.is_alive():
            raise AssertionError("a probe thread did not finish within 30 s")
    if errors:
        raise AssertionError("probe thread raised: %r" % (errors,))
    return results


class RunCaptureIsolation(unittest.TestCase):
    """Level 1 — run_capture itself, no git, fully hermetic."""

    def test_concurrent_captures_sharing_a_tag_do_not_cross(self):
        tmpdir = tempfile.mkdtemp(prefix="mention-context-test-")
        self.addCleanup(shutil.rmtree, tmpdir, ignore_errors=True)

        # Equal-length markers, so that on the unfixed code the overwrite is
        # clean and the failure message shows one whole wrong value rather than
        # two values spliced at a byte boundary.
        early_mark = "AAAAAAAA"
        late_mark = "BBBBBBBB"

        def capture(mark, pre_sleep, post_sleep):
            script = (
                "import sys, time\n"
                "time.sleep(%r)\n"
                "sys.stdout.write(%r)\n"
                "sys.stdout.flush()\n"
                "time.sleep(%r)\n" % (pre_sleep, mark, post_sleep)
            )
            # A python child rather than a shell one-liner: the write and the
            # flush are explicit, so "the bytes reached the file before the
            # sleep" is a property of the test rather than of shell builtin
            # buffering.
            def call():
                return mod.run_capture(
                    [sys.executable, "-c", script],
                    timeout=30.0, tmpdir=tmpdir, tag="gitlog",
                )
            return call

        results = run_pair(
            ("early", capture(early_mark, 0.0, SLOW_S)),   # writes t=0, reads t=SLOW
            ("late", capture(late_mark, FAST_S, 0.0)),     # writes and reads t=FAST
        )

        early_rc, early_out = results["early"]
        late_rc, late_out = results["late"]

        self.assertEqual(early_rc, 0, "early capture did not run: rc=%r" % (early_rc,))
        self.assertEqual(late_rc, 0, "late capture did not run: rc=%r" % (late_rc,))

        # This is the assertion the defect breaks. On the unfixed code the early
        # caller reads the LATE caller's marker, because both used gitlog.out.
        self.assertEqual(
            early_out, early_mark,
            "the early caller read %r but produced %r — a concurrent call's "
            "output was attributed to it (shared temp path)"
            % (early_out, early_mark),
        )
        self.assertEqual(
            late_out, late_mark,
            "the late caller read %r but produced %r" % (late_out, late_mark),
        )

    def test_capture_paths_are_distinct_for_the_same_tag(self):
        """The invariant directly: one tag, two calls, two files.

        Kept separate from the timed test because it states the property in one
        line and cannot be confused by machine load.
        """
        tmpdir = tempfile.mkdtemp(prefix="mention-context-test-")
        self.addCleanup(shutil.rmtree, tmpdir, ignore_errors=True)

        for _ in range(2):
            rc, _out = mod.run_capture([sys.executable, "-c", "pass"],
                                       timeout=30.0, tmpdir=tmpdir, tag="gitlog")
            self.assertEqual(rc, 0)

        outs = [n for n in os.listdir(tmpdir) if n.endswith(".out")]
        self.assertEqual(
            len(outs), 2,
            "two calls with tag='gitlog' produced %d .out file(s) (%r); each "
            "call must own its path or concurrent calls overwrite each other"
            % (len(outs), sorted(outs)),
        )
        self.assertTrue(
            all(n.startswith("gitlog") for n in outs),
            "the tag must survive as a readable prefix, got %r" % (sorted(outs),),
        )


class ProbeLocalHeadIsolation(unittest.TestCase):
    """Level 2 — probe_local_head end to end, real git, real repositories.

    The repositories are built here rather than borrowed from the machine, so
    the test is hermetic and the expected shas are known exactly.
    """

    def setUp(self):
        self.git = shutil.which("git")
        if not self.git:
            # Fail rather than skip. A skipped test is indistinguishable from a
            # passing one in the summary line, and this suite exists to gate a
            # defect that already shipped once.
            self.fail("git is not on PATH; this regression test cannot run")
        self.root = tempfile.mkdtemp(prefix="mention-context-repos-")
        self.addCleanup(shutil.rmtree, self.root, ignore_errors=True)

    def make_repo(self, name, content):
        path = os.path.join(self.root, name)
        os.makedirs(path)
        # Identity is supplied through the environment of these throwaway
        # fixture processes only. Nothing here writes git config, and no real
        # repository is touched.
        env = dict(os.environ)
        env.update({
            "GIT_AUTHOR_NAME": "mention-context test",
            "GIT_AUTHOR_EMAIL": "test@example.invalid",
            "GIT_COMMITTER_NAME": "mention-context test",
            "GIT_COMMITTER_EMAIL": "test@example.invalid",
            "GIT_CONFIG_GLOBAL": os.path.join(self.root, "no-such-gitconfig"),
            "GIT_CONFIG_SYSTEM": os.path.join(self.root, "no-such-gitconfig"),
        })
        def git(*args):
            cp = subprocess.run([self.git, "-C", path] + list(args), env=env,
                                stdout=subprocess.PIPE, stderr=subprocess.PIPE)
            if cp.returncode != 0:
                self.fail("fixture git %r failed rc=%d: %s"
                          % (args, cp.returncode, cp.stderr.decode("utf-8", "replace")))
            return cp.stdout.decode("utf-8", "replace")
        git("init", "-q")
        with open(os.path.join(path, "file.txt"), "w") as f:
            f.write(content)
        git("add", "file.txt")
        git("commit", "-q", "-m", "fixture commit for " + name)
        sha = git("log", "-1", "--format=%h").strip()
        return path, sha

    def write_timing_wrapper(self, slow_repo_path):
        """A git wrapper that makes one repository the early-writer/late-reader.

        For the slow repository: run git (its output lands in the capture file
        immediately, flushed by git's own exit) and only then sleep before
        exiting, so the read happens late. For every other repository: sleep
        first, so its write lands in between.
        """
        wrapper = os.path.join(self.root, "git-timing-wrapper")
        with open(wrapper, "w") as f:
            f.write(
                "#!/bin/sh\n"
                'case "$*" in\n'
                "  *%s*) %s \"$@\"; ec=$?; sleep %s; exit $ec ;;\n"
                "  *) sleep %s; exec %s \"$@\" ;;\n"
                "esac\n" % (os.path.basename(slow_repo_path), self.git,
                            SLOW_S, FAST_S, self.git)
            )
        os.chmod(wrapper, 0o755)
        return wrapper

    def test_concurrent_probes_report_their_own_repositorys_head(self):
        alpha_path, alpha_sha = self.make_repo("alpha", "alpha content\n")
        beta_path, beta_sha = self.make_repo("beta", "beta content\n")
        self.assertNotEqual(
            alpha_sha, beta_sha,
            "fixture repositories must have different heads for this test to "
            "be able to detect wrong attribution at all",
        )

        tmpdir = tempfile.mkdtemp(prefix="mention-context-test-")
        self.addCleanup(shutil.rmtree, tmpdir, ignore_errors=True)

        wrapper = self.write_timing_wrapper(beta_path)
        original_git_bin = mod.GIT_BIN
        mod.GIT_BIN = wrapper
        self.addCleanup(setattr, mod, "GIT_BIN", original_git_bin)

        results = run_pair(
            ("beta", lambda: mod.probe_local_head(beta_path, tmpdir)),
            ("alpha", lambda: mod.probe_local_head(alpha_path, tmpdir)),
        )

        self.assertIsNotNone(
            results["beta"],
            "probe_local_head returned None for beta; the probe did not run, "
            "so this test proved nothing about attribution",
        )
        self.assertIsNotNone(results["alpha"], "probe_local_head returned None for alpha")

        # beta is the early writer and late reader: on the unfixed code it reads
        # alpha's line out of the shared gitlog.out and reports alpha's sha.
        self.assertEqual(
            results["beta"]["sha"], beta_sha,
            "beta reported %r; its own head is %r and alpha's is %r — one "
            "repository's head was attributed to another"
            % (results["beta"]["sha"], beta_sha, alpha_sha),
        )
        self.assertEqual(
            results["alpha"]["sha"], alpha_sha,
            "alpha reported %r, expected %r"
            % (results["alpha"]["sha"], alpha_sha),
        )


def colliding_heads(pairs):
    """Field canary, NOT the gate — see the class below for why.

    `pairs` is [(resolved_checkout, sha), ...]. Returns the shas claimed by more
    than one DISTINCT checkout. Comparing resolved paths rather than mention
    tokens is what stops it firing on `hasna/loops` and `hasna/open-loops`, which
    are two tokens naming one checkout and legitimately share a head.
    """
    by_sha = {}
    for checkout, sha in pairs:
        if not checkout or not sha:
            continue
        by_sha.setdefault(sha, set()).add(os.path.realpath(checkout))
    return sorted(sha for sha, paths in by_sha.items() if len(paths) > 1)


class DuplicateShaCanary(unittest.TestCase):
    """The duplicate-sha check, with its own blind spot pinned down in a test.

    Two unrelated repositories cannot share a commit sha, so a single emitted
    block claiming one sha for two checkouts is self-evidently corrupt — no
    fixtures needed, which makes this cheap to run against real output in the
    field.

    It is NOT the acceptance gate, and the test below is what stops anyone
    promoting it to one: it detects COLLISION TO A COMMON VALUE while the defect
    is WRONG ATTRIBUTION, and a clean swap between two concurrent writers is
    pairwise distinct and entirely wrong.
    """

    def test_catches_the_duplicate_case(self):
        pairs = [("/repos/open-loops", "82a3acf"), ("/repos/open-logs", "82a3acf")]
        self.assertEqual(colliding_heads(pairs), ["82a3acf"])

    def test_is_blind_to_the_swap_case(self):
        # The 17:48 observation: each value real, each attributed to the wrong
        # repository, pairwise distinct. This assertion records a limitation on
        # purpose; if it ever starts failing the canary got stronger and this
        # test should be revisited, not deleted quietly.
        pairs = [("/repos/open-loops", "27cffd7"), ("/repos/open-logs", "82a3acf")]
        self.assertEqual(
            colliding_heads(pairs), [],
            "the canary is expected to MISS a clean swap; it is a supplement to "
            "the concurrency tests above, never a replacement",
        )

    def test_does_not_fire_when_two_tokens_name_one_checkout(self):
        # `hasna/loops` and `hasna/open-loops` both resolve to open-loops.
        pairs = [("/repos/open-loops", "82a3acf"), ("/repos/open-loops", "82a3acf")]
        self.assertEqual(colliding_heads(pairs), [])


if __name__ == "__main__":
    unittest.main(verbosity=2)
