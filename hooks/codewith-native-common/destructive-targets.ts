import { dirname, isAbsolute, resolve, sep } from "path";
import {
  expandHome,
  isGitToken,
  optionValue,
  resolveFrom,
  shellWords,
  shortOptionValue,
  splitShellSegments,
} from "./git-command";
import {
  emptyExpansionCollapse,
  findExpansions,
  MAX_EXPANSION_NESTING,
} from "./shell-expansions";

export interface DestructiveShellTarget {
  path: string;
  operation: string;
  /** Same target with every shell expansion collapsed to empty; see emptyExpansionCollapse. */
  collapsed?: string;
  /** Target of a command sent to another host, so relative paths cannot be resolved here. */
  remote?: boolean;
  /** Working directory in effect for this target, after any `cd` earlier in the command. */
  baseCwd?: string;
}

// `$PWD`, `${PWD}`, `$(pwd)` and `` `pwd` `` all stand for the working directory the guard is
// already tracking. They are certified non-empty, so no collapse fires - which left them as
// opaque path components matching no protected root, and `rm -rf "$PWD"/*` was allowed where
// the identical `rm -rf *` blocked.
const PWD_EXPANSION = /\$\{PWD\}|\$PWD|\$\(\s*pwd\s*\)|`\s*pwd\s*`/g;

export function substituteWorkingDirectory(path: string, cwd: string): string {
  return PWD_EXPANSION.test(path) ? path.replace(PWD_EXPANSION, cwd) : path;
}

export function destructiveTarget(
  path: string,
  operation: string,
  nonEmptyNames: ReadonlySet<string> = new Set()
): DestructiveShellTarget {
  const collapsed = emptyExpansionCollapse(path, nonEmptyNames);
  return collapsed === null ? { path, operation } : { path, operation, collapsed };
}

export function rmCommandTargets(command: string): DestructiveShellTarget[] {
  const targets: DestructiveShellTarget[] = [];
  for (const segment of splitShellSegments(command)) {
    const tokens = shellWords(segment);
    const rmIndex = tokens.findIndex((token) => token === "rm" || token.endsWith("/rm"));
    if (rmIndex === -1) continue;

    let recursive = false;
    let force = false;
    let afterOptions = false;
    const segmentTargets: string[] = [];

    for (let i = rmIndex + 1; i < tokens.length; i += 1) {
      const token = tokens[i];
      if (!afterOptions && token === "--") {
        afterOptions = true;
        continue;
      }
      if (!afterOptions && token.startsWith("--")) {
        if (token === "--recursive" || token === "--dir") recursive = true;
        if (token === "--force") force = true;
        continue;
      }
      if (!afterOptions && /^-[A-Za-z]+$/.test(token)) {
        if (token.includes("r") || token.includes("R")) recursive = true;
        if (token.includes("f")) force = true;
        continue;
      }
      segmentTargets.push(token);
    }

    if (recursive) {
      targets.push(...segmentTargets.map((path) => destructiveTarget(path, force ? "rm -rf" : "rm -r")));
    }
  }
  return targets;
}

const RSYNC_OPTIONS_WITH_VALUE = new Set([
  "-e",
  "--rsh",
  "--exclude",
  "--exclude-from",
  "--include",
  "--include-from",
  "--filter",
  "--files-from",
  "--rsync-path",
  "--out-format",
  "--log-file",
  "--password-file",
  "--backup-dir",
  "--partial-dir",
  "--compare-dest",
  "--copy-dest",
  "--link-dest",
]);

function optionTakesValue(token: string, options: Set<string>): boolean {
  if (options.has(token)) return true;
  const eq = token.indexOf("=");
  return eq === -1 ? false : options.has(token.slice(0, eq));
}

