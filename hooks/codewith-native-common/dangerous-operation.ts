import { isAbsolute, resolve } from "path";
import { homedir } from "os";
import { getCommand, type CodewithHookInput } from "./base";
import {
  expandHome,
  resolveFrom,
  shellWords,
  splitShellSegments,
  splitShellSegmentsDetailed,
} from "./git-command";
import {
  expandBraces,
  hasnaDivisionRuleFor,
  protectedPathContextFor,
  type DangerousOperationMatch,
  type ProtectedPathRule,
} from "./protected-paths";
import { assignmentWalker, emptyExpansionCollapse } from "./shell-expansions";
import {
  hasUnsafeTargetComponent,
  managedRepoRootForAbsoluteTarget,
  mutatesRule,
  threatensRule,
} from "./managed-targets";
import {
  destructiveTarget,
  findDestructiveTargets,
  gitDestructiveTargets,
  keepRemoteTarget,
  rmCommandTargets,
  rsyncDeleteTargets,
  shellCommandLayers,
  substituteWorkingDirectory,
  truncatedAnalysisBlockReason,
  type DestructiveShellTarget,
} from "./destructive-targets";
import { defaultWorktreesRoot, isInsidePath } from "./worktrees";

interface CommandChunk {
  segment: string;
  /** Index of this segment in the layer, so assignment visibility can be ordered. */
  segmentIndex: number;
  /** Working directories this segment may run in: the tracked cwd, plus the cwd a `cd`
   *  whose operand collapsed to empty would have left behind. */
  cwds: string[];
  /** An absolute `cd` inside this layer fixed the directory, so it is known even remotely. */
  explicitCwd: boolean;
}

const MAX_CWD_VARIANTS = 4;
// Linux PATH_MAX. A tracked cwd longer than this cannot correspond to a real directory.
const MAX_TRACKED_CWD_LENGTH = 4096;
// Beyond this many `cd`s the guard stops modelling the shell and fails closed; see below.
const MAX_CD_OPERATIONS = 2000;
// Far above any command a person or agent writes; below the size where tokenizing alone
// exceeds the hook's 20s budget.
// Measured on this file's own paths: 1 MB -> 264ms, 16 MB -> 3.5s, 64 MB -> 14.3s against a
// 20s budget. The previous 1 MB threshold bought nothing and cost the fail-closed property.
const MAX_ANALYSABLE_COMMAND_LENGTH = 32_000_000;

/**
 * Raised whenever the guard stops being able to model the command exactly.
 *
 * Every bound in this file must funnel through here. Three bounds added in one round each
 * invented their own fallback - skip the operand, keep the last directory, add `/` to the
 * candidate set - and all three turned into root wipes, because "I cannot model this" was
 * quietly answered as "so carry on". A degraded analysis carrying a recursive delete is
 * refused instead.
 */
interface AnalysisState {
  degraded: boolean;
}

/**
 * Segments of one layer paired with the working directories in effect when they run.
 *
 * Without this, `cd / && rm -rf *` reads as a glob over wherever the agent started, which is
 * the cheapest possible way around a guard that only inspects the literal target. The
 * collapsed variant covers `cd "$(cmd)"/ && rm -rf ./*`, which is the incident's shape moved
 * one command to the left.
 */
