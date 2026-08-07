#!/usr/bin/env python3
"""
hasna-mention-warm — out-of-band cache warmer for hasna-mention-context.

WHY THIS EXISTS, MEASURED RATHER THAN ASSUMED (station01, 2026-08-05):

    gh api graphql (branch+head+3 commits+5 PRs)   1.02 / 1.14 / 1.18 s
    gh --version, no network at all                0.15 - 0.24 s   (43 MB Go binary)
    raw TLS+HTTP to api.github.com                 0.33 - 0.55 s
    todos projects --json                          7.64 s, 1.35 MB
    todos list --project <id> --json               5.5 - 7.1 s
    hasna-mention-context total budget             0.900 s

The GitHub call needs more wall time than the hook is allowed to EXIST for, so
it was killed before it could ever write its cache — which left the cache cold,
which guaranteed the next prompt also timed out. A self-perpetuating cold cache,
visible as `degraded  github (timeout)` on every single run and as a missing
`hasna__todos__gh.json`. The todos calls are 6-8x the whole budget and were
never even attempted inline.

Raising the hook's timeout is the wrong fix: it would breach the 900 ms deadline
on EVERY prompt that mentions a repo, to buy data that is near-static between
prompts. So the slow work moves here, where nothing is waiting on it, and the
hook becomes a pure cache reader.

This writes exactly the cache files the hook already reads, in exactly the shape
the hook's own `shape_github` produces — it imports the hook module rather than
restating its schema, so the two cannot drift.

Sources warmed, each on its own age threshold so one 5-minute cron self-paces:

    gh    branch, origin HEAD, last 3 commits, open PRs      > 240 s
    npm   registry version + description                     > 540 s
    slow  todos project resolution + last 3 BUG rows         > 6 h

Usage:
    hasna-mention-warm.py                    # tokens from the hook's own log + seeds
    hasna-mention-warm.py hasna/todos ...    # explicit tokens
    hasna-mention-warm.py --force            # ignore age thresholds
    hasna-mention-warm.py --verbose          # per-source timing to stdout

Exit status is 0 unless a token was explicitly requested and every source for it
failed, so a cron wrapper can tell "nothing to do" from "everything broke".
"""

import argparse
import importlib.util
import json
import os
import re
import subprocess
import sys
import tempfile
import time

HERE = os.path.dirname(os.path.abspath(__file__))
HOOK_PATH = os.path.join(HERE, "hasna-mention-context.py")

# --------------------------------------------------------------------------
# Hosted-store credentials for the `todos` child process
#
# WHY, MEASURED RATHER THAN ASSUMED (station01, 2026-08-06, todos 17b532d3):
# cron does not source the shell profile and does not inherit BASH_ENV, so the
# HASNA_TODOS_* names are absent from this process, run_capture() spawns `todos`
# with subprocess.run(cmd) and NO env= argument, so the child inherits that same
# empty configuration and falls back SILENTLY to a stale on-box store at rc=0.
# Under `env -i HOME=... PATH=<the crontab PATH>`, same binary in both arms
# (/home/hasna/.bun/bin/todos and /home/hasna/.local/bin/todos are one inode):
#
#   no loader   HASNA_TODOS_* unset  `todos projects --json` = 2353 rows
#               `todos show 17b532d3` rc=1 "Could not resolve task ID"
#   todos.env   HASNA_TODOS_* set    `todos projects --json` = 2793 rows
#               `todos show 17b532d3` rc=0 ; NEGCTL `todos show zz000000` rc=1
#
# 2793 is the count a login shell sees (byte-identical payload, 1359664 B). The
# 440-row gap is only the visible half: the stale store cannot see rows created
# today at all, so warm_slow() was resolving projects and BUG rows against a
# store that does not contain recent work — and writing that into the cache the
# hook serves.
#
# setdefault, not overwrite: under cron nothing is set and the file supplies
# everything, while an interactive run that already carries a deliberate
# configuration keeps it. The shell equivalent (`set -a; . file`) overwrites;
# this is the additive form of the same idiom and cannot regress a working case.
# Failure here is never fatal — a warmer that cannot read the env file should
# still warm gh and npm.
CLOUD_ENV_PATH = os.path.join(os.path.expanduser("~"), ".hasna", "cloud", "todos.env")


def load_cloud_env(path=CLOUD_ENV_PATH):
    """Load KEY=VALUE lines from a cloud env file into os.environ WITHOUT
    overriding anything already set. Returns the list of names applied, so a
    caller can assert coverage; values are never returned, logged or printed."""
    applied = []
    try:
        with open(path, "r", errors="replace") as f:
            for line in f:
                line = line.strip()
                if not line or line.startswith("#"):
                    continue
                if line.startswith("export "):
                    line = line[len("export "):].strip()
                if "=" not in line:
                    continue
                k, v = line.split("=", 1)
                k = k.strip()
                v = v.strip()
                if len(v) >= 2 and v[0] == v[-1] and v[0] in ("'", '"'):
                    v = v[1:-1]
                if not k:
                    continue
                if os.environ.get(k):
                    continue
                os.environ[k] = v
                applied.append(k)
    except Exception:
        return applied
    return applied