export function rsyncDeleteTargets(command: string): DestructiveShellTarget[] {
  const targets: DestructiveShellTarget[] = [];
  for (const segment of splitShellSegments(command)) {
    const tokens = shellWords(segment);
    const rsyncIndex = tokens.findIndex((token) => token === "rsync" || token.endsWith("/rsync"));
    if (rsyncIndex === -1) continue;

    let hasDelete = false;
    let afterOptions = false;
    const operands: string[] = [];

    for (let i = rsyncIndex + 1; i < tokens.length; i += 1) {
      const token = tokens[i];
      if (!afterOptions && token === "--") {
        afterOptions = true;
        continue;
      }
      if (!afterOptions && (token === "--delete" || token.startsWith("--delete-"))) {
        hasDelete = true;
        continue;
      }
      if (!afterOptions && token.startsWith("-")) {
        if (optionTakesValue(token, RSYNC_OPTIONS_WITH_VALUE) && !token.includes("=")) i += 1;
        continue;
      }
      operands.push(token);
    }

    if (hasDelete && operands.length > 0) {
      targets.push(destructiveTarget(operands[operands.length - 1], "rsync --delete"));
    }
  }
  return targets;
}

export function findDestructiveTargets(command: string): DestructiveShellTarget[] {
  const targets: DestructiveShellTarget[] = [];
  for (const segment of splitShellSegments(command)) {
    const tokens = shellWords(segment);
    const findIndex = tokens.findIndex((token) => token === "find" || token.endsWith("/find"));
    if (findIndex === -1) continue;

    let hasDelete = false;
    let hasExecRm = false;
    const roots: string[] = [];

    for (let i = findIndex + 1; i < tokens.length; i += 1) {
      const token = tokens[i];
      if (token === "-H" || token === "-L" || token === "-P") continue;
      if (token === "-O") {
        i += 1;
        continue;
      }
      if (token.startsWith("-") || token === "!" || token === "(" || token === ")") break;
      roots.push(token);
    }

    for (let i = findIndex + 1; i < tokens.length; i += 1) {
      const token = tokens[i];
      if (token === "-delete") hasDelete = true;
      if (token === "-exec" || token === "-execdir") {
        const next = tokens[i + 1];
        if (next === "rm" || next?.endsWith("/rm")) hasExecRm = true;
      }
    }

    if (hasDelete || hasExecRm) {
      targets.push(...(roots.length > 0 ? roots : ["."]).map((path) => destructiveTarget(
        path,
        hasDelete ? "find -delete" : "find -exec rm"
      )));
    }
  }
  return targets;
}

function gitTargetCwdFromTokens(tokens: string[], baseCwd: string): { gitIndex: number; commandIndex: number; targetCwd: string } | null {
  const gitIndex = tokens.findIndex(isGitToken);
  if (gitIndex === -1) return null;

  let i = gitIndex + 1;
  let cwd = resolve(baseCwd);
  let gitDir: string | undefined;
  let workTree: string | undefined;

  while (i < tokens.length) {
    const token = tokens[i];

    const cDir = shortOptionValue(token, tokens[i + 1], "-C");
    if (cDir) {
      if (cDir.value) cwd = resolveFrom(cwd, cDir.value);
      i += cDir.consumed;
      continue;
    }

    const config = shortOptionValue(token, tokens[i + 1], "-c");
    if (config) {
      i += config.consumed;
      continue;
    }

    const gitDirValue = optionValue(token, tokens[i + 1], "--git-dir");
    if (gitDirValue) {
      if (gitDirValue.value) gitDir = resolveFrom(cwd, gitDirValue.value);
      i += gitDirValue.consumed;
      continue;
    }

    const workTreeValue = optionValue(token, tokens[i + 1], "--work-tree");
    if (workTreeValue) {
      if (workTreeValue.value) workTree = resolveFrom(cwd, workTreeValue.value);
      i += workTreeValue.consumed;
      continue;
    }

    const namespaceValue = optionValue(token, tokens[i + 1], "--namespace");
    if (namespaceValue) {
      i += namespaceValue.consumed;
      continue;
    }

    const execPathValue = optionValue(token, tokens[i + 1], "--exec-path");
    if (execPathValue) {
      i += execPathValue.consumed;
      continue;
    }

    if (token === "--config-env") {
      i += tokens[i + 1] === undefined ? 1 : 2;
      continue;
    }

    if (token === "--") {
      i += 1;
      continue;
    }

    if (token.startsWith("-")) {
      i += 1;
      continue;
    }

    const targetCwd = workTree || (gitDir ? (gitDir.endsWith(`${sep}.git`) || gitDir.endsWith("/.git") ? dirname(gitDir) : gitDir) : cwd);
    return { gitIndex, commandIndex: i, targetCwd };
  }

  return null;
}