function cwdTrackedSegments(command: string, baseCwd: string, nonEmptyNames: ReadonlySet<string>, analysis: AnalysisState): CommandChunk[] {
  const chunks: CommandChunk[] = [];
  const home = process.env.HOME || homedir();
  // One entry per subshell nesting depth. A `cd` inside `( … )` DOES apply to the rest of
  // that subshell - it just does not escape to the parent - so skipping isolated `cd`
  // outright left `(cd / && rm -rf *)`, the standard "cd without moving my shell" idiom,
  // completely unguarded. Depth 0 is the parent shell.
  let cdOperations = 0;
  let stack: Array<{ group: number; cwds: string[]; previous: string[]; dirStack: string[][]; explicit: boolean }> = [
    { group: 0, cwds: [baseCwd], previous: [baseCwd], dirStack: [], explicit: false },
  ];

  const frameFor = (depth: number, group: number) => {
    // Leaving a subshell discards everything it did.
    if (stack.length > depth + 1) stack = stack.slice(0, depth + 1);
    while (stack.length <= depth) {
      const parent = stack[stack.length - 1];
      stack.push({ group, cwds: parent.cwds, previous: parent.previous, dirStack: [...parent.dirStack], explicit: parent.explicit });
    }
    // A DIFFERENT group at the same depth is a sibling subshell - a separate process that
    // never saw the previous one's `cd`. Reusing the frame let `(cd /elsewhere); (rm -rf *)`
    // point the guard at an attacker-chosen directory while bash deleted the real cwd.
    const frame = stack[depth];
    if (frame.group !== group) {
      const parent = stack[depth - 1] ?? stack[0];
      stack[depth] = { group, cwds: parent.cwds, previous: parent.previous, dirStack: [...parent.dirStack], explicit: parent.explicit };
    }
    return stack[depth];
  };

  splitShellSegmentsDetailed(command).forEach(({ text: segment, depth, group, piped, shortCircuit }, segmentIndex) => {
    const frame = frameFor(depth, group);
    // A leading `{` from a brace group is not part of the command.
    const tokens = shellWords(segment).filter((token, index) => !(index === 0 && (token === "{" || token === "}")));
    const verb = tokens[0];

    // `popd` returns the shell to where `pushd` came from. It was unhandled, so the pushd
    // target stayed as the tracked cwd for the rest of the command and
    // `pushd /tmp; popd; rm -rf *` deleted the original directory unguarded.
    if (verb === "popd") {
      if (piped) return;
      const restored = frame.dirStack.pop();
      if (restored) {
        frame.previous = frame.cwds;
        frame.cwds = restored;
        frame.explicit = restored.some((dir) => dir !== baseCwd);
      }
      return;
    }

    if (verb === "cd" || verb === "pushd") {
      // A `cd` in a pipeline stage runs in its own process and moves nothing else. One
      // reached via `&&`/`||` may not run at all: `cd /home/hasna; false && cd /tmp;
      // rm -rf *` left the guard in /tmp while bash stayed in the home directory.
      if (piped) return;
      if (shortCircuit) {
        analysis.degraded = true;
        return;
      }
      // `pushd -n` records the directory WITHOUT moving the shell, so the tracked cwd must
      // not follow it. Previously `-n` was read as the directory operand.
      if (verb === "pushd" && tokens.includes("-n")) return;
      // `pushd` saves the current directory before moving.
      if (verb === "pushd") frame.dirStack.push(frame.cwds);
      // Skip cd's own flags (-P, -L, --) to reach the directory operand.
      let i = 1;
      while (i < tokens.length && (tokens[i] === "-P" || tokens[i] === "-L" || tokens[i] === "-e" || tokens[i] === "-@" || tokens[i] === "--")) i += 1;
      const operand = tokens[i];
      const priorCwds = frame.cwds;
      cdOperations += 1;
      // Both cd bounds below mark the analysis degraded rather than inventing a fallback.
      // Skipping an over-long operand allowed `cd ////…(4200); rm -rf *`, and adding `/` to
      // the candidate set caught only sweep targets - `cd /home/hasna; cd .x2000; cd ..;
      // rm -rf hasna` still destroyed the Hasna home.
      // Once the budget is spent the guard can no longer model a chain of RELATIVE cds. It
      // must not simply keep the last known directory - that was the fail-open the PATH_MAX
      // cap produced - so `/` joins the candidate set and any relative delete is judged
      // against the filesystem root too. `rm -rf *` then blocks; `rm -rf dist` still resolves
      // to /dist and passes.
      //
      // An ABSOLUTE cd is never dropped: it is a real landing the guard can still model
      // exactly, and skipping it lost `cd ~` after a flood, which allowed `rm -rf .hasna`.
      if (cdOperations > MAX_CD_OPERATIONS && !isAbsolute(expandHome(operand ?? ""))) {
        analysis.degraded = true;
        return;
      }

      if (operand === undefined || operand === "~") {
        frame.cwds = [home];
        frame.explicit = true;
      } else if (operand === "-" || operand === "$OLDPWD" || operand === "${OLDPWD}") {
        frame.cwds = frame.previous;
        frame.explicit = frame.previous.some((dir) => dir !== baseCwd);
      } else {
        const collapsed = emptyExpansionCollapse(operand, nonEmptyNames);
        const next = new Set<string>();
        for (const current of frame.cwds) {
          // Only operands that can GROW the path are capped.
          //
          // `..` and `.` shrink or hold, and skipping them froze the model permanently: after
          // one crossing, `cd d0 … cd d1999; cd ..x2100` left the guard on the long path while
          // bash had walked back to `/`, so `rm -rf *` was allowed. That was a fail-open
          // introduced by the cap itself - the seventh time a bound in this file produced one.
          //
          // An absolute operand replaces the path, but resolving a 4KB operand 70k times still
          // took 24s against the 20s timeout, so its own length is capped too. No real
          // directory exceeds PATH_MAX, which is why this is a correctness bound and not just
          // a throttle.
          const expanded = expandHome(operand);
          const shrinksOnly = /^[./]+$/.test(expanded);
          const wouldGrow = !shrinksOnly && !isAbsolute(expanded);
          if (wouldGrow && current.length > MAX_TRACKED_CWD_LENGTH) {
            analysis.degraded = true;
            next.add(current);
            continue;
          }
          if (expanded.length > MAX_TRACKED_CWD_LENGTH) {
            analysis.degraded = true;
            next.add(current);
            continue;
          }
          next.add(resolveFrom(current, operand));
          if (collapsed !== null) next.add(resolveFrom(current, collapsed));
        }
        frame.cwds = [...next].slice(0, MAX_CWD_VARIANTS);
        if (isAbsolute(expandHome(operand)) || collapsed !== null) frame.explicit = true;
      }
      frame.previous = priorCwds;
      return;
    }

    chunks.push({ segment, segmentIndex, cwds: frame.cwds, explicitCwd: frame.explicit });
  });
  return chunks;
}

