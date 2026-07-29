import { existsSync, lstatSync, readFileSync, realpathSync } from "fs";
import { isAbsolute, join, relative, resolve, sep } from "path";
import { homedir } from "os";
import { commandExists, runCommand, type CodewithHookInput } from "./base";
import { resolveFrom } from "./git-command";

export function defaultWorktreesRoot(): string {
  // Same home for every resolution in this file; see expandHome.
  return process.env.HASNA_REPOS_WORKTREES_ROOT
    || join(process.env.HOME || homedir(), ".hasna", "repos", "worktrees");
}

export function isInsidePath(child: string, parent: string): boolean {
  const rel = relative(resolve(parent), resolve(child));
  return rel === "" || (!!rel && rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

/**
 * Canonical managed-worktree path shape.
 *
 * Source of truth: Hasna Agent Operating Rules rule 8, as published by the
 * @hasna/identities 0.4.4 global agent rules, verbatim:
 *
 *   "must happen in a task-specific worktree at
 *    $HOME/.hasna/repos/worktrees/<repo-name>/<worktree-name>
 *    (repo name then worktree name; no station-id or machine segment,
 *    never flat under the worktrees root)"
 *
 * So, relative to the worktrees root, a compliant worktree root is exactly two
 * segments deep: <repo-name>/<worktree-name>.
 */
export const CANONICAL_WORKTREE_SEGMENTS = 2;

/**
 * Depth of the DEPRECATED station-id lease layout
 * (`<station-id>/<repo-slug>-<hex>/wt_<hex>`) that predates rule 8.
 *
 * Read-only migration tolerance: it is never a compliant target shape, and it is
 * never reported as `managed`. It is recognised only so that (a) guard messages
 * can name it precisely and (b) the scoped dangerous-operation carve-out keeps
 * working for worktrees created before the canonical shape was mandated.
 */
export const LEGACY_LEASE_WORKTREE_SEGMENTS = 3;

// Any ordinary directory name, bounded by the filesystem's own limit rather than an
// allowlist — repo and worktree names are user data, and an over-narrow pattern would
// reject legitimate work (real fleet names include `_base`). Refused: a leading `.`,
// so `.`, `..` and `.git` can never be read as a segment; a leading `-`, so a segment
// can never read as an option in the remediation command; and control characters.
const WORKTREE_SEGMENT_PATTERN = /^[^.\-\/\x00-\x1f][^\/\x00-\x1f]{0,254}$/;
const LEGACY_LEASE_REPO_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9_.-]*-[0-9a-fA-F]{7,16}$/;
const LEGACY_LEASE_ID_PATTERN = /^wt_[0-9a-fA-F]{16,64}$/;

/**
 * Whether the deprecated station-id lease layout still gets its migration tolerance.
 *
 * Default on, so the change does not strand worktrees created before rule 8. It is a
 * kill switch, not a policy knob: the layout is non-compliant either way, and the
 * tolerance only softens the verdict from blocked to warned. Set
 * `HASNA_HOOKS_LEGACY_WORKTREE_TOLERANCE=0` once those worktrees are re-homed; the
 * whole branch goes away after that.
 *
 * Known limitation while it is on: the tolerance keys off the path name, so a newly
 * created worktree deliberately named to match also gets the warn tier. That is an
 * opt-out from a guardrail by a cooperating agent, not a security boundary — the
 * boundary is the provenance proof above, which applies to both tiers.
 */
export function legacyWorktreeToleranceEnabled(): boolean {
  return process.env.HASNA_HOOKS_LEGACY_WORKTREE_TOLERANCE !== "0";
}

export type ManagedWorktreeLayout = "canonical" | "legacy-station-lease";

export interface ManagedWorktreeInfo {
  managed: boolean;
  /** The worktrees root the path was classified against. */
  root: string;
  /** Recognised layout, set for compliant and for deprecated-but-recognised paths. */
  layout?: ManagedWorktreeLayout;
  /** True when the layout is recognised but no longer permitted by rule 8. */
  deprecated?: boolean;
  repo?: string;
  worktree?: string;
  /** Absolute path of the worktree root that owns `cwd`. */
  worktreeRoot?: string;
  reason?: string;
}

/** The canonical worktree path template, for user-facing guard messages. */
export function canonicalWorktreeTemplate(root: string = defaultWorktreesRoot()): string {
  return join(root, "<repo-name>", "<worktree-name>");
}

/**
 * Prove that `worktreeRoot` owns its own git history, synchronously.
 *
 * Shape is not evidence and neither is the mere presence of `.git`. A `.git` file is
 * two lines of text: pointing it at a shared checkout's `.git` grafts a second working
 * tree onto that checkout, so `git commit`/`git push` from the forged directory lands
 * on the shared checkout — the exact outcome rule 10 forbids. So a `.git` file must
 * carry real linked-worktree provenance:
 *
 *   - its `gitdir:` target must live under `<common-dir>/worktrees/`, and
 *   - that target's `gitdir` back-pointer must resolve to this very control file.
 *
 * A `.git` directory is accepted only as a self-contained repository. A `commondir`
 * grafts it onto another repository's history outright, and symlinked `objects` or
 * `refs` graft it onto another repository's refs — reaching the same end state as a
 * forged `.git` file without writing anything inside the victim.
 *
 * This is a structural proof only. It is deliberately close to, but not the same as,
 * the async verifiedLinkedWorktreeRoot() used for the write carve-out, which is
 * stricter still (regular-file control file, nlink === 1, worktrees dir directly
 * under the common dir).
 */
function worktreeProvenanceReason(worktreeRoot: string): string | null {
  const controlPath = join(worktreeRoot, ".git");
  let control;
  try {
    control = lstatSync(controlPath);
  } catch {
    return `${worktreeRoot} is not a git worktree root (no .git)`;
  }
  if (control.isSymbolicLink()) return `worktree .git is a symlink at ${worktreeRoot}`;

  if (control.isDirectory()) {
    if (existsSync(join(controlPath, "commondir"))) {
      return `worktree .git is grafted onto another repository at ${worktreeRoot}`;
    }
    if (!existsSync(join(controlPath, "HEAD"))) return `worktree .git is not a repository at ${worktreeRoot}`;
    // A self-contained repository owns its object and ref storage. Symlinking either
    // into another repository makes commits here land on that repository's refs.
    for (const store of ["objects", "refs"]) {
      let metadata;
      try {
        metadata = lstatSync(join(controlPath, store));
      } catch {
        return `worktree .git is missing ${store} at ${worktreeRoot}`;
      }
      if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
        return `worktree .git ${store} is grafted onto another repository at ${worktreeRoot}`;
      }
    }
    return null;
  }
  if (!control.isFile()) return `worktree .git is not a file or directory at ${worktreeRoot}`;

  try {
    const pointer = readFileSync(controlPath, "utf-8").trim();
    const match = pointer.match(/^gitdir:\s*(.+)$/);
    if (!match?.[1]) return `worktree .git is not a git worktree pointer at ${worktreeRoot}`;
    const gitDir = resolveFrom(worktreeRoot, match[1].trim());
    const commonDir = resolveFrom(gitDir, readFileSync(join(gitDir, "commondir"), "utf-8").trim());
    const physicalGitDir = realpathSync(gitDir);
    const physicalWorktreesDir = realpathSync(join(commonDir, "worktrees"));
    if (physicalGitDir === physicalWorktreesDir || !isInsidePath(physicalGitDir, physicalWorktreesDir)) {
      return `worktree .git points outside its repository's worktrees directory at ${worktreeRoot}`;
    }
    const backPointer = resolveFrom(gitDir, readFileSync(join(gitDir, "gitdir"), "utf-8").trim());
    if (realpathSync(backPointer) !== realpathSync(controlPath)) {
      return `worktree .git is not registered by its repository at ${worktreeRoot}`;
    }
  } catch {
    return `worktree .git provenance could not be verified at ${worktreeRoot}`;
  }
  return null;
}