CLOUD_ENV_APPLIED = load_cloud_env()


def load_hook():
    """Import the hook module so cache paths, shapes and the sanitizer have ONE
    definition. The hook only runs main() under __main__, so importing it is
    side-effect free apart from reading /proc for its own start time."""
    spec = importlib.util.spec_from_file_location("hasna_mention_context", HOOK_PATH)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


H = load_hook()

# Age above which each source is refetched. Chosen so a 5-minute cron keeps the
# gh entry comfortably inside the hook's serve-clean window with headroom for a
# missed tick, without refetching on every single pass.
AGE_GH = 240
AGE_NPM = 240             # cheap (~520 ms); refresh on essentially every pass
AGE_SLOW = 6 * 3600

LOCK_PATH = os.path.join(H.CACHE_DIR, ".warm.lock")
LOCK_STALE = 900          # a lock older than this is from a killed run
LOG_PATH = os.path.join(H.CACHE_DIR, "warm.jsonl")

# Tokens always kept warm regardless of whether anyone mentioned them recently.
# Deliberately small: every seed costs a GraphQL call per pass.
SEED_TOKENS = [("hasna", "todos")]

LOG_LOOKBACK_DAYS = 14
MAX_TOKENS_PER_RUN = 24
MAX_SLOW_PER_RUN = 2      # stagger the 7-42 s todos tier across passes
NET_TIMEOUT = 25.0        # generous: nothing is waiting on this process
TODOS_TIMEOUT = 90.0

VERBOSE = False


def say(*a):
    if VERBOSE:
        print(*a, flush=True)


# --------------------------------------------------------------------------
# Lock — one warmer at a time, self-healing if a previous run was killed
# --------------------------------------------------------------------------

