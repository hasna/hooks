import { isAbsolute, join, relative, resolve, sep } from "path";
import { homedir } from "os";
import type { CodewithHookInput } from "./base";
import { resolveFrom } from "./git-command";
import { defaultWorktreesRoot, gitRepoRoot, isInsidePath } from "./worktrees";

export interface DangerousOperationMatch {
  block: boolean;
  reason?: string;
  targetPath?: string;
  protectedPath?: string;
  protectedLabel?: string;
  operation?: string;
}

export interface ProtectedPathRule {
  root: string;
  label: string;
  mode: "tree" | "root";
}

export interface ProtectedPathContext {
  rules: ProtectedPathRule[];
  workspaceRoots: string[];
  currentManagedRepoRoot: string | null;
}

function splitPathList(value: unknown): string[] {
  if (typeof value === "string") return value.split(":").map((v) => v.trim()).filter(Boolean);
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => splitPathList(item));
}

function inputPathList(input: CodewithHookInput, ...keys: string[]): string[] {
  const out: string[] = [];
  for (const key of keys) out.push(...splitPathList(input[key]));
  return out;
}

function uniqueResolved(paths: string[], cwd: string): string[] {
  return [...new Set(paths.map((path) => resolveFrom(cwd, path)))];
}

function workspaceRootsFor(input: CodewithHookInput, cwd: string): string[] {
  const home = process.env.HOME || homedir();
  const candidates = [
    ...inputPathList(input, "workspace_roots", "workspaceRoots", "workspace_root", "workspaceRoot"),
    ...splitPathList(process.env.CODEWITH_WORKSPACE_ROOTS),
    ...splitPathList(process.env.HASNA_WORKSPACE_ROOTS),
    join(home, "workspace"),
    join(home, "Workspace"),
  ];
  return uniqueResolved(candidates, cwd);
}

function activeRootsFor(input: CodewithHookInput, cwd: string): string[] {
  const candidates = [
    ...inputPathList(input, "active_repo_roots", "activeRepoRoots", "active_worktree_roots", "activeWorktreeRoots"),
    ...splitPathList(process.env.HASNA_ACTIVE_REPO_ROOTS),
    ...splitPathList(process.env.HASNA_ACTIVE_WORKTREE_ROOTS),
  ];
  return uniqueResolved(candidates, cwd);
}

/**
 * Filesystem roots a recursive delete must never target wholesale: the FHS system
 * directories plus their macOS equivalents, and `/` itself.
 *
 * `/` is here because of the 2026-07-24 station02 incident: `rm -rf "$(bun pm cache)"/*`
 * ran as `rm -rf /*` after the substitution collapsed to empty, freed ~700 GB and
 * permanently destroyed one repository's only source copy. Every entry is matched in
 * "root" mode, so `rm -rf /usr` and `rm -rf /usr/*` block while `rm -rf /usr/local/lib/mine`
 * stays allowed - the guard is about wholesale wipes, not targeted deletes.
 *
 * `/tmp` is deliberately absent: scratch cleanup there is routine and bounded.
 * Machine-specific additions come from HASNA_PROTECTED_SYSTEM_ROOTS (colon-separated).
 */
export const SYSTEM_PROTECTED_ROOTS: readonly string[] = [
  "/",
  "/bin",
  "/boot",
  "/dev",
  "/etc",
  "/home",
  "/lib",
  "/lib32",
  "/lib64",
  "/libx32",
  "/opt",
  "/proc",
  "/root",
  "/run",
  "/sbin",
  "/srv",
  "/sys",
  "/usr",
  "/var",
  "/Applications",
  "/Library",
  "/System",
  "/Users",
  "/Volumes",
  "/private",
];

function systemProtectedRulesFor(cwd: string): ProtectedPathRule[] {
  const roots = uniqueResolved(
    [...SYSTEM_PROTECTED_ROOTS, ...splitPathList(process.env.HASNA_PROTECTED_SYSTEM_ROOTS)],
    cwd
  );
  return roots.map((root) => ({
    root,
    label: root === sep ? "filesystem root /" : `system root ${root}`,
    mode: "root" as const,
  }));
}