export function gitDestructiveTargets(command: string, baseCwd: string): DestructiveShellTarget[] {
  const targets: DestructiveShellTarget[] = [];
  for (const segment of splitShellSegments(command)) {
    const tokens = shellWords(segment);
    const git = gitTargetCwdFromTokens(tokens, baseCwd);
    if (!git) continue;

    const commandName = tokens[git.commandIndex];
    if (commandName === "reset" && tokens.slice(git.commandIndex + 1).includes("--hard")) {
      targets.push({ path: git.targetCwd, operation: "git reset --hard" });
      continue;
    }

    if (commandName !== "clean") continue;

    let force = false;
    let recursive = false;
    const pathspecs: string[] = [];
    for (let i = git.commandIndex + 1; i < tokens.length; i += 1) {
      const token = tokens[i];
      if (token === "--") continue;
      if (token === "-f" || token === "--force") {
        force = true;
        continue;
      }
      if (token === "-d") {
        recursive = true;
        continue;
      }
      if (/^-[A-Za-z]+$/.test(token)) {
        if (token.includes("f")) force = true;
        if (token.includes("d")) recursive = true;
        continue;
      }
      if (token.startsWith("-")) continue;
      pathspecs.push(token);
    }

    if (force && recursive) {
      targets.push(...(pathspecs.length > 0 ? pathspecs : ["."]).map((path) => ({
        path: resolveFrom(git.targetCwd, path),
        operation: "git clean -xfd",
      })));
    }
  }
  return targets;
}

const SHELL_INTERPRETERS = new Set(["sh", "bash", "zsh", "dash", "ksh", "ash", "mksh", "busybox"]);

// Also take a script via `-c`, but with a username operand in front of the flag.
const USER_SWITCH_COMMANDS = new Set(["su", "runuser"]);

// ssh options that consume the following argument, so the first bare operand really is the host.
const SSH_OPTIONS_WITH_VALUE = new Set([
  "-B", "-b", "-c", "-D", "-E", "-e", "-F", "-I", "-i", "-J", "-L", "-l", "-m",
  "-O", "-o", "-P", "-p", "-Q", "-R", "-S", "-W", "-w",
]);

interface ShellCommandLayer {
  command: string;
  /** True once the layer is being executed on another host via ssh. */
  remote: boolean;
}

function commandName(token: string): string {
  return token.includes("/") ? token.slice(token.lastIndexOf("/") + 1) : token;
}

function isShellInterpreterToken(token: string): boolean {
  return SHELL_INTERPRETERS.has(commandName(token));
}

// Shell options that consume the following word, so its value is not mistaken for the script
// operand. Without this, `bash -o errexit -c '...'` reads `errexit` as the script file and the
// `-c` script is never scanned.
const SHELL_OPTIONS_WITH_VALUE = new Set(["-o", "+o", "--rcfile", "--init-file"]);

/**
 * Script passed via `-c`. For a shell, the first bare operand is the script *file* and the
 * scan stops there; `su`/`runuser` take a username operand first, so one is skipped.
 */
