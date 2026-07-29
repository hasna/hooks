import chalk from "chalk";
import { HOOKS, type HookMeta } from "../../lib/registry.js";
import { getSettingsPath, type ConcreteTarget, type Scope, type Target } from "../../lib/installer.js";

export function resolveScope(options: { global?: boolean; project?: boolean }): Scope {
  if (options.project) return "project";
  return "global";
}

export function resolveTarget(options: { target?: string }): Target {
  if (options.target === "gemini") return "gemini";
  if (options.target === "codewith") return "codewith";
  if (options.target === "all") return "all";
  return "claude";
}

export function resolveConcreteTarget(options: { target?: string }): ConcreteTarget {
  if (options.target === "gemini") return "gemini";
  if (options.target === "codewith") return "codewith";
  return "claude";
}

export function formatSettingsPath(scope: Scope, target: Target): string {
  if (target === "all") return "target-specific settings";
  const actual = getSettingsPath(scope, target);
  if (scope === "project") {
    if (target === "codewith") return ".codewith/config.toml";
    if (target === "gemini") return ".gemini/settings.json";
    return ".claude/settings.json";
  }
  if (target === "codewith") {
    return process.env.HASNA_HOOKS_CODEWITH_CONFIG_PATH ? "$HASNA_HOOKS_CODEWITH_CONFIG_PATH" : "~/.codewith/config.toml";
  }
  if (target === "gemini") return "~/.gemini/settings.json";
  return actual === getSettingsPath("global", "claude") ? "~/.claude/settings.json" : actual;
}

export function parseLimit(value: string | undefined, fallback: number, max: number): number {
  const parsed = value ? parseInt(value, 10) : fallback;
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.min(parsed, max);
}

export function truncateText(value: string | undefined, max = 96): string {
  const text = (value ?? "").replace(/\s+/g, " ").trim();
  if (text.length <= max) return text;
  return `${text.slice(0, Math.max(0, max - 3))}...`;
}

export function readmePreview(readme: string, max = 280): string | undefined {
  const blocks = readme
    .split(/\n\s*\n/)
    .map((part) => part.trim())
    .filter(Boolean)
    .filter((part) => !part.startsWith("#"))
    .filter((part) => !part.startsWith("```"))
    .filter((part) => !/^\[!\[/.test(part));
  const preview = blocks[0]
    ?? readme.split("\n").map((line) => line.trim()).find((line) => line && !line.startsWith("#"));
  return preview ? truncateText(preview, max) : undefined;
}

export function hookSummaryLine(hook: HookMeta, options: { verbose?: boolean } = {}): string {
  const matcher = hook.matcher ? ` ${hook.matcher}` : "";
  const description = options.verbose ? ` - ${truncateText(hook.description, 110)}` : "";
  return `  ${chalk.cyan(hook.name.padEnd(17))} ${chalk.dim(`[${hook.event}${matcher}]`)} ${chalk.dim(hook.category)}${description}`;
}

export function printDisclosureHint(hidden: number, detailCommand: string, options: { includeAll?: boolean } = {}): void {
  const rowControls = options.includeAll ? "--limit, --all, --verbose" : "--limit, --verbose";
  if (hidden > 0) {
    console.log(chalk.dim(`\n  Showing a compact subset. ${hidden} more hidden; use ${rowControls}, or ${detailCommand}.`));
  } else {
    console.log(chalk.dim(`\n  Use --verbose or ${detailCommand} for details.`));
  }
}

/** Levenshtein distance for did-you-mean suggestions */
export function editDistance(a: string, b: string): number {
  const m = a.length, n = b.length;
  const dp: number[][] = Array.from({ length: m + 1 }, (_, i) => [i, ...Array(n).fill(0)]);
  for (let j = 0; j <= n; j++) dp[0][j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i][j] = a[i - 1] === b[j - 1]
        ? dp[i - 1][j - 1]
        : 1 + Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1]);
    }
  }
  return dp[m][n];
}

export function suggestHooks(name: string, max = 3): string[] {
  return HOOKS
    .map((h) => ({ name: h.name, dist: editDistance(name.toLowerCase(), h.name.toLowerCase()) }))
    .filter(({ dist }) => dist <= 4)
    .sort((a, b) => a.dist - b.dist)
    .slice(0, max)
    .map(({ name: n }) => n);
}
