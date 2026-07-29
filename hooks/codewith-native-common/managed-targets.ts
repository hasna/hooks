import { existsSync, lstatSync, readFileSync, realpathSync } from "fs";
import { dirname, isAbsolute, join, parse, relative, resolve, sep } from "path";
import { commandExists, runCommand } from "./base";
import { resolveFrom } from "./git-command";
import {
  globThreatensRule,
  mutatesProtectedPath,
  pathHasGlob,
  threatensProtectedPath,
  type ProtectedPathRule,
} from "./protected-paths";
import {
  CANONICAL_WORKTREE_SEGMENTS,
  LEGACY_LEASE_WORKTREE_SEGMENTS,
  defaultWorktreesRoot,
  isInsidePath,
  managedWorktreeInfo,
} from "./worktrees";

function shouldSkipHasnaTreeRule(targetPath: string, rule: ProtectedPathRule, currentManagedRepoRoot: string | null): boolean {
  if (rule.label !== "Hasna state root ~/.hasna") return false;
  if (!currentManagedRepoRoot) return false;
  const target = resolve(targetPath);
  return isInsidePath(target, currentManagedRepoRoot);
}

function isMissingPathError(error: unknown): boolean {
  return error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT";
}

export function hasUnsafeTargetComponent(worktreesRoot: string, target: string): boolean {
  const relativeTarget = relative(worktreesRoot, target);
  const parts = relativeTarget.split(sep).filter(Boolean);
  if (parts.some((part) => part.toLowerCase() === ".git")) return true;

  const filesystemRoot = parse(target).root;
  const absoluteParts = relative(filesystemRoot, target).split(sep).filter(Boolean);
  let probe = filesystemRoot;
  try {
    if (lstatSync(probe).isSymbolicLink()) return true;
  } catch {
    return true;
  }
  for (const part of absoluteParts) {
    probe = join(probe, part);
    try {
      const metadata = lstatSync(probe);
      if (metadata.isSymbolicLink()) return true;
      if (probe === target && metadata.isFile() && metadata.nlink > 1) return true;
    } catch (error) {
      if (isMissingPathError(error)) return false;
      return true;
    }
  }
  return false;
}

/**
 * Candidate worktree roots for an absolute target, canonical shape first.
 *
 * The canonical root sits at `<worktrees-root>/<repo-name>/<worktree-name>`
 * (CANONICAL_WORKTREE_SEGMENTS). The deprecated station-id lease layout sits one
 * level deeper. Order matters: a canonical worktree that happens to contain a
 * subdirectory must resolve to the canonical root, never to the subdirectory.
 */
function managedWorktreeRootCandidates(worktreesRoot: string, target: string): string[] {
  const parts = relative(worktreesRoot, target).split(sep).filter(Boolean);
  const depths = [CANONICAL_WORKTREE_SEGMENTS, LEGACY_LEASE_WORKTREE_SEGMENTS];
  return depths
    .filter((depth) => parts.length >= depth)
    .map((depth) => resolve(worktreesRoot, ...parts.slice(0, depth)));
}

/**
 * Worktree roots that could own `target`, for the scoped dangerous-operation
 * carve-out only.
 *
 * This is a structural lookup ("could a real managed worktree own this path?"),
 * not a policy check ("is this path canonical?"). It therefore keeps the
 * deprecated station-id lease layout as a candidate, so that worktrees created
 * before rule 8 keep their `~/.hasna` write carve-out during migration. Policy
 * enforcement lives in managedWorktreeInfo() / worktree-guard.
 *
 * Both depths are returned when both are plausible, because path shape alone
 * cannot tell a canonical root from a legacy lease container. Each candidate is
 * still verified against Git provenance by the caller, which fails closed.
 */
function managedLeaseRootCandidates(worktreesRoot: string, target: string): string[] {
  return managedWorktreeRootCandidates(worktreesRoot, target).filter((candidate) => {
    const info = managedWorktreeInfo(candidate);
    return info.managed || info.layout === "legacy-station-lease";
  });
}