/**
 * `for d in /*; do rm -rf "$d"; done` deletes the filesystem root one entry at a time while
 * the delete's own target is an innocuous `$d`. Only exact `$VAR` / `${VAR}` targets bound by
 * a `for ... in` in the same layer are substituted, so this cannot fire on unrelated commands.
 */
function forLoopBindings(command: string): Map<string, string[]> {
  const bindings = new Map<string, string[]>();
  for (const segment of splitShellSegments(command)) {
    const tokens = shellWords(segment);
    const forIndex = tokens.indexOf("for");
    if (forIndex === -1) continue;
    const name = tokens[forIndex + 1];
    if (!name || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) continue;
    if (tokens[forIndex + 2] !== "in") continue;
    const words = tokens.slice(forIndex + 3).filter((token) => token !== "do");
    if (words.length > 0) bindings.set(name, words);
  }
  return bindings;
}

function loopBoundWords(path: string, bindings: Map<string, string[]>): string[] | null {
  const match = path.match(/^\$\{?([A-Za-z_][A-Za-z0-9_]*)\}?$/);
  if (!match) return null;
  return bindings.get(match[1]) ?? null;
}

function destructiveShellTargets(command: string, cwd: string, analysis: AnalysisState): DestructiveShellTarget[] {
  const targets: DestructiveShellTarget[] = [];
  for (const layer of shellCommandLayers(command).layers) {
    const bindings = forLoopBindings(layer.command);

    const assignments = assignmentWalker(layer.command);

    for (const chunk of cwdTrackedSegments(layer.command, cwd, new Set(), analysis)) {
      const raw = [
        ...rmCommandTargets(chunk.segment),
        ...rsyncDeleteTargets(chunk.segment),
        ...findDestructiveTargets(chunk.segment),
        ...gitDestructiveTargets(chunk.segment, chunk.cwds[0]),
      ];
      if (raw.length === 0) continue;
      // The walker advances one set IN PLACE - that is what removed the O(segments x names)
      // copy, not this lookup being lazy.
      const nonEmptyNames = assignments.at(chunk.segmentIndex);

      const expanded = raw.flatMap((target) => {
        const words = loopBoundWords(target.path, bindings);
        const paths = words ?? expandBraces(target.path);
        return paths.length === 1 && paths[0] === target.path && words === null
          ? [destructiveTarget(target.path, target.operation, nonEmptyNames)]
          : paths.map((word) => destructiveTarget(word, target.operation, nonEmptyNames));
      });

      const chunkTargets = expanded.flatMap((target) =>
        chunk.cwds.map((chunkCwd) => ({
          ...target,
          path: substituteWorkingDirectory(target.path, chunkCwd),
          baseCwd: chunkCwd,
        }))
      );

      if (!layer.remote) {
        targets.push(...chunkTargets);
        continue;
      }
      targets.push(
        ...chunkTargets
          .filter((target) => chunk.explicitCwd || keepRemoteTarget(target))
          .map((target) => ({ ...target, remote: true }))
      );
    }
  }
  return targets;
}

function isApplyPatchTool(toolName: string): boolean {
  return toolName === "apply_patch" || toolName === "ApplyPatch" || toolName === "functions.apply_patch";
}

