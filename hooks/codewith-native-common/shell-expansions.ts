import { shellWords, splitShellSegmentsDetailed, type ShellSegment } from "./git-command";

const GUARDED_EXPANSION = /^\$\{[A-Za-z_][A-Za-z0-9_]*:\?/;
const NON_EMPTY_PLACEHOLDER = "__hooks_guarded_expansion__";
export const MAX_EXPANSION_NESTING = 32;

// Builtins whose effect on a variable this scan cannot follow at all. Any of them clears
// every guarantee, because guessing in the permissive direction is how `$X` stayed certified
// non-empty while the shell had already emptied it.
const OPAQUE_BUILTINS = new Set(["eval", "source", ".", "trap", "coproc", "exec"]);

// Compound-command keywords that can precede an assignment in the same segment.
const COMPOUND_KEYWORDS = new Set(["{", "}", "then", "do", "else", "elif", "fi", "done", "!"]);

// Sentinel marking PWD as reassigned, so $PWD stops being treated as shell-maintained.
const PWD_REASSIGNED = "\u0000PWD-REASSIGNED";

// Builtins that bind a BARE name, with no `=` in sight: `read D`, `getopts o D`.
const NAME_BINDING_BUILTINS = new Set(["read", "getopts", "mapfile", "readarray"]);

// Builtins that take `NAME=value` operands. A BARE name here does not change the variable -
// `export X` merely exports the existing value - so bare names must not withdraw anything.
const VALUE_BINDING_BUILTINS = new Set(["export", "declare", "typeset", "readonly", "local", "let"]);

/** One shell expansion found in a token, with its exact source span. */
interface FoundExpansion {
  text: string;
  start: number;
  end: number;
}

/**
 * Locate shell expansions by scanning with a depth counter rather than by regex.
 *
 * A regex has to fix a nesting depth, and every fixed depth is a bypass:
 * `$(dirname "$(dirname "$(bun pm cache)")")` is three deep, and `${A:-${B}}` nests braces.
 */
export function findExpansions(token: string): FoundExpansion[] {
  const found: FoundExpansion[] = [];
  for (let i = 0; i < token.length; i += 1) {
    if (token[i] === "\\") {
      i += 1;
      continue;
    }
    if (token[i] === "`") {
      const end = token.indexOf("`", i + 1);
      if (end === -1) break;
      found.push({ text: token.slice(i, end + 1), start: i, end: end + 1 });
      i = end;
      continue;
    }
    if (token[i] !== "$") continue;

    const next = token[i + 1];
    if (next === "(" || next === "{") {
      const open = next;
      const close = open === "(" ? ")" : "}";
      let depth = 0;
      let quote: "'" | '"' | null = null;
      let j = i + 1;
      for (; j < token.length; j += 1) {
        const ch = token[j];
        // An escaped character is data whether or not a quote is open: `$(echo \')`.
        if (ch === "\\") { j += 1; continue; }
        // A paren inside quotes is data, not structure: `awk -F'(' '{print $2}'`.
        if (quote) {
          if (ch === quote) quote = null;
          continue;
        }
        if (ch === "'" || ch === '"') { quote = ch; continue; }
        if (ch === open) depth += 1;
        else if (ch === close) {
          depth -= 1;
          if (depth === 0) break;
        }
      }
      if (depth !== 0) break;
      found.push({ text: token.slice(i, j + 1), start: i, end: j + 1 });
      i = j;
      continue;
    }
    const simple = token.slice(i).match(/^\$(?:[A-Za-z_][A-Za-z0-9_]*|[0-9@*?#$!-])/);
    if (simple) {
      found.push({ text: simple[0], start: i, end: i + simple[0].length });
      i += simple[0].length - 1;
    }
  }
  return found;
}

/**
 * True when the shell cannot hand this expansion back empty.
 *
 * Every entry is a guarantee, not a guess. Getting this wrong in the permissive direction
 * reopens the incident; getting it wrong in the strict direction blocks routine cleanup,
 * which gets the guard switched off. Both failures are real, so only provable cases qualify.
 */
function expansionCannotBeEmpty(text: string, nonEmptyNames: ReadonlySet<string>): boolean {
  // ${VAR:?} / ${VAR:?message} - POSIX aborts on unset or empty.
  if (GUARDED_EXPANSION.test(text)) return true;

  // ${VAR:-default} with a non-empty default. `:-` substitutes the default when VAR is unset
  // OR empty, so the result is non-empty. Plain `${VAR-default}` does NOT qualify: it only
  // covers unset, so a set-but-empty VAR still yields "".
  // $PWD and $(pwd) are maintained by the shell, but only while nothing reassigns PWD.
  if (text === "$PWD" || text === "${PWD}" || /^\$\(\s*pwd\s*\)$/.test(text) || /^`\s*pwd\s*`$/.test(text)) {
    return !nonEmptyNames.has(PWD_REASSIGNED);
  }

  // Assigned a non-empty literal earlier in this same command.
  const name = text.match(/^\$\{?([A-Za-z_][A-Za-z0-9_]*)\}?$/);
  return name !== null && nonEmptyNames.has(name[1]);
}

/**
 * Value an expansion is guaranteed to take when the variable is unset or empty, or null when
 * there is no such guarantee.
 *
 * `${VAR:-default}` substitutes the default whenever VAR is unset OR empty, so the worst case
 * is the default itself - and the default is used verbatim rather than assumed harmless.
 * `${A:-/}` therefore collapses to `/` and blocks, where treating "has a default" as "is safe"
 * let it through. Plain `${VAR-default}` does NOT qualify: it only covers unset, so a
 * set-but-empty VAR still yields "".
 */
function expansionFallbackValue(
  text: string,
  nonEmptyNames: ReadonlySet<string>,
  depth = 0
): string | null {
  const withDefault = text.match(/^\$\{[A-Za-z_][A-Za-z0-9_]*:-([\s\S]*)\}$/);
  if (!withDefault) return null;
  // Bounded because this recurses once per nesting level while re-scanning the remainder:
  // `${A:-${A:- … }}` 40k deep overflowed the stack, the hook caught it and answered
  // {"continue":true}, and the `rm -rf /*` in the same command was never classified at all.
  // Past the cap there is no guarantee left to prove, so the value is treated as collapsible,
  // which blocks rather than allows.
  if (depth >= MAX_EXPANSION_NESTING) return "";
  const fallback = withDefault[1];
  if (fallback.length === 0) return "";

  let value = "";
  let cursor = 0;
  for (const inner of findExpansions(fallback)) {
    value += fallback.slice(cursor, inner.start);
    const nested = expansionFallbackValue(inner.text, nonEmptyNames, depth + 1);
    if (nested !== null) value += nested;
    else if (expansionCannotBeEmpty(inner.text, nonEmptyNames)) value += NON_EMPTY_PLACEHOLDER;
    cursor = inner.end;
  }
  value += fallback.slice(cursor);
  return value;
}

/**
 * The shape that destroyed station02 on 2026-07-24.
 *
 * `bun pm cache` writes its path to stdout on success, but exits 1 with an empty stdout
 * when no package.json is found walking up from cwd. `rm -rf "$(bun pm cache)"/*` therefore
 * became `rm -rf /*`. Redirecting stderr does not help: the redirect discards the
 * diagnostic, not the path. The hazard is not this command - it is any expansion the shell
 * may hand back empty, immediately followed by a path separator.
 *
 * Returns the token with every expansion replaced by the empty string, i.e. the worst case
 * the shell can produce. Returns null when:
 *  - the token contains no expansion; or
 *  - the collapse is not absolute. A bare `rm -rf "$(cmd)"` collapses to `rm -rf ""`, which
 *    POSIX rm rejects with "cannot remove ''" and a non-zero exit without deleting anything,
 *    and blocking it would break routine `rm -rf "$tmpdir"` cleanup for no safety gain. A
 *    relative collapse stays inside cwd and is already covered by the ordinary target check.
 *    The whole catastrophic class is the one where the collapse leaves a leading `/`.
 */
export function emptyExpansionCollapse(
  token: string,
  nonEmptyNames: ReadonlySet<string> = new Set()
): string | null {
  if (!/[$`]/.test(token)) return null;
  const expansions = findExpansions(token);
  if (expansions.length === 0) return null;

  let sawCollapsible = false;
  let collapsed = "";
  let cursor = 0;
  for (const expansion of expansions) {
    collapsed += token.slice(cursor, expansion.start);
    const fallback = expansionFallbackValue(expansion.text, nonEmptyNames);
    if (fallback !== null) {
      // The default IS the worst case, so the resulting path still has to be checked -
      // `${A:-/}` yields `/`, which is the whole hazard, not a reason to skip the check.
      collapsed += fallback;
      sawCollapsible = true;
    } else if (expansionCannotBeEmpty(expansion.text, nonEmptyNames)) {
      collapsed += NON_EMPTY_PLACEHOLDER;
    } else {
      sawCollapsible = true;
    }
    cursor = expansion.end;
  }
  collapsed += token.slice(cursor);

  if (!sawCollapsible || !collapsed.startsWith("/")) return null;
  return collapsed;
}

/**
 * One set per segment: the variables provably non-empty at the moment that segment runs.
 *
 * Built in a SINGLE forward pass. The previous version recomputed the whole segmentation and
 * rescanned every preceding segment on each call, and was called once per chunk - O(segments²).
 * 36 KB of `:; ` padding took 25.6s against this hook's 20s timeout, and a timed-out hook fails
 * open, so padding alone turned a blocked `rm -rf /*` into an unguarded one. That is the same
 * fail-open the wrapper caps were written to stop, reopened along a different axis.
 *
 * Every relaxation here is a way past the guard, so each condition is a guarantee:
 *
 *   X=/tmp/build rm -rf "$X"/*        a PREFIX assignment applies to the command's own
 *                                     environment, not to the expansion, which bash performs
 *                                     first; `$X` is still empty
 *   rm -rf "$X"/* ; X=/tmp/build      an assignment AFTER the delete counted
 *   X=/tmp/build; X=$(cmd); rm …      a later reassignment to something collapsible
 *   X=/tmp/build; X=; rm …            an explicit empty reassignment
 *   X=/tmp/build; unset X; rm …       an unset
 *   (X=/tmp/build); rm …              a subshell-scoped assignment escaping its subshell
 *   X=/tmp/build | cat; rm …          a pipeline-stage assignment doing the same
 */
export function assignmentWalker(command: string): { at: (segmentIndex: number) => ReadonlySet<string> } {
  const segments = splitShellSegmentsDetailed(command);
  let cursor = 0;
  let current = new Set<string>();

  // Advances a SINGLE set forward and hands it out only when a segment actually contains a
  // delete. Materialising one snapshot per segment was O(segments x names): 30k distinct
  // names took 24.4s against the 20s timeout, and a timed-out hook fails open. Almost every
  // command has one delete, so almost every command now copies nothing.
  const at = (segmentIndex: number): ReadonlySet<string> => {
    while (cursor < segmentIndex && cursor < segments.length) {
      applySegment(segments[cursor]);
      cursor += 1;
    }
    return current;
  };

  // Depth of open `if` / `while` / `until` / `case` blocks. Everything inside one may not run.
  let conditionalDepth = 0;
  // Brace-group nesting, and the depth at which a `&&`/`||` right-hand side was entered.
  let braceDepth = 0;
  let conditionalBraceDepth = 0;

  function applySegment({ text, depth, isolated, shortCircuit }: ShellSegment): void {


    // `{ X=; }`, `then X=`, `do X=` - strip the compound-command keyword so the assignment
    // inside is seen. cwdTrackedSegments already did this; this scan did not, so
    // `X=/tmp/build; { X=; }; rm -rf "$X"/*` kept X certified while bash emptied it.
    const rawTokens = shellWords(text);
    const tokens = rawTokens.filter((token, index) => !(index === 0 && COMPOUND_KEYWORDS.has(token)));
    // An assignment that may never execute must not CERTIFY, though it must still WITHDRAW -
    // the branch might run. Conditionality is a property of context, so it is tracked across
    // segments rather than read off the first token of this one. Deriving it from "a compound
    // keyword was stripped from token 0" closed about 5% of the class: inserting one statement
    // (`if false; then A=1; X=/tmp/build; fi`) or using `&&`/`||`/`case` restored certification,
    // and 297 of those shapes were bash-proven `rm -rf /*`.
    //
    // A brace group `{ …; }` is NOT conditional - bash runs it in the current shell - so it is
    // deliberately excluded here even though its keyword is stripped for tokenizing.
    // `for` opens because `done` closes it - omitting it while keeping `done` a closer let any
    // `for` loop inside a conditional zero the counter. `elif` does NOT open: `fi` closes an
    // if/elif/else chain exactly once, so counting elif left the depth permanently above zero
    // and nothing after the block could ever certify.
    const OPENERS = new Set(["if", "while", "until", "case", "select", "for"]);
    const CLOSERS = new Set(["fi", "done", "esac"]);
    // Keywords that introduce the NEXT command rather than being one, so the real command
    // token sits behind them: `then for f in …` opens a loop that `done` will close.
    const INTRODUCERS = new Set(["then", "do", "else", "elif", "!", "{", "}", "("]);

    // Only a keyword in COMMAND POSITION is a keyword. `echo done`, `touch fi` and a `fi`
    // inside a heredoc body or after `#` are ordinary words, and treating them as closers
    // decremented the counter and re-certified the branch.
    let leadingIndex = 0;
    while (leadingIndex < rawTokens.length && INTRODUCERS.has(rawTokens[leadingIndex])) leadingIndex += 1;
    const leading = rawTokens[leadingIndex];
    const introducer = rawTokens[0];

    if (leading !== undefined) {
      if (OPENERS.has(leading)) conditionalDepth += 1;
      else if (CLOSERS.has(leading)) conditionalDepth = Math.max(0, conditionalDepth - 1);
    }

    // `&&`/`||` govern the WHOLE right-hand side, including a brace group. Marking only the
    // first segment after the operator let `false && { A=1; X=/tmp/build; }` certify X.
    if (introducer === "{") braceDepth += 1;
    if (introducer === "}" || rawTokens[rawTokens.length - 1] === "}") {
      braceDepth = Math.max(0, braceDepth - 1);
      if (braceDepth < conditionalBraceDepth) conditionalBraceDepth = 0;
    }
    if (shortCircuit && braceDepth > 0 && conditionalBraceDepth === 0) conditionalBraceDepth = braceDepth;

    // Keyword accounting happened above, deliberately BEFORE this return: `if ls /opt | grep
    // -q node; then …; CACHE=…; fi` marks the `if` segment isolated (it is followed by `|`),
    // so returning first swallowed the opener while its `fi` still decremented - and the
    // assignment after it certified. That is the realized incident shape.
    if (depth > 0 || isolated) return;

    const conditional = conditionalDepth > 0
      || shortCircuit
      || conditionalBraceDepth > 0
      || (leading !== undefined && OPENERS.has(leading))
      || (introducer !== undefined && (introducer === "then" || introducer === "do" || introducer === "elif"));
    // A function body runs later and elsewhere, so nothing in it can be relied on.
    if (/^[A-Za-z_][A-Za-z0-9_]*\s*\(\s*\)/.test(text) || rawTokens[0] === "function") {
      current = new Set();
      return;
    }
    if (tokens.length === 0) return;

    if (tokens[0] === "unset") {
      for (const name of tokens.slice(1)) {
        if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) current.delete(name);
      }
      return;
    }

    // Any construct that can rebind a name withdraws the guarantee. Scanned across ALL
    // tokens, not just the first: `IFS= read -r D` hides the builtin behind a prefix
    // assignment and `while read D` behind a keyword, and both kept D certified non-empty.
    //
    // Single pass, no slicing. Allocating `tokens.slice(position + 1)` per token made this
    // O(tokens^2): 20k `export A=1 ` took 20.9s against the 20s timeout, and a timed-out hook
    // fails open - the fourth time a bound in this file reopened that same hole.
    //
    // WITHDRAWAL is scanned at any position, because a rebinding can hide anywhere.
    // CERTIFICATION is granted only from token 0, because a mention is not an execution:
    // `# export CACHE=/tmp/x` in a comment certified CACHE as non-empty, which is the realized
    // incident shape exactly - a documented cleanup script is the likeliest way to write it.
    const withdraw = (name: string) => {
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) return;
      current.delete(name);
    };

    let pendingNameBinder = false;
    let pendingValueBinder = false;
    let valueBinderIsCommand = false;
    let sawNameref = false;
    let opaque = false;
    let sawNonAssignment = false;

    for (const [position, token] of tokens.entries()) {
      if (OPAQUE_BUILTINS.has(token)) { opaque = true; break; }

      if (NAME_BINDING_BUILTINS.has(token) || token === "for") {
        pendingNameBinder = true;
        pendingValueBinder = false;
        sawNonAssignment = true;
        continue;
      }
      if (VALUE_BINDING_BUILTINS.has(token)) {
        pendingValueBinder = true;
        pendingNameBinder = false;
        // Only a builtin in command position can actually bind anything.
        valueBinderIsCommand = position === 0;
        sawNameref = false;
        sawNonAssignment = true;
        continue;
      }
      if (token === "printf") { sawNonAssignment = true; continue; }
      if (token === "-v") { pendingNameBinder = true; continue; }
      if (token === "-n" && pendingValueBinder) { sawNameref = true; continue; }

      if (pendingNameBinder) {
        if (!token.startsWith("-")) withdraw(token);
        continue;
      }
      if (pendingValueBinder) {
        if (token.startsWith("-")) continue;
        const bound = token.match(/^([A-Za-z_][A-Za-z0-9_]*)=([\s\S]*)$/);
        if (!bound) continue;
        withdraw(bound[1]);
        // `declare -n D=E` aliases D to E, so D's value is E's, not this literal.
        if (!conditional && valueBinderIsCommand && !sawNameref && bound[2].length > 0 && !/[$`]/.test(bound[2])) {
          current.add(bound[1]);
        }
        continue;
      }

      // Plain `NAME=value`, only while still in the command's assignment prefix.
      const assignment = token.match(/^([A-Za-z_][A-Za-z0-9_]*)=([\s\S]*)$/);
      if (!assignment) { sawNonAssignment = true; continue; }
      if (sawNonAssignment) continue;
      const [, name, value] = assignment;
      // A PREFIX assignment applies to the command's environment, not to this expansion.
      const isPrefixAssignment = position < tokens.length - 1
        && !/^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[position + 1] ?? "");
      current.delete(name);
      if (name === "PWD") current.add(PWD_REASSIGNED);
      if (isPrefixAssignment) continue;
      if (!conditional && value.length > 0 && !/[$`]/.test(value)) current.add(name);
    }

    if (opaque) current = new Set();
  }

  return { at };
}