/**
 * Verify that `<root>/<repo>/<worktree>` is a real, non-symlinked, provenance-checked
 * git worktree root.
 *
 * Path shape alone is not evidence: `<root>/<flat-worktree>/<subdir>` has exactly the
 * same shape as `<root>/<repo>/<worktree>`, so without this check a `cd` into any
 * subdirectory of a flat worktree would launder it into a compliant-looking path.
 * Symlinks are refused at every level (hence lstat, not existsSync, which follows
 * them) because a symlinked segment can aim a canonical-looking path at a shared
 * checkout.
 */
function groundedWorktreeRootReason(root: string, segments: string[]): string | null {
  let probe = resolve(root);
  for (const segment of segments) {
    probe = join(probe, segment);
    let metadata;
    try {
      metadata = lstatSync(probe);
    } catch {
      return `no worktree exists at ${probe}`;
    }
    if (metadata.isSymbolicLink()) return `worktree path traverses a symlink at ${probe}`;
    if (!metadata.isDirectory()) return `worktree path is not a directory at ${probe}`;
  }
  return worktreeProvenanceReason(probe);
}

/**
 * Classify a path against the canonical managed-worktree shape (rule 8).
 *
 * Accepted: a real git worktree root at `<worktrees-root>/<repo-name>/<worktree-name>`,
 * and any path inside it. Rejected, each with a reason: paths outside the worktrees
 * root, the root itself, flat single-segment worktrees, station-id/machine segments,
 * deeper nesting, and canonical-shaped paths that are not actually a worktree root
 * (invented, symlinked, or a subdirectory of a flat worktree).
 */