function extractFileToolPaths(input: CodewithHookInput): Array<{ path: string; operation: string }> {
  if (input.hook_event_name !== "PreToolUse") return [];
  const toolName = typeof input.tool_name === "string" ? input.tool_name : "";
  const toolInput = input.tool_input && typeof input.tool_input === "object" ? input.tool_input : {};
  const paths: Array<{ path: string; operation: string }> = [];

  const addString = (value: unknown, operation: string) => {
    if (typeof value === "string" && value.trim()) paths.push({ path: value, operation });
  };
  const addPathFields = (obj: Record<string, unknown>, operation: string) => {
    for (const key of ["file_path", "path", "target_path", "old_path", "new_path", "notebook_path"]) {
      addString(obj[key], operation);
    }
  };

  if (["Write", "Edit", "MultiEdit", "NotebookEdit"].includes(toolName)) {
    addPathFields(toolInput, `${toolName} file mutation`);
  } else if (/^(?:apply_patch|ApplyPatch|functions\.apply_patch|mcp__.*|.*(?:write|edit|delete|remove|move).*file.*)$/i.test(toolName)) {
    addPathFields(toolInput, `${toolName} file mutation`);
  }

  const patch = toolInput.patch ?? toolInput.input ?? toolInput.content ?? toolInput.command;
  if (isApplyPatchTool(toolName) && typeof patch === "string") {
    for (const line of patch.split(/\r?\n/)) {
      const match = line.match(/^\*\*\* (?:(?:Add|Update|Delete) File|Move to): (.+)$/);
      if (match?.[1]) paths.push({ path: match[1].trim(), operation: "apply_patch file mutation" });
    }
  }

  const files = toolInput.files;
  if (Array.isArray(files)) {
    for (const item of files) {
      if (typeof item === "string") addString(item, `${toolName} file mutation`);
      else if (item && typeof item === "object") addPathFields(item as Record<string, unknown>, `${toolName} file mutation`);
    }
  }

  return paths;
}