function interpreterScriptFrom(tokens: string[], shellIndex: number, allowedOperands = 0): string | null {
  let operands = 0;
  for (let i = shellIndex + 1; i < tokens.length; i += 1) {
    const token = tokens[i];
    // -c, and combined short forms such as -lc / -euxc.
    if (/^-[A-Za-z]*c$/.test(token)) return tokens[i + 1] ?? null;
    if (SHELL_OPTIONS_WITH_VALUE.has(token)) {
      i += 1;
      continue;
    }
    if (!token.startsWith("-")) {
      operands += 1;
      if (operands > allowedOperands) return null;
    }
  }
  return null;
}

/**
 * Bodies of `$( … )` and backtick substitutions, as scripts in their own right.
 *
 * Required because the tokenizer treats substitutions atomically so the collapse rule can see
 * them whole. Without feeding the bodies back in, `echo $(rm -rf /*)` contains no `rm` token
 * at all and every rule misses it - the delete runs, its output is simply discarded.
 */
function substitutionBodies(segment: string, onTruncated?: () => void): string[] {
  const bodies: string[] = [];
  const visit = (text: string, depth: number): void => {
    // Exhausting this bound must not silently drop a delete: `${x:-${x:- … $(rm -rf /*)}}`
    // nested past the old hardcoded 4 was never classified at all.
    if (depth > MAX_EXPANSION_NESTING) {
      onTruncated?.();
      return;
    }
    for (const expansion of findExpansions(text)) {
      if (expansion.text.startsWith("$(") || expansion.text.startsWith("`")) {
        const body = (expansion.text.startsWith("`")
          ? expansion.text.slice(1, -1)
          : expansion.text.slice(2, -1)).trim();
        if (body.length > 0) {
          bodies.push(body);
          visit(body, depth + 1);
        }
        continue;
      }
      // `${x:-$(rm -rf /*)}` runs the substitution when x is unset. findExpansions returns
      // the outer ${...} and swallows the inner one, so the body has to be re-scanned.
      if (expansion.text.startsWith("${")) visit(expansion.text.slice(2, -1), depth + 1);
    }
  };
  visit(segment, 0);
  return bodies;
}

function sshRemoteCommandFrom(tokens: string[], sshIndex: number): string | null {
  for (let i = sshIndex + 1; i < tokens.length; i += 1) {
    const token = tokens[i];
    if (token === "--") continue;
    if (token.startsWith("-")) {
      if (SSH_OPTIONS_WITH_VALUE.has(token)) i += 1;
      continue;
    }
    // First bare operand is [user@]host; everything after it is the remote command.
    const remote = tokens.slice(i + 1).join(" ").trim();
    return remote.length > 0 ? remote : null;
  }
  return null;
}

/**
 * Scripts this command hands to another interpreter or to another host.
 *
 * Required, not optional: the realized 2026-07-24 incident arrived as
 * `ssh station02 bash -c '...'`, and the `rm` token only exists inside the quoted script.
 * A scan of the outer command alone sees `ssh`, `bash` and a single opaque operand.
 */
function isSshToken(token: string): boolean {
  return token === "ssh" || token.endsWith("/ssh");
}

function wrappedShellLayers(command: string, remote: boolean, onTruncated?: () => void): ShellCommandLayer[] {
  const layers: ShellCommandLayer[] = [];
  for (const segment of splitShellSegments(command)) {
    const tokens = shellWords(segment);
    // `ssh host bash -c '...'`: everything after the ssh token executes on the other machine.
    let sshSeen = false;
    for (let i = 0; i < tokens.length; i += 1) {
      const token = tokens[i];
      if (isShellInterpreterToken(token) || USER_SWITCH_COMMANDS.has(commandName(token))) {
        const allowedOperands = USER_SWITCH_COMMANDS.has(commandName(token)) ? 1 : 0;
        const script = interpreterScriptFrom(tokens, i, allowedOperands);
        if (script) layers.push({ command: script, remote: remote || sshSeen });
        continue;
      }
      if (token === "eval") {
        const script = tokens.slice(i + 1).join(" ").trim();
        if (script) layers.push({ command: script, remote: remote || sshSeen });
        continue;
      }
      if (isSshToken(token)) {
        sshSeen = true;
        const script = sshRemoteCommandFrom(tokens, i);
        if (script) layers.push({ command: script, remote: true });
      }
    }

    // A substitution body executes wherever it appears, including in assignments and in
    // arguments to commands that do nothing with the result.
    for (const body of substitutionBodies(segment, onTruncated)) {
      layers.push({ command: body, remote: remote || sshSeen });
    }
  }
  return layers;
}