export function managedWorktreeInfo(cwd: string): ManagedWorktreeInfo {
  const root = defaultWorktreesRoot();
  const canonical = canonicalWorktreeTemplate(root);
  if (!isInsidePath(cwd, root)) return { managed: false, root, reason: "outside worktrees root" };

  const parts = relative(resolve(root), resolve(cwd)).split(sep).filter(Boolean);
  if (parts.length === 0) {
    return { managed: false, root, reason: `path is the worktrees root itself; canonical worktrees live at ${canonical}` };
  }
  if (parts.length < CANONICAL_WORKTREE_SEGMENTS) {
    return {
      managed: false,
      root,
      reason: `worktree is flat under the worktrees root, which rule 8 forbids; canonical shape is ${canonical}`,
    };
  }

  const [repo, worktree] = parts;
  for (const [label, segment] of [["repo-name", repo], ["worktree-name", worktree]] as const) {
    if (!segment || !WORKTREE_SEGMENT_PATTERN.test(segment)) {
      return { managed: false, root, reason: `${label} segment is malformed; canonical shape is ${canonical}` };
    }
  }

  // A canonical classification must be grounded in a real worktree root at depth 2,
  // never in path shape alone: at depth 2 the shape is ambiguous with a subdirectory
  // of a forbidden flat worktree, and at any depth it is ambiguous with an invented
  // or symlinked path.
  const worktreeRoot = resolve(root, repo!, worktree!);
  const rootReason = groundedWorktreeRootReason(root, [repo!, worktree!]);
  if (!rootReason) {
    return { managed: true, root, layout: "canonical", repo, worktree, worktreeRoot };
  }

  if (parts.length === CANONICAL_WORKTREE_SEGMENTS) {
    return { managed: false, root, reason: `${rootReason}; canonical shape is ${canonical}` };
  }

  // Recognised at or inside a legacy lease root, mirroring how a canonical worktree
  // covers its own subdirectories — an agent cwd'd into `src/` of a legacy worktree
  // is in the same non-compliant worktree, and must get the same migration message.
  //
  // The migration tolerance grants a weaker verdict than "blocked", so it has to clear
  // the same grounding as the canonical branch. Otherwise the lease name pattern is a
  // forgery kit: two directories named to match would launder a symlinked or grafted
  // path into a warn-and-allow.
  if (legacyWorktreeToleranceEnabled()
    && parts.length >= LEGACY_LEASE_WORKTREE_SEGMENTS
    && LEGACY_LEASE_REPO_PATTERN.test(parts[1]!)
    && LEGACY_LEASE_ID_PATTERN.test(parts[2]!)) {
    // The layout has two historical variants: the checkout sits at the lease dir, or
    // one level below it in a `repo/` child. Try both, nothing deeper.
    for (const depth of [LEGACY_LEASE_WORKTREE_SEGMENTS, LEGACY_LEASE_WORKTREE_SEGMENTS + 1]) {
      if (parts.length < depth) break;
      const segments = parts.slice(0, depth);
      if (groundedWorktreeRootReason(root, segments)) continue;
      return {
        managed: false,
        root,
        layout: "legacy-station-lease",
        deprecated: true,
        worktreeRoot: resolve(root, ...segments),
        reason: `deprecated station-id lease layout <station-id>/<repo-slug>-<hex>/wt_<hex>; rule 8 forbids a station-id or machine segment — re-home to ${canonical}`,
      };
    }
  }

  return {
    managed: false,
    root,
    reason: `worktree root is ${parts.length} segments under the worktrees root (station-id/machine segment or extra nesting); rule 8 requires the worktree to be created at exactly ${canonical}`,
  };
}