function scopedBlockReason(operation: string, targetPath: string, rule: ProtectedPathRule, remote?: boolean): string {
  // A POSIX class, equivalence class or collating symbol makes the pattern's extent
  // unpinnable, so the guard treats it as matching anything. Saying only "targets /" would be
  // wrong and confusing when the command reads `rm -rf /var[.]log` - the operator needs to
  // know it was refused for being unanalysable, not for naming the filesystem root.
  const unpinnable = /\[[:=.]/.test(targetPath)
    ? [
      "This target contains a POSIX character class, equivalence class or collating symbol,",
      "whose extent cannot be determined without replicating the shell exactly. It is therefore",
      "treated as matching any name. Use a literal path, or a plain glob, if this was not intended.",
    ]
    : [];
  return [
    `Blocked scoped dangerous operation: ${operation} targets ${targetPath}${remote ? " on a remote host" : ""}.`,
    `Protected scope: ${rule.label} (${rule.root}).`,
    ...unpinnable,
    "This guard is scoped; destructive commands outside protected roots are not blocked.",
    "Delete a specific named subdirectory instead of the root or its contents.",
  ].join(" ");
}

function collapseBlockReason(
  operation: string,
  rawTarget: string,
  collapsedTarget: string,
  rule: ProtectedPathRule,
  remote?: boolean
): string {
  return [
    `Blocked unsafe expansion in a destructive command: ${operation} target ${rawTarget}`,
    `collapses to ${collapsedTarget}${remote ? " on a remote host" : ""} when the expansion returns empty`,
    "(a command substitution that fails or prints nothing, or an unset variable),",
    `which would destroy ${rule.label} (${rule.root}).`,
    "This is the 2026-07-24 station02 failure: `bun pm cache` exits non-zero with empty stdout when no",
    "package.json is found walking up from cwd, so `rm -rf \"$(bun pm cache)\"/*` ran as `rm -rf /*`.",
    "Redirecting stderr does not help - it discards the diagnostic, not the path.",
    "Safe alternative: resolve the path first, verify it is non-empty and not a protected root, then delete it,",
    'e.g. `dir="$(bun pm cache)" || exit 1; case "$dir" in /|"") exit 1;; esac; rm -rf -- "$dir"`.',
    "This guard blocks the shape, not the command: any expansion immediately followed by `/` can collapse to the filesystem root.",
  ].join(" ");
}

export async function classifyDangerousOperation(input: CodewithHookInput): Promise<DangerousOperationMatch> {
  if (input.hook_event_name !== "PreToolUse") return { block: false };
  const cwd = input.cwd || process.cwd();
  const { rules, workspaceRoots, currentManagedRepoRoot } = await protectedPathContextFor(input, cwd);

  if (input.tool_name === "Bash") {
    const command = getCommand(input);
    const analysis: AnalysisState = { degraded: false };

    // A command large enough that merely tokenizing it blows the hook's 20s budget cannot be
    // analysed at all, and a timed-out hook fails open. 70k repetitions of `cd /<4KB>` is a
    // 280 MB string: no per-rule bound helps, because the cost is reading the input. Refuse it
    // when it carries a recursive delete, rather than letting the timeout decide.
    if (command.length > MAX_ANALYSABLE_COMMAND_LENGTH) {
      // Decided here either way. Falling through to the full scan for a command with no
      // delete in it still spent 46s tokenizing, which stalls every Bash call behind the
      // hook's timeout for no benefit.
      const reason = truncatedAnalysisBlockReason(command);
      return reason ? { block: true, operation: "oversized command", reason } : { block: false };
    }

    if (shellCommandLayers(command).truncated) {
      const reason = truncatedAnalysisBlockReason(command);
      if (reason) {
        return { block: true, operation: "unanalysable nested command", reason };
      }
    }

    for (const target of destructiveShellTargets(command, cwd, analysis)) {
      const targetCwd = target.baseCwd ?? cwd;
      const targetPath = resolveFrom(targetCwd, target.path);
      const rulesFor = (path: string) => {
        const extraRule = workspaceRoots.map((root) => hasnaDivisionRuleFor(path, root)).find((rule): rule is ProtectedPathRule => Boolean(rule));
        return extraRule ? [...rules, extraRule] : rules;
      };

      for (const rule of rulesFor(targetPath)) {
        if (threatensRule(targetPath, rule, currentManagedRepoRoot)) {
          return {
            block: true,
            targetPath,
            protectedPath: rule.root,
            protectedLabel: rule.label,
            operation: target.operation,
            reason: scopedBlockReason(target.operation, targetPath, rule, target.remote),
          };
        }
      }

      // Second pass over the same target as the shell would produce it if every expansion
      // came back empty. The managed-worktree escape hatch is not applied here: an empty
      // collapse leaves the worktree entirely, so it can never be the intended target.
      if (target.collapsed === undefined) continue;
      const collapsedPath = resolveFrom(targetCwd, target.collapsed);
      for (const rule of rulesFor(collapsedPath)) {
        if (threatensRule(collapsedPath, rule, null)) {
          return {
            block: true,
            targetPath: collapsedPath,
            protectedPath: rule.root,
            protectedLabel: rule.label,
            operation: target.operation,
            reason: collapseBlockReason(target.operation, target.path, collapsedPath, rule, target.remote),
          };
        }
      }
    }

    // Raised during the scan above by any bound that stopped modelling the command
    // exactly. Checked here rather than at each bound so there is ONE fail-closed answer:
    // three bounds that each invented their own fallback all became root wipes.
    if (analysis.degraded) {
      const reason = truncatedAnalysisBlockReason(command);
      if (reason) {
        return { block: true, operation: "unanalysable command", reason };
      }
    }
  }

  const managedRepoRootCache = new Map<string, Promise<string | null>>();
  const worktreesRoot = resolve(defaultWorktreesRoot());
  for (const candidate of extractFileToolPaths(input)) {
    const targetPath = resolveFrom(cwd, candidate.path);
    const hasUnsafeManagedComponent = isInsidePath(targetPath, worktreesRoot)
      && hasUnsafeTargetComponent(worktreesRoot, targetPath);
    const targetManagedRepoRoot = hasUnsafeManagedComponent
      ? null
      : await managedRepoRootForAbsoluteTarget(targetPath, managedRepoRootCache);
    const exemptManagedRepoRoot = hasUnsafeManagedComponent
      ? null
      : targetManagedRepoRoot;
    const extraRule = workspaceRoots.map((root) => hasnaDivisionRuleFor(targetPath, root)).find((rule): rule is ProtectedPathRule => Boolean(rule));
    const allRules = extraRule ? [...rules, extraRule] : rules;
    for (const rule of allRules) {
      if (mutatesRule(targetPath, rule, exemptManagedRepoRoot)) {
        return {
          block: true,
          targetPath,
          protectedPath: rule.root,
          protectedLabel: rule.label,
          operation: candidate.operation,
          reason: scopedBlockReason(candidate.operation, targetPath, rule),
        };
      }
    }
  }

  return { block: false };
}