export function hasnaDivisionRuleFor(target: string, workspaceRoot: string): ProtectedPathRule | null {
  const rel = relative(resolve(workspaceRoot), resolve(target));
  if (!rel || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return null;
  const parts = rel.split(sep).filter(Boolean);
  if (!parts[0]?.startsWith("hasna")) return null;
  if (parts.length === 1) {
    return { root: resolve(workspaceRoot, parts[0]), label: `Hasna division root ${parts[0]}`, mode: "root" };
  }
  if (parts.length === 2) {
    return { root: resolve(workspaceRoot, parts[0], parts[1]), label: `Hasna top-level scope ${parts[0]}/${parts[1]}`, mode: "root" };
  }
  return null;
}

export async function protectedPathContextFor(input: CodewithHookInput, cwd: string): Promise<ProtectedPathContext> {
  const home = process.env.HOME || homedir();
  const rules: ProtectedPathRule[] = [
    // System roots first so a root wipe is reported as the root wipe it is, rather than as
    // whichever Hasna path happened to sit underneath it. Overlapping paths are deduplicated
    // below with the Hasna rule's more specific label winning.
    ...systemProtectedRulesFor(cwd),
    { root: join(home, ".hasna"), label: "Hasna state root ~/.hasna", mode: "tree" },
  ];
  const workspaceRoots = workspaceRootsFor(input, cwd);

  for (const root of workspaceRoots) {
    rules.push({ root, label: "workspace root", mode: "root" });
  }

  const repoRoot = await gitRepoRoot(cwd);
  if (repoRoot) rules.push({ root: repoRoot, label: "active repository root", mode: "root" });

  for (const root of activeRootsFor(input, cwd)) {
    rules.push({ root, label: "active repository or worktree root", mode: "root" });
  }

  const worktreesRoot = resolve(defaultWorktreesRoot());
  const isCurrentManagedRepo = repoRoot !== null
    && isInsidePath(cwd, worktreesRoot)
    && isInsidePath(repoRoot, worktreesRoot);
  const currentManagedRepoRoot = isCurrentManagedRepo ? resolve(repoRoot) : null;

  return {
    rules: [...new Map(rules.map((rule) => [resolve(rule.root), { ...rule, root: resolve(rule.root) }])).values()],
    workspaceRoots,
    currentManagedRepoRoot,
  };
}

export function threatensProtectedPath(targetPath: string, rule: ProtectedPathRule): boolean {
  const target = resolve(targetPath);
  const root = resolve(rule.root);
  if (rule.mode === "tree") {
    return isInsidePath(target, root) || isInsidePath(root, target);
  }
  return target === root || isInsidePath(root, target);
}

export function mutatesProtectedPath(targetPath: string, rule: ProtectedPathRule): boolean {
  const target = resolve(targetPath);
  const root = resolve(rule.root);
  if (rule.mode === "tree") return isInsidePath(target, root);
  return target === root;
}

// A trailing glob that matches every entry, so `dir/*` destroys all of `dir`.
const CATCH_ALL_GLOB = /^(?:\*|\*\*|\.\*|\.\[!\.\]\*)$/;

/**
 * Match one glob path component against one literal name, without a regular expression.
 *
 * Written as a linear matcher on purpose, for two reasons that both bit this branch:
 *
 *  - Regex ESCAPING of `[`/`]` made `[e]tc` compile to a literal no directory can equal, so
 *    `rm -rf /[e]tc` - which bash expands to `/etc` - matched no protected root.
 *  - Regex COMPILATION of `*` as `[^/]*` backtracked exponentially: a ~70-character protected
 *    root component with a dozen `*b` groups took over 45s against this hook's 20s timeout,
 *    and a timed-out hook fails open. Two fail-opens in the same helper.
 *
 * A two-pointer wildcard match is O(pattern x name) worst case with no backtracking blowup,
 * and bracket handling is explicit rather than delegated to regex syntax that does not mean
 * the same thing. Unmatched constructs fall back to "matches", never to "does not match":
 * an under-match is silent and fails open, which is exactly how `[e]tc` got through.
 */
function bracketExpressionEnd(pattern: string, open: number): number {
  let i = open + 1;
  if (pattern[i] === "!" || pattern[i] === "^") i += 1;
  // A `]` in first position is a literal member, not the terminator.
  if (pattern[i] === "]") i += 1;
  while (i < pattern.length) {
    const ch = pattern[i];
    if (ch === "\\") { i += 2; continue; }
    if (ch === "[" && (pattern[i + 1] === ":" || pattern[i + 1] === "=" || pattern[i + 1] === ".")) {
      const kind = pattern[i + 1];
      const classClose = pattern.indexOf(`${kind}]`, i + 2);
      const plainClose = pattern.indexOf("]", i + 2);
      // The `:]` must come before the next plain `]`, or this is not a class and that `]`
      // closes the bracket. Searching to end-of-component let a `:]` belonging to a LATER
      // bracket be taken as this one's, swallowing the real terminator - so `[u[:]` absorbed
      // the next expression and `/[u[:][[:alpha:]]r`, which bash expands to /usr, matched
      // nothing at all. 158 commands onto live system roots were allowed by that one line.
      if (classClose === -1 || (plainClose !== -1 && plainClose < classClose)) {
        return plainClose;
      }
      i = classClose + 2;
      continue;
    }
    if (ch === "]") return i;
    i += 1;
  }
  return -1;
}

/**
 * Does this bracket expression match `ch`?
 *
 * Returns TRUE whenever the expression contains anything this matcher does not model exactly.
 * That direction is the entire design, and it is the correction for six consecutive rounds of
 * one defect: every bracket bug on this branch has been an UNDER-match, and an under-match
 * means a protected root goes unmatched and the delete is allowed. `[e]tc`, `[[:lower:]]`,
 * `[e[:]tc`, `[![:foo:]]` and `[a\]e]` each named a real path in bash while the guard held a
 * pattern that could match nothing at all.
 *
 * Over-matching costs a false block on a construct almost nobody writes. Under-matching costs
 * a filesystem. So POSIX classes, equivalence and collating classes, and backslash escapes are
 * all treated as matching rather than as not-matching.
 */
function bracketMatches(pattern: string, open: number, close: number, ch: string): boolean {
  const body = pattern.slice(open + 1, close);
  const negated = body.startsWith("!") || body.startsWith("^");
  const members = negated ? body.slice(1) : body;

  // Anything not modelled exactly: fail closed by matching.
  if (/\\|\[[:=.]/.test(members)) return true;

  let matched = false;
  let first = true;
  for (let i = 0; i < members.length; i += 1) {
    const member = members[i];
    if (member === "]" && !first) break;
    if (members[i + 1] === "-" && i + 2 < members.length && members[i + 2] !== "]") {
      if (ch >= member && ch <= members[i + 2]) matched = true;
      i += 2;
    } else if (ch === member) {
      matched = true;
    }
    first = false;
  }
  return negated ? !matched : matched;
}

/**
 * Two-pointer wildcard match. Backtracking is limited to the last `*`, so it stays linear in
 * practice - the compiled-regex version it replaced backtracked exponentially and blew past
 * this hook's 20s timeout, which fails open.
 *
 * An unterminated or unparseable bracket makes the REST of the component match anything,
 * rather than degrading `[` to a literal. The literal reading is an under-match, and
 * `rm -rf /[e[:]tc` - which bash expands to `/etc` - slipped through on exactly that path.
 */
function globMatches(pattern: string, name: string): boolean {
  let p = 0;
  let n = 0;
  let starPattern = -1;
  let starName = 0;

  while (n < name.length) {
    const ch = pattern[p];

    if (p < pattern.length && ch === "*") {
      starPattern = p;
      starName = n;
      p += 1;
      continue;
    }
    if (p < pattern.length && ch === "?") {
      p += 1;
      n += 1;
      continue;
    }
    if (p < pattern.length && ch === "[") {
      const close = bracketExpressionEnd(pattern, p);
      if (close === -1) return true;
      if (bracketMatches(pattern, p, close, name[n])) {
        p = close + 1;
        n += 1;
        continue;
      }
    } else if (p < pattern.length) {
      const literal = ch === "\\" && p + 1 < pattern.length ? pattern[p + 1] : ch;
      const width = ch === "\\" && p + 1 < pattern.length ? 2 : 1;
      if (literal === name[n]) {
        p += width;
        n += 1;
        continue;
      }
    }

    if (starPattern === -1) return false;
    starName += 1;
    n = starName;
    p = starPattern + 1;
  }

  while (pattern[p] === "*") p += 1;
  return p >= pattern.length;
}

/**
 * Does this glob keep no literal text that anchors it, so it can match essentially any name?
 * `[a-z]*`, `?*`, `.??*` and `*.*` are unanchored; `*.log` and `tmp-*` are anchored.
 */
function isUnanchoredGlob(pattern: string): boolean {
  if (!/[*?[]/.test(pattern)) return false;
  // Computed once, not per bracket: a `[` with no `]` anywhere is a literal character, so a
  // directory named `backup[2026` is anchored by its own name and is not a sweep.
  const bracketsArePatterns = pattern.includes("]");
  let residue = "";
  for (let i = 0; i < pattern.length; i += 1) {
    const ch = pattern[i];
    if (ch === "\\" && i + 1 < pattern.length) { residue += pattern[i + 1]; i += 1; continue; }
    if (ch === "*" || ch === "?") continue;
    if (ch === "[" && bracketsArePatterns) {
      const close = bracketExpressionEnd(pattern, i);
      // Unparseable: the rest matches anything, so nothing after it can anchor. Returning
      // here also keeps this linear - re-scanning to end-of-pattern from every `[` was
      // quadratic, and a 20k-bracket flood took 22s against the 20s timeout, failing open.
      if (close === -1) return true;
      i = close;
      continue;
    }
    residue += ch;
  }
  // A leading dot does not anchor: `.??*` sweeps a directory just as `*` does. Nor does
  // punctuation alone: `*.*` takes every dotted entry at the root.
  return residue.replace(/^\./, "").replace(/[.\-_]/g, "").length === 0;
}


/** Does this component actually glob, or is it a literal that merely contains a bracket? */
function componentIsPattern(component: string): boolean {
  if (/[*?]/.test(component)) return true;
  return component.includes("[") && component.includes("]");
}

export function globComponentMatches(pattern: string, literal: string): boolean {
  if (!/[*?[]/.test(pattern)) return pattern === literal;
  // `[` with no `]` anywhere and no other wildcard is a literal bracket, not an expression.
  // Without this, a directory genuinely named `backup[2026` was escalated to "wipes the
  // repository root" - fail-closed matching has to stop where bash stops globbing.
  if (!pattern.includes("]") && !/[*?]/.test(pattern)) return pattern === literal;
  // Fail closed on an ambiguous BOUNDARY, not just ambiguous contents.
  //
  // This is the defect that survived eight review rounds. Bracket CONTENTS already failed
  // closed, but the boundary was still computed exactly - and every disagreement with bash
  // about where a bracket ENDS misaligns the rest of the component and silently reports "no
  // match", which allows the delete. Round 6 searched to end-of-component for the class
  // terminator and swallowed later brackets; round 7 stopped at the first plain `]`, which is
  // backwards (inside `[:`, a plain `]` does not terminate) and reopened the class net worse:
  // 220 -> 380 live root-wipe escapes.
  //
  // Every one of those 380 contained `[:`, `[=` or `[.`. Plain brackets, ranges, negation,
  // `*`, `?` and backslash escapes were measured clean across 44,867 dangerous patterns. So
  // the guard stops trying to locate a boundary it cannot pin down: a component containing a
  // POSIX class, equivalence class or collating symbol matches anything.
  if (/\[[:=.]/.test(pattern)) return true;
  if (CATCH_ALL_GLOB.test(pattern)) return true;
  return globMatches(pattern, literal);
}

/**
 * Could this glob pattern match `root` itself, or an ancestor of it?
 *
 * If it can, every expansion that lands there takes `root` with it. A pattern DEEPER than
 * `root` cannot: `*​/node_modules` from a repo root deletes `<child>/node_modules`, never the
 * repo root, which is why matching only on "the first glob's parent directory" wrongly blocked
 * `rm -rf *​/node_modules` - a daily monorepo command, and exactly the kind of false positive
 * that gets a guard switched off.
 */
function globPatternCovers(patternParts: string[], rootParts: string[]): boolean {
  if (patternParts.length > rootParts.length) return false;
  return patternParts.every((part, index) => globComponentMatches(part, rootParts[index]));
}

/** Components of the pattern up to, but not including, its first glob component. */
function literalPrefixOf(parts: string[]): string {
  const globIndex = parts.findIndex((part) => /[*?[]/.test(part));
  return (globIndex === -1 ? parts : parts.slice(0, globIndex)).join(sep) || sep;
}

export function pathHasGlob(targetPath: string): boolean {
  return /[*?[]/.test(resolve(targetPath));
}

/**
 * Does a glob delete threaten this rule?
 *
 * Two ways, and both are needed:
 *  (a) the pattern can match the protected root or an ancestor of it - `rm -rf /*` matches
 *      `/home`, `rm -rf /*​/*` matches `/home/hasna`;
 *  (b) the pattern is a wholesale wipe of the root's own contents - `rm -rf /home/*`, whose
 *      last component is a catch-all and whose prefix covers `/home`.
 * For a tree rule, a pattern sitting inside the tree also threatens it.
 */
export function globThreatensRule(targetPath: string, rule: ProtectedPathRule): boolean {
  const parts = resolve(targetPath).split(sep);
  const rootParts = resolve(rule.root).split(sep);

  if (rule.mode === "tree") {
    if (isInsidePath(literalPrefixOf(parts), rule.root)) return true;
    // A pattern deeper than the root can still land inside it: `~/.h*/repos` matches
    // ~/.hasna/repos. literalPrefixOf stops before the first glob, so it misses this.
    if (parts.length > rootParts.length && globPatternCovers(parts.slice(0, rootParts.length), rootParts)) {
      return true;
    }
  }
  if (globPatternCovers(parts, rootParts)) return true;

  const last = parts[parts.length - 1];
  if (CATCH_ALL_GLOB.test(last) && globPatternCovers(parts.slice(0, -1), rootParts)) return true;

  // A glob in the last component sweeps the contents of its own parent. When that parent IS
  // the protected root AND the pattern is unanchored, the sweep guts the root: `rm -rf [a-z]*`
  // or `?*` at a repo root take almost everything.
  //
  // "Unanchored" means no literal character survives once wildcards are removed. That
  // distinction is the whole point: `*.log`, `tmp-*`, `.turbo*` and `snapshot-[0-9]*` are
  // anchored by their literal text and cannot take the root, and blocking them - which the
  // blunt any-metacharacter version did - re-broke twelve everyday repo-root cleanups. A
  // guard that blocks routine work gets switched off.
  if (isUnanchoredGlob(last) && mutatesProtectedPath(parts.slice(0, -1).join(sep) || sep, rule)) return true;

  // A catch-all in the FIRST component sweeps every top-level directory: `/*/bin` deletes
  // /usr/bin, /var/bin and the rest, and a trailing literal makes the pattern deeper than any
  // single root, so component matching alone misses it. Scoped to the filesystem root so
  // ordinary sweeps deeper down - `/opt/*/logs`, `/var/*/tmp`, `*/node_modules` - stay allowed.
  // At the filesystem root, ANY glob in the first component reaches several top-level
  // directories: `/*r*/lib` matched 11 of 25 entries on the reference machine, and `/?*/bin`
  // and `/[a-z]*/bin` reach /usr/bin exactly as `/*/bin` does. A single literal character is
  // not an anchor at this depth, so the sweep rule does not ask for one. The cost is refusing
  // `rm -rf /tmp*/x`, which is rare and safe to spell out literally.
  if (rule.root === sep && parts.length > 1 && componentIsPattern(parts[1])) return true;

  return false;
}

const MAX_BRACE_EXPANSIONS = 64;
const MAX_BRACE_ROUNDS = 16;

/** Expand only the leftmost brace group of a token; null when there is none to expand. */
function expandLeftmostBrace(token: string): string[] | null {
  // Skip `${…}` parameter expansions when looking for an alternation: their brace is not a
  // brace group, and treating it as one abandoned expansion for the whole token, so
  // `rm -rf "${HOME}"/{,.hasna}` was never expanded at all.
  let open = -1;
  for (let i = 0; i < token.length; i += 1) {
    if (token[i] !== "{") continue;
    if (i > 0 && token[i - 1] === "$") {
      let depth = 0;
      for (; i < token.length; i += 1) {
        if (token[i] === "{") depth += 1;
        else if (token[i] === "}") { depth -= 1; if (depth === 0) break; }
      }
      continue;
    }
    open = i;
    break;
  }
  if (open === -1) return null;

  let depth = 0;
  let close = -1;
  const parts: string[] = [];
  let current = "";
  for (let i = open; i < token.length; i += 1) {
    const ch = token[i];
    if (ch === "\\") { current += ch + (token[i + 1] ?? ""); i += 1; continue; }
    if (ch === "{") {
      depth += 1;
      if (depth === 1) continue;
    } else if (ch === "}") {
      depth -= 1;
      if (depth === 0) { close = i; break; }
    } else if (ch === "," && depth === 1) {
      parts.push(current);
      current = "";
      continue;
    }
    current += ch;
  }
  if (close === -1 || parts.length === 0) return null;
  parts.push(current);

  const prefix = token.slice(0, open);
  const suffix = token.slice(close + 1);
  return parts.map((part) => `${prefix}${part}${suffix}`);
}

/**
 * Expand `{a,b}` alternations, so `rm -rf /{bin,etc,home}` is seen as the three root deletes
 * it performs rather than as one literal path.
 *
 * Expansion is breadth-first and abandoned the moment it exceeds the cap, because brace
 * expansion is combinatorial: `/{a,b}` repeated 26 times is 2^26 paths. A recursive version
 * that capped only the finished list took 19.75s on that input, past this hook's 20s timeout
 * - and a hook that times out fails open, so a long enough brace string would have switched
 * the guard off and then run the delete.
 *
 * Abandoning does NOT return the raw token. Doing that was itself a bypass:
 * `rm -rf /{a0,…,a69,etc}` exceeded the cap and the unexpanded token resolved to a literal
 * path matching no protected root. Instead the brace-free prefix is returned as a catch-all
 * wipe, which is what an unbounded alternation under that prefix actually is - every
 * expansion is necessarily a child of it.
 */
function braceAbandonFallback(token: string): string[] {
  const open = token.indexOf("{");
  const prefix = open === -1 ? token : token.slice(0, open);
  const base = prefix.endsWith(sep) || prefix === "" ? prefix : `${prefix}${sep}`;
  const fallback = [`${base}*`];
  // An alternative that is itself absolute is NOT a child of the prefix: `rm -rf {/etc,a0,…}`
  // expands to `rm -rf /etc a0 …`, so the prefix-based fallback would miss `/etc` entirely.
  if (/[{,]\s*\//.test(token)) fallback.push(`${sep}*`);
  return fallback;
}

export function expandBraces(token: string): string[] {
  if (!token.includes("{")) return [token];

  let frontier = [token];
  for (let round = 0; round < MAX_BRACE_ROUNDS; round += 1) {
    const next: string[] = [];
    let expandedAny = false;
    for (const item of frontier) {
      const parts = expandLeftmostBrace(item);
      if (parts === null) {
        next.push(item);
        continue;
      }
      expandedAny = true;
      for (const part of parts) {
        if (next.length >= MAX_BRACE_EXPANSIONS) return braceAbandonFallback(token);
        next.push(part);
      }
    }
    if (!expandedAny) return next;
    frontier = next;
  }
  return braceAbandonFallback(token);
}

// `${VAR:?}` / `${VAR:?message}` aborts the shell when VAR is unset *or* empty, so this
// form cannot collapse. It is the POSIX way to assert a path is present, and blocking it
// would punish exactly the defensive code this guard asks for. `${VAR?}` without the colon
// is NOT exempt: it permits an empty value, which is the whole hazard.