export async function gitRepoRoot(cwd: string): Promise<string | null> {
  if (!commandExists("git")) return null;
  const result = await runCommand(["git", "rev-parse", "--show-toplevel"], { cwd, timeoutMs: 2000 });
  if (result.exitCode !== 0) return null;
  return result.stdout.trim() || null;
}

export async function gitRemoteSlug(cwd: string): Promise<string | null> {
  if (!commandExists("git")) return null;
  const result = await runCommand(["git", "remote", "get-url", "origin"], { cwd, timeoutMs: 2000 });
  if (result.exitCode !== 0) return null;
  const remote = result.stdout.trim();
  if (!remote) return null;
  const match = remote.match(/[:/]([^/:\s]+\/[^/\s]+?)(?:\.git)?$/);
  return match?.[1] || null;
}

/** `origin` normalised to the `host/org/name` form the repos CLI resolves exactly. */
export async function gitRemoteHostSlug(cwd: string): Promise<string | null> {
  if (!commandExists("git")) return null;
  const result = await runCommand(["git", "remote", "get-url", "origin"], { cwd, timeoutMs: 2000 });
  if (result.exitCode !== 0) return null;
  const remote = result.stdout.trim().replace(/\.git$/, "");
  if (!remote) return null;
  const match = remote.match(/^(?:[a-z+]+:\/\/)?(?:[^@/]+@)?([^/:\s]+)[:/](.+)$/i);
  const host = match?.[1];
  const path = match?.[2]?.replace(/^\/+/, "");
  if (!host || !path || !/^[^/\s]+\/[^/\s]+$/.test(path)) return null;
  return `${host}/${path}`;
}

export interface CanonicalRepoIdentity {
  /** The repo name that forms the `<repo-name>` segment of the canonical path. */
  name: string | null;
  defaultBranch: string | null;
}

/**
 * Resolve the canonical repo name via the repos CLI, as rule 8 requires:
 * "Locate repos with the repos CLI (`repos repo <name> --json` for the exact
 * lookup; never fuzzy `repos cd` or 'did you mean' output for targeting)".
 *
 * This matters because the repos-CLI name is frequently NOT the git remote
 * basename — on this fleet 46 of 50 indexed repos differ (`open-hooks` is
 * `github.com/hasna/hooks`, `open-mailery` is `.../emails`). Deriving the
 * canonical path segment from the remote would send every agent to the wrong
 * directory, so the remote is only ever used as the exact lookup key.
 *
 * `--remote host/org/name` is the exact-match form, so no fuzzy "did you mean"
 * output can be mistaken for a hit. OSS-safe: a missing or failing repos CLI
 * yields nulls and the caller falls back to local information.
 */