async function verifiedLinkedWorktreeRoot(leaseRoot: string): Promise<string | null> {
  const controlFile = join(leaseRoot, ".git");
  try {
    const metadata = lstatSync(controlFile);
    if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.nlink !== 1) return null;
  } catch {
    return null;
  }

  if (!commandExists("git")) return null;
  const result = await runCommand([
    "git",
    "rev-parse",
    "--show-toplevel",
    "--absolute-git-dir",
    "--git-common-dir",
  ], { cwd: leaseRoot, timeoutMs: 2000 });
  if (result.exitCode !== 0) return null;
  const [repoRootRaw, gitDirRaw, commonDirRaw] = result.stdout.trim().split(/\r?\n/);
  if (!repoRootRaw || !gitDirRaw || !commonDirRaw) return null;

  const repoRoot = resolve(repoRootRaw);
  const gitDir = resolveFrom(leaseRoot, gitDirRaw);
  const commonDir = resolveFrom(leaseRoot, commonDirRaw);
  if (repoRoot !== resolve(leaseRoot)) return null;
  try {
    const physicalGitDir = realpathSync(gitDir);
    const physicalCommonDir = realpathSync(commonDir);
    const physicalWorktreesDir = realpathSync(join(commonDir, "worktrees"));
    if (physicalGitDir === physicalWorktreesDir || !isInsidePath(physicalGitDir, physicalWorktreesDir)) return null;
    if (dirname(physicalWorktreesDir) !== physicalCommonDir) return null;

    const commondirPointer = readFileSync(join(gitDir, "commondir"), "utf-8").trim();
    const gitdirPointer = readFileSync(join(gitDir, "gitdir"), "utf-8").trim();
    if (!commondirPointer || !gitdirPointer) return null;
    if (realpathSync(resolveFrom(gitDir, commondirPointer)) !== physicalCommonDir) return null;
    const expectedControlFile = resolve(controlFile);
    const backPointer = resolveFrom(gitDir, gitdirPointer);
    if (backPointer !== expectedControlFile) return null;
    if (realpathSync(backPointer) !== realpathSync(expectedControlFile)) return null;
  } catch {
    return null;
  }
  return repoRoot;
}

export async function managedRepoRootForAbsoluteTarget(
  targetPath: string,
  repoRootCache: Map<string, Promise<string | null>>,
): Promise<string | null> {
  if (!isAbsolute(targetPath)) return null;
  const worktreesRoot = resolve(defaultWorktreesRoot());
  const target = resolve(targetPath);
  if (target === worktreesRoot || !isInsidePath(target, worktreesRoot)) return null;
  if (hasUnsafeTargetComponent(worktreesRoot, target)) return null;

  let physicalWorktreesRoot: string;
  try {
    physicalWorktreesRoot = realpathSync(worktreesRoot);
  } catch {
    return null;
  }

  for (const leaseRoot of managedLeaseRootCandidates(worktreesRoot, target)) {
    const repoRoot = await verifiedManagedRepoRoot(leaseRoot, target, physicalWorktreesRoot, repoRootCache);
    if (repoRoot) return repoRoot;
  }
  return null;
}

async function verifiedManagedRepoRoot(
  leaseRoot: string,
  target: string,
  physicalWorktreesRoot: string,
  repoRootCache: Map<string, Promise<string | null>>,
): Promise<string | null> {
  let repoRootPromise = repoRootCache.get(leaseRoot);
  if (!repoRootPromise) {
    repoRootPromise = verifiedLinkedWorktreeRoot(leaseRoot);
    repoRootCache.set(leaseRoot, repoRootPromise);
  }
  const repoRoot = await repoRootPromise;
  if (!repoRoot) return null;
  const resolvedRepoRoot = resolve(repoRoot);
  if (resolvedRepoRoot !== resolve(leaseRoot)) return null;
  try {
    const physicalRepoRoot = realpathSync(resolvedRepoRoot);
    if (physicalRepoRoot === physicalWorktreesRoot || !isInsidePath(physicalRepoRoot, physicalWorktreesRoot)) return null;
    const probe = dirname(target);
    let existingProbe = probe;
    while (true) {
      try {
        lstatSync(existingProbe);
        break;
      } catch (error) {
        if (!isMissingPathError(error)) return null;
      }
      const parent = dirname(existingProbe);
      if (parent === existingProbe || !isInsidePath(parent, resolvedRepoRoot)) return null;
      existingProbe = parent;
    }
    const physicalProbe = realpathSync(existingProbe);
    const missingSuffix = relative(existingProbe, target);
    if (!missingSuffix || missingSuffix === ".." || missingSuffix.startsWith(`..${sep}`) || isAbsolute(missingSuffix)) return null;
    const physicalTarget = existsSync(target)
      ? realpathSync(target)
      : resolve(physicalProbe, missingSuffix);
    if (physicalTarget === physicalRepoRoot || !isInsidePath(physicalTarget, physicalRepoRoot)) return null;
  } catch {
    return null;
  }
  return resolvedRepoRoot;
}

export function threatensRule(targetPath: string, rule: ProtectedPathRule, currentManagedRepoRoot: string | null): boolean {
  if (shouldSkipHasnaTreeRule(targetPath, rule, currentManagedRepoRoot)) return false;
  if (pathHasGlob(targetPath)) return globThreatensRule(targetPath, rule);
  return threatensProtectedPath(targetPath, rule);
}

export function mutatesRule(targetPath: string, rule: ProtectedPathRule, currentManagedRepoRoot: string | null): boolean {
  if (shouldSkipHasnaTreeRule(targetPath, rule, currentManagedRepoRoot)) return false;
  return mutatesProtectedPath(targetPath, rule);
}