def acquire_lock():
    try:
        os.makedirs(H.CACHE_DIR, exist_ok=True)
        try:
            age = time.time() - os.path.getmtime(LOCK_PATH)
            if age > LOCK_STALE:
                os.unlink(LOCK_PATH)
            else:
                return False
        except FileNotFoundError:
            pass
        fd = os.open(LOCK_PATH, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
        os.write(fd, str(os.getpid()).encode())
        os.close(fd)
        return True
    except FileExistsError:
        return False
    except Exception:
        return True          # never let lock trouble stop the warm


def release_lock():
    try:
        os.unlink(LOCK_PATH)
    except Exception:
        pass


# --------------------------------------------------------------------------
# Token discovery — warm what people actually mention
# --------------------------------------------------------------------------

def tokens_from_log():
    """Read the hook's own log for repos mentioned recently. Self-tuning: the
    repos you talk about are the repos that stay warm."""
    import calendar
    out, cutoff = [], time.time() - LOG_LOOKBACK_DAYS * 86400
    try:
        with open(H.LOG_PATH) as f:
            lines = f.readlines()
    except Exception:
        return out
    for line in lines[-4000:]:
        try:
            rec = json.loads(line)
            # timegm, not mktime: the log stamps are UTC and mktime would read
            # them as local, shifting the cutoff by the box's offset.
            t = calendar.timegm(time.strptime(rec.get("at", ""), "%Y-%m-%dT%H:%M:%SZ"))
            if t < cutoff:
                continue
            for tok in rec.get("tokens") or []:
                if "/" in tok:
                    org, word = tok.split("/", 1)
                    if org in ("hasna", "hasnaxyz") and re.fullmatch(r"[a-z0-9][a-z0-9-]{0,38}", word):
                        out.append((org, word))
        except Exception:
            continue
    return out


def select_tokens(explicit):
    """Explicit tokens mean ONLY those tokens.

    Merging them with the log set made `warm.py hasna/todos --force` fan out to
    every repo mentioned in the last fortnight and run for over two minutes —
    the operator asked about one repo and got the whole corpus.
    """
    if explicit:
        seen, ordered = set(), []
        for tok in explicit:
            if tok not in seen:
                seen.add(tok)
                ordered.append(tok)
        return ordered
    seen, ordered = set(), []
    for tok in SEED_TOKENS + list(reversed(tokens_from_log())):
        if tok not in seen:
            seen.add(tok)
            ordered.append(tok)
    return ordered[:MAX_TOKENS_PER_RUN]


def needs(org, word, source, max_age, force):
    if force:
        return True
    _, age = H.cache_read(org, word, source)
    return age is None or age > max_age


# --------------------------------------------------------------------------
# gh + npm — the hook's own probes, run without a deadline
# --------------------------------------------------------------------------

def warm_gh(org, word, tmpdir):
    rc, out = H.run_capture(
        [H.GH_BIN, "api", "graphql", "-f", "query=" + H.GQL,
         "-f", "o=" + org, "-f", "n=" + word],
        timeout=NET_TIMEOUT, tmpdir=tmpdir, tag=f"warm-gh-{org}-{word}",
    )
    if rc is None:
        return "timeout"
    try:
        d = json.loads(out)
    except Exception:
        return "unparseable"
    repo = (d.get("data") or {}).get("repository")
    if repo is None:
        errs = d.get("errors") or []
        if any((e or {}).get("type") == "NOT_FOUND" for e in errs):
            return "notfound"
        return "error"
    H.cache_write(org, word, "gh", H.shape_github(repo))
    return "ok"


def warm_npm(org, word, tmpdir):
    body = os.path.join(tmpdir, f"warm-npm-{org}-{word}.body")
    rc, code = H.run_capture(
        [H.CURL_BIN, "-sS", "--max-time", str(NET_TIMEOUT),
         "-o", body, "-w", "%{http_code}",
         f"https://registry.npmjs.org/@{org}%2F{word}/latest"],
        timeout=NET_TIMEOUT + 5, tmpdir=tmpdir, tag=f"warm-npmw-{org}-{word}",
    )
    if rc is None:
        return "timeout"
    if code.strip()[-3:] != "200":
        return "http" + code.strip()[-3:]
    try:
        with open(body) as f:
            d = json.load(f)
    except Exception:
        return "unparseable"
    H.cache_write(org, word, "npm",
                  {"version": d.get("version"), "description": d.get("description")})
    return "ok"


# --------------------------------------------------------------------------
# slow — todos project resolution and BUG rows
# --------------------------------------------------------------------------

def todos_json(args, tmpdir, tag):
    """Run a todos command and parse it, branching EXPLICITLY on the error
    object. `todos` writes {"error": ...} to STDOUT, and the near-universal
    consumer shape degrades that to an empty list — so a missing project and an
    empty project print the same number. Returns (rows, error_string)."""
    rc, out = H.run_capture(["todos"] + args, timeout=TODOS_TIMEOUT,
                            tmpdir=tmpdir, tag=tag)
    if rc is None:
        return None, "timeout"
    try:
        d = json.loads(out)
    except Exception:
        return None, "unparseable"
    if isinstance(d, dict):
        if d.get("error"):
            return None, str(d["error"])[:120]
        d = d.get("entries") or d.get("tasks") or d.get("projects") or d.get("data") or []
    if not isinstance(d, list):
        return None, "unexpected-shape"
    return d, None


def candidate_names(org, word):
    """The same filesystem convention probe_checkout uses, so project matching
    and checkout matching cannot disagree. No hardcoded project ids."""
    if org == "hasna":
        return ["open-" + word, word]
    return [word, "iapp-" + word, "platform-" + word, "open-" + word]


def warm_slow(org, word, tmpdir, projects_cache):
    """Resolve the todos project for a repo and collect its last 3 BUG rows.

    Duplicate project rows are the norm, not the exception: `open-todos` exists
    FOUR times, with 3 / 101 / 58 / 150 task counters on three different
    machine_ids, and the BUG rows are spread across all four (2+7+14+34 = 57).
    Picking by name alone would silently return a 3-task fossil. So the primary
    is chosen by MOST RECENT TASK ACTIVITY, which is derived from the data
    rather than hardcoded, and the duplicate count is reported because an agent
    filing a bug into the wrong row is the hazard this field exists to prevent.
    Bugs are merged across every matching row, so a bug filed into a secondary
    is still seen.
    """
    if projects_cache.get("rows") is None:
        rows, err = todos_json(["projects", "--json"], tmpdir, "warm-projects")
        projects_cache["rows"] = rows if rows is not None else []
        projects_cache["err"] = err
        say(f"    projects: {len(projects_cache['rows'])} rows err={err}")
    rows = projects_cache["rows"]
    if not rows:
        return "no-projects"

    names = candidate_names(org, word)
    matches = [r for r in rows if str(r.get("name") or "") in names]
    if not matches:
        return "no-match"

    per_project, bugs = [], []
    for m in matches[:6]:                       # bound the fan-out
        pid = m.get("id")
        if not pid:
            continue
        trows, err = todos_json(
            ["list", "--project", str(pid), "--json", "--limit", "3000"],
            tmpdir, f"warm-tasks-{str(pid)[:8]}")
        if trows is None:
            say(f"    tasks {str(pid)[:8]}: err={err}")
            continue
        newest = ""
        for r in trows:
            created = str(r.get("created_at") or "")
            newest = max(newest, created)
            title = str(r.get("title") or "")
            if title.strip().upper().startswith("BUG"):
                bugs.append({
                    "date": created[:10] or "?",
                    "status": H.sanitize(r.get("status"), 12) or "?",
                    # Untrusted: written by other agents. Sanitized here AND
                    # again at render time.
                    "title": H.sanitize(title, 96),
                    "project": str(pid)[:8],
                })
        per_project.append({
            "id": str(pid),
            "name": H.sanitize(m.get("name"), 40),
            "path": H.sanitize(m.get("path"), 120),
            "tasks": len(trows),
            "newest": newest,
        })

    if not per_project:
        return "no-tasks-readable"

    per_project.sort(key=lambda p: (p["newest"], p["tasks"]), reverse=True)
    primary = per_project[0]
    bugs.sort(key=lambda b: b["date"], reverse=True)

    H.cache_write(org, word, "slow", {
        "todos_key": primary["name"],
        "project": primary,
        "duplicates": len(per_project),
        "bug_total": len(bugs),
        "bugs": bugs[:3],
    })
    say(f"    slow: primary={primary['id'][:8]} tasks={primary['tasks']} "
        f"dups={len(per_project)} bugs={len(bugs)}")
    return "ok"


# --------------------------------------------------------------------------

def main():
    global VERBOSE
    ap = argparse.ArgumentParser()
    ap.add_argument("tokens", nargs="*", help="org/word, e.g. hasna/todos")
    ap.add_argument("--force", action="store_true", help="ignore age thresholds")
    ap.add_argument("--verbose", action="store_true")
    ap.add_argument("--fast", action="store_true", help="skip the slow todos tier")
    a = ap.parse_args()
    VERBOSE = a.verbose

    explicit = []
    for t in a.tokens:
        if "/" in t:
            org, word = t.split("/", 1)
            if org in ("hasna", "hasnaxyz"):
                explicit.append((org, word))

    if not acquire_lock():
        say("another warmer holds the lock; exiting")
        return 0

    # A killed run (SIGTERM from a cron wrapper, or an operator timeout) does not
    # run `finally`, so it would strand the lock and mute the warmer until the
    # stale-lock window elapsed. Release on signal too.
    import signal

    def _bail(signum, frame):
        release_lock()
        os._exit(143)

    for _sig in (signal.SIGTERM, signal.SIGINT, signal.SIGHUP):
        try:
            signal.signal(_sig, _bail)
        except Exception:
            pass

    started = time.time()
    result = {}
    tmpdir = tempfile.mkdtemp(prefix="hasna-warm-")
    projects_cache = {"rows": None}
    slow_budget = MAX_SLOW_PER_RUN
    try:
        for org, word in select_tokens(explicit):
            key = f"{org}/{word}"
            r = {}
            say(f"  {key}")
            if needs(org, word, "gh", AGE_GH, a.force):
                s = time.time()
                r["gh"] = warm_gh(org, word, tmpdir)
                say(f"    gh: {r['gh']} in {int((time.time()-s)*1000)}ms")
            if needs(org, word, "npm", AGE_NPM, a.force):
                s = time.time()
                r["npm"] = warm_npm(org, word, tmpdir)
                say(f"    npm: {r['npm']} in {int((time.time()-s)*1000)}ms")
            # The slow tier costs 7-42 s per token because each todos call is
            # 5-7 s and a repo can match several project rows. Staggering it
            # keeps any single pass short; the 6 h threshold means a token comes
            # round again long before its entry expires.
            if not a.fast and slow_budget > 0 and \
                    needs(org, word, "slow", AGE_SLOW, a.force):
                s = time.time()
                r["slow"] = warm_slow(org, word, tmpdir, projects_cache)
                slow_budget -= 1
                say(f"    slow: {r['slow']} in {int((time.time()-s)*1000)}ms")
            if r:
                result[key] = r
    finally:
        import shutil
        shutil.rmtree(tmpdir, ignore_errors=True)
        release_lock()

    try:
        H.cache_prune()
        with open(LOG_PATH, "a") as f:
            f.write(json.dumps({
                "at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
                "elapsed_ms": int((time.time() - started) * 1000),
                "result": result,
            }) + "\n")
    except Exception:
        pass

    say(f"done in {int((time.time()-started)*1000)}ms: {result}")
    if explicit and result:
        for org, word in explicit:
            if any(v == "ok" for v in (result.get(f"{org}/{word}") or {}).values()):
                return 0
        return 1
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except KeyboardInterrupt:
        release_lock()
        sys.exit(1)
    except Exception as e:
        release_lock()
        print("warm failed:", type(e).__name__, str(e)[:200], file=sys.stderr)
        sys.exit(1)