const MAX_WRAPPER_DEPTH = 8;
const MAX_SHELL_LAYERS = 256;

export function shellCommandLayers(command: string): { layers: ShellCommandLayer[]; truncated: boolean } {
  const layers: ShellCommandLayer[] = [{ command, remote: false }];
  const seen = new Set([command]);
  let frontier: ShellCommandLayer[] = layers;
  let truncated = false;

  for (let depth = 0; depth < MAX_WRAPPER_DEPTH; depth += 1) {
    const next: ShellCommandLayer[] = [];
    for (const layer of frontier) {
      for (const inner of wrappedShellLayers(layer.command, layer.remote, () => { truncated = true; })) {
        if (seen.has(inner.command)) continue;
        if (layers.length + next.length >= MAX_SHELL_LAYERS) {
          truncated = true;
          continue;
        }
        seen.add(inner.command);
        next.push(inner);
      }
    }
    if (next.length === 0) break;
    layers.push(...next);
    frontier = next;
    // More wrappers remain below the depth limit.
    if (depth === MAX_WRAPPER_DEPTH - 1 && next.some((layer) => wrappedShellLayers(layer.command, layer.remote).length > 0)) {
      truncated = true;
    }
  }

  return { layers, truncated };
}

// Verbs whose presence makes an unanalysable command unsafe to wave through.
// `rm` followed ANYWHERE by a recursive flag. Anchoring it to the very next token missed
// `rm -f -r /*`, `rm -v -f -r /*`, `rm --one-file-system -rf /*` and `rm <path> -rf`, each of
// which sailed past the oversized-command gate unanalysed.
const DESTRUCTIVE_VERB = /(?:^|[^\w.-])(?:[\w/.-]*\/)?(?:rm\b[^;&|\n]*?(?:\s-[A-Za-z]*[rR][A-Za-z]*(?=[\s=;&|]|$)|\s--recursive\b|\s--dir\b)|rsync\s[^;&|]*--delete|find\s[^;&|]*(?:-delete|-execdir?\s)|git\s[^;&|]*(?:clean\s+-\S*[fd]|reset\s+--hard))/;

/**
 * A command too deeply wrapped or too wide to analyse within the caps is refused when it
 * contains a destructive verb, instead of being allowed by default.
 *
 * The caps exist so a pathological command cannot stall the hook past its 20s timeout - and
 * a timed-out hook fails open. But dropping work silently turns "too complex to analyse"
 * into "allowed", which is the same passes-silently-while-protecting-nothing failure this
 * guard exists to prevent. Padding with 32 dummy `sh -c` wrappers pushed the real delete
 * past the cap and it returned continue.
 */
export function truncatedAnalysisBlockReason(command: string): string | null {
  if (!DESTRUCTIVE_VERB.test(command)) return null;
  return [
    "Blocked: this command nests more shell wrappers than the safety guard can analyse,",
    "and it contains a recursive delete. The guard refuses rather than guess, because an",
    "unanalysable delete is exactly the shape that destroyed a machine on 2026-07-24.",
    "Run the delete directly instead of through nested bash -c / ssh / eval wrappers,",
    "with a literal, non-empty target path.",
  ].join(" ");
}

/**
 * Remote layers run against another machine's filesystem, so a relative or cwd-derived
 * target here would be a guess. Absolute targets (including `~` / `$HOME` forms, which the
 * fleet shares) and empty-collapse targets (always absolute by construction) still apply.
 */
export function keepRemoteTarget(target: DestructiveShellTarget): boolean {
  return target.collapsed !== undefined || isAbsolute(expandHome(target.path));
}