export async function canonicalRepoIdentity(cwd: string): Promise<CanonicalRepoIdentity> {
  const empty: CanonicalRepoIdentity = { name: null, defaultBranch: null };
  if (!commandExists("repos")) return empty;
  const remote = await gitRemoteHostSlug(cwd);
  if (!remote) return empty;
  // Hard ceiling on the lookup. runCommand's timeout kills the direct child but still
  // awaits its pipes, which a forking CLI can hold open indefinitely; this hook sits on
  // the PreToolUse path, so it must degrade to local information rather than stall.
  const result = await Promise.race([
    runCommand(["repos", "repo", "--remote", remote, "--json"], { cwd, timeoutMs: 1000 }),
    new Promise<null>((done) => setTimeout(() => done(null), 1500).unref?.()),
  ]);
  if (!result || result.exitCode !== 0) return empty;
  try {
    const parsed = JSON.parse(result.stdout) as { name?: unknown; default_branch?: unknown; path?: unknown };
    const name = typeof parsed.name === "string" && parsed.name ? parsed.name : null;
    const defaultBranch = typeof parsed.default_branch === "string" && parsed.default_branch
      ? parsed.default_branch
      : null;

    // The index holds worktree directories as first-class rows, so an exact remote
    // match can resolve to a worktree rather than the repo. Such a row's name is a
    // worktree name and its default_branch is that worktree's branch — both wrong for
    // the canonical path. When the row lives under the worktrees root, the real repo
    // name is its first segment there; the branch is not recoverable, so drop it.
    const worktreesRoot = resolve(defaultWorktreesRoot());
    const rowPath = typeof parsed.path === "string" && parsed.path ? resolve(parsed.path) : null;
    if (rowPath && isInsidePath(rowPath, worktreesRoot) && rowPath !== worktreesRoot) {
      const segment = relative(worktreesRoot, rowPath).split(sep).filter(Boolean)[0];
      return { name: segment || null, defaultBranch: null };
    }
    return { name, defaultBranch };
  } catch {
    return empty;
  }
}

/**
 * Remediation command for work happening outside a canonical worktree.
 *
 * Rule 8: create the worktree at `<worktrees-root>/<repo-name>/<worktree-name>`,
 * named after the todos task where one exists, then `repos scan`. The repos CLI
 * has no worktree verb, so `git worktree` is the creation path.
 *
 * `repo` must be a canonical repo name (see canonicalRepoIdentity) — never a
 * remote slug, which names a different directory for most repos.
 *
 * This is the boundary where names become a command an operator may paste, so every
 * interpolated value is validated here rather than trusted from its source: a repo
 * name is attacker-influenced via the remote, and a task id is unvalidated hook input.
 * Anything unsafe degrades to the explicit placeholder instead of being emitted.
 */
const SAFE_COMMAND_VALUE = /^[a-zA-Z0-9_][a-zA-Z0-9_.\/-]{0,120}$/;

export function claimCommand(repo: string | null, taskId: string | null, defaultBranch: string | null = null): string {
  // A repo name is one path segment: a slug would silently add a third segment.
  const safeRepo = repo && SAFE_COMMAND_VALUE.test(repo) && !repo.includes("/") ? repo : null;
  const safeTask = taskId && SAFE_COMMAND_VALUE.test(taskId) ? taskId : null;
  const safeBase = defaultBranch && SAFE_COMMAND_VALUE.test(defaultBranch) ? defaultBranch : null;

  const repoName = safeRepo || "<repo-name>";
  const worktreeName = safeTask || "<worktree-name>";
  const path = join(defaultWorktreesRoot(), repoName, worktreeName);
  return `git worktree add -b ${worktreeName} ${path} origin/${safeBase || "<default-branch>"} && repos scan`;
}

export function taskIdFrom(input: CodewithHookInput): string | null {
  const candidates = [
    process.env.HASNA_TASK_ID,
    process.env.TASK_ID,
    process.env.CODEWITH_TASK_ID,
    typeof input.task_id === "string" ? input.task_id : undefined,
  ];
  return candidates.find(Boolean) || null;
}

export function runIdFrom(input: CodewithHookInput): string | null {
  const candidates = [
    process.env.HASNA_RUN_ID,
    process.env.RUN_ID,
    process.env.CODEWITH_RUN_ID,
    typeof input.run_id === "string" ? input.run_id : undefined,
    input.turn_id,
    input.session_id,
  ];
  return candidates.find((v): v is string => typeof v === "string" && v.length > 0) || null;
}

export function redactGitleaksOutput(_stdout: string, _stderr: string): string {
  return "Staged secrets scan found possible credential(s). Details redacted; run gitleaks locally to inspect.";
}
