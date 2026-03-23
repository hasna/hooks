#!/usr/bin/env bun
import React from "react";
import { render } from "ink";
import { Command } from "commander";
import chalk from "chalk";
import { existsSync, readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { homedir } from "os";

const __dirname = dirname(fileURLToPath(import.meta.url));
// Resolve package.json from both source (src/cli/) and built (bin/) locations
const pkgPath = existsSync(join(__dirname, "..", "package.json"))
  ? join(__dirname, "..", "package.json")
  : join(__dirname, "..", "..", "package.json");
const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
import { App } from "./components/App.js";
import {
  HOOKS,
  CATEGORIES,
  getHooksByCategory,
  searchHooks,
  getHook,
} from "../lib/registry.js";
import {
  installHook,
  getInstalledHooks,
  getRegisteredHooks,
  getRegisteredHooksForTarget,
  removeHook,
  hookExists,
  getHookPath,
  getSettingsPath,
  type Scope,
} from "../lib/installer.js";
import {
  createProfile,
  getProfile,
  listProfiles,
  touchProfile,
  exportProfiles,
  importProfiles,
} from "../lib/profiles.js";

const program = new Command();

function resolveScope(options: { global?: boolean; project?: boolean }): Scope {
  if (options.project) return "project";
  return "global";
}

function resolveTarget(options: { target?: string }): "claude" | "gemini" | "all" {
  if (options.target === "gemini") return "gemini";
  if (options.target === "all") return "all";
  return "claude";
}

/** Levenshtein distance for did-you-mean suggestions */
function editDistance(a: string, b: string): number {
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

function suggestHooks(name: string, max = 3): string[] {
  return HOOKS
    .map((h) => ({ name: h.name, dist: editDistance(name.toLowerCase(), h.name.toLowerCase()) }))
    .filter(({ dist }) => dist <= 4)
    .sort((a, b) => a.dist - b.dist)
    .slice(0, max)
    .map(({ name: n }) => n);
}

program
  .name("hooks")
  .description("Install hooks for AI coding agents")
  .version(pkg.version);

// Interactive mode (default)
program
  .command("interactive", { isDefault: true })
  .alias("i")
  .description("Interactive hook browser")
  .action(() => {
    render(<App />);
  });

// Init command — register a new agent profile
program
  .command("init")
  .description("Register a new agent profile with a unique ID")
  .option("-a, --agent <type>", "Agent type: claude, gemini, custom", "claude")
  .option("-n, --name <name>", "Optional display name for the agent")
  .option("-j, --json", "Output as JSON", false)
  .action((options: { agent: string; name?: string; json: boolean }) => {
    const agentType = options.agent as "claude" | "gemini" | "custom";
    if (!["claude", "gemini", "custom"].includes(agentType)) {
      if (options.json) {
        console.log(JSON.stringify({ error: `Invalid agent type: ${options.agent}`, valid: ["claude", "gemini", "custom"] }));
      } else {
        console.log(chalk.red(`Invalid agent type: ${options.agent}`));
        console.log(chalk.dim("Valid types: claude, gemini, custom"));
      }
      return;
    }

    const profile = createProfile({ agent_type: agentType, name: options.name });

    if (options.json) {
      console.log(JSON.stringify(profile));
      return;
    }

    console.log(chalk.green(`\n✓ Agent profile created\n`));
    console.log(`  ${chalk.dim("Agent ID:")}   ${chalk.bold(profile.agent_id)}`);
    console.log(`  ${chalk.dim("Type:")}       ${profile.agent_type}`);
    if (profile.name) {
      console.log(`  ${chalk.dim("Name:")}       ${profile.name}`);
    }
    console.log(`  ${chalk.dim("Profile:")}    ~/.hasna/hooks/profiles/${profile.agent_id}.json`);
    console.log();
    console.log(chalk.dim("  Install hooks with this profile:"));
    console.log(`    hooks install gitguard --profile ${profile.agent_id}`);
    console.log();
  });

// Run command — executes a hook, called by AI coding agents via settings.json
program
  .command("run")
  .argument("<hook>", "Hook to run")
  .option("--profile <id>", "Agent profile ID")
  .description("Execute a hook (called by AI coding agents)")
  .action(async (hook: string, options: { profile?: string }) => {
    const meta = getHook(hook);
    if (!meta) {
      console.error(JSON.stringify({ error: `Hook '${hook}' not found` }));
      process.exit(1);
    }

    const hookDir = getHookPath(hook);
    const hookScript = join(hookDir, "src", "hook.ts");

    if (!existsSync(hookScript)) {
      console.error(JSON.stringify({ error: `Hook script not found: ${hookScript}` }));
      process.exit(1);
    }

    // Read stdin (agent passes hook context as JSON)
    const stdin = await new Response(Bun.stdin.stream()).text();

    // If profile specified, inject agent data into the hook input
    let hookStdin = stdin;
    if (options.profile) {
      const profile = getProfile(options.profile);
      if (profile) {
        touchProfile(options.profile);
        try {
          const input = JSON.parse(stdin);
          input.agent = {
            agent_id: profile.agent_id,
            agent_type: profile.agent_type,
            name: profile.name,
            preferences: profile.preferences,
          };
          hookStdin = JSON.stringify(input);
        } catch {
          // If stdin is not valid JSON, pass through unmodified
        }
      }
    }

    // Execute the hook script with bun, passing stdin through
    const proc = Bun.spawn(["bun", "run", hookScript], {
      stdin: new Response(hookStdin),
      stdout: "pipe",
      stderr: "pipe",
      env: process.env,
    });

    const stdout = await new Response(proc.stdout).text();
    const stderr = await new Response(proc.stderr).text();
    const exitCode = await proc.exited;

    if (stdout) process.stdout.write(stdout);
    if (stderr) process.stderr.write(stderr);
    process.exit(exitCode);
  });

// Install command
program
  .command("install")
  .alias("add")
  .argument("[hooks...]", "Hooks to install")
  .option("-o, --overwrite", "Overwrite existing hooks", false)
  .option("-a, --all", "Install all available hooks", false)
  .option("-c, --category <category>", "Install all hooks in a category")
  .option("-g, --global", "Install globally (~/.claude/settings.json)", false)
  .option("-p, --project", "Install for current project (.claude/settings.json)", false)
  .option("-t, --target <target>", "Agent target: claude, gemini, all (default: claude)", "claude")
  .option("--profile <id>", "Agent profile ID to scope hooks to")
  .option("--dry-run", "Preview what would be installed without writing to settings", false)
  .option("-j, --json", "Output as JSON", false)
  .description("Install one or more hooks")
  .action((hooks: string[], options) => {
    const scope = resolveScope(options);
    const target = resolveTarget(options);
    let toInstall: string[] = hooks;

    if (options.all) {
      toInstall = HOOKS.map((h) => h.name);
    } else if (options.category) {
      const category = CATEGORIES.find(
        (c) => c.toLowerCase() === options.category.toLowerCase()
      );
      if (!category) {
        if (options.json) {
          console.log(JSON.stringify({ error: `Unknown category: ${options.category}`, available: [...CATEGORIES] }));
        } else {
          console.log(chalk.red(`Unknown category: ${options.category}`));
          console.log(chalk.dim(`Available: ${CATEGORIES.join(", ")}`));
        }
        return;
      }
      toInstall = getHooksByCategory(category).map((h) => h.name);
    }

    if (toInstall.length === 0) {
      render(<App />);
      return;
    }

    // Dry-run: preview what would be installed
    if (options.dryRun) {
      const known = toInstall.filter((n) => getHook(n));
      const unknown = toInstall.filter((n) => !getHook(n));
      if (options.json) {
        console.log(JSON.stringify({ dryRun: true, would_install: known, unknown, scope, target }));
        return;
      }
      console.log(chalk.bold(`\nDry run — would install (${scope}, ${target}):\n`));
      for (const name of known) {
        const meta = getHook(name)!;
        console.log(chalk.cyan(`  ${name}`) + chalk.dim(` [${meta.event}${meta.matcher ? ` ${meta.matcher}` : ""}]`));
      }
      if (unknown.length > 0) {
        console.log();
        for (const name of unknown) {
          const suggestions = suggestHooks(name);
          console.log(chalk.red(`  ✗ unknown: ${name}`) + (suggestions.length ? chalk.dim(` — did you mean: ${suggestions.join(", ")}?`) : ""));
        }
      }
      return;
    }

    const results = [];
    for (const name of toInstall) {
      // Did-you-mean for unknown hooks
      if (!getHook(name)) {
        const suggestions = suggestHooks(name);
        const hint = suggestions.length ? ` — did you mean: ${suggestions.join(", ")}?` : "";
        results.push({ hook: name, success: false, error: `Hook '${name}' not found${hint}` });
        continue;
      }
      const result = installHook(name, { scope, overwrite: options.overwrite, target, profile: options.profile });
      results.push(result);
    }

    if (options.json) {
      console.log(JSON.stringify({
        installed: results.filter((r) => r.success).map((r) => r.hook),
        failed: results.filter((r) => !r.success).map((r) => ({ hook: r.hook, error: r.error })),
        total: results.length,
        success: results.filter((r) => r.success).length,
        scope,
        target,
      }));
      return;
    }

    const settingsFile = scope === "project" ? ".claude/settings.json" : "~/.claude/settings.json";
    console.log(chalk.bold(`\nInstalling hooks (${scope}, ${target})...\n`));
    for (const result of results) {
      if (result.success) {
        const meta = getHook(result.hook);
        console.log(chalk.green(`✓ ${result.hook}`));
        if (meta) {
          console.log(
            chalk.dim(`  ${meta.event}${meta.matcher ? ` [${meta.matcher}]` : ""} → hooks run ${result.hook}`)
          );
        }
        if (result.conflict) {
          console.log(chalk.yellow(`  ⚠ Warning: ${result.conflict}`));
        }
      } else {
        console.log(chalk.red(`✗ ${result.hook}: ${result.error}`));
      }
    }
    console.log(chalk.dim(`\nRegistered in ${settingsFile}`));
  });

// List command
program
  .command("list")
  .alias("ls")
  .option("-c, --category <category>", "Filter by category")
  .option("-a, --all", "Show all available hooks", false)
  .option("-i, --installed", "Show only installed hooks", false)
  .option("-r, --registered", "Show registered hooks", false)
  .option("-g, --global", "Check global settings", false)
  .option("-p, --project", "Check project settings", false)
  .option("-t, --target <target>", "Agent target: claude, gemini (default: claude)", "claude")
  .option("-j, --json", "Output as JSON", false)
  .description("List available or installed hooks")
  .action((options) => {
    const scope = resolveScope(options);

    if (options.registered || options.installed) {
      const target = (options.target === "gemini" ? "gemini" : "claude") as "claude" | "gemini";
      const registered = getRegisteredHooksForTarget(scope, target);
      if (options.json) {
        console.log(JSON.stringify(registered.map((name) => {
          const meta = getHook(name);
          return { name, event: meta?.event, version: meta?.version, description: meta?.description, scope, target };
        })));
        return;
      }
      if (registered.length === 0) {
        console.log(chalk.dim(`No hooks registered (${scope}, ${target})`));
        return;
      }
      console.log(chalk.bold(`\nRegistered hooks — ${scope}/${target} (${registered.length}):\n`));
      for (const name of registered) {
        const meta = getHook(name);
        console.log(
          `  ${chalk.cyan(name)} ${chalk.dim(`[${meta?.event || "unknown"}]`)} - ${meta?.description || ""}`
        );
      }
      return;
    }

    if (options.category) {
      const category = CATEGORIES.find(
        (c) => c.toLowerCase() === options.category.toLowerCase()
      );
      if (!category) {
        if (options.json) {
          console.log(JSON.stringify({ error: `Unknown category: ${options.category}`, available: [...CATEGORIES] }));
        } else {
          console.log(chalk.red(`Unknown category: ${options.category}`));
          console.log(chalk.dim(`Available: ${CATEGORIES.join(", ")}`));
        }
        return;
      }
      const hooks = getHooksByCategory(category);
      if (options.json) {
        console.log(JSON.stringify(hooks));
        return;
      }
      console.log(chalk.bold(`\n${category} (${hooks.length}):\n`));
      for (const h of hooks) {
        console.log(
          `  ${chalk.cyan(h.name)} ${chalk.dim(`[${h.event}]`)} - ${h.description}`
        );
      }
      return;
    }

    // Show all by category
    if (options.json) {
      const result: Record<string, any[]> = {};
      for (const category of CATEGORIES) {
        result[category] = getHooksByCategory(category);
      }
      console.log(JSON.stringify(result));
      return;
    }

    console.log(chalk.bold(`\nAvailable hooks (${HOOKS.length}):\n`));
    for (const category of CATEGORIES) {
      const hooks = getHooksByCategory(category);
      console.log(chalk.bold(`${category} (${hooks.length}):`));
      for (const h of hooks) {
        console.log(
          `  ${chalk.cyan(h.name)} ${chalk.dim(`[${h.event}]`)} - ${h.description}`
        );
      }
      console.log();
    }
  });

// Search command
program
  .command("search")
  .argument("<query>", "Search term")
  .option("-j, --json", "Output as JSON", false)
  .description("Search for hooks")
  .action((query: string, options: { json: boolean }) => {
    const results = searchHooks(query);
    if (options.json) {
      console.log(JSON.stringify(results));
      return;
    }
    if (results.length === 0) {
      console.log(chalk.dim(`No hooks found for "${query}"`));
      return;
    }
    console.log(chalk.bold(`\nFound ${results.length} hook(s):\n`));
    for (const h of results) {
      console.log(
        `  ${chalk.cyan(h.name)} ${chalk.dim(`[${h.event}] [${h.category}]`)}`
      );
      console.log(`    ${h.description}`);
    }
  });

// Remove command
program
  .command("remove")
  .alias("rm")
  .argument("<hook>", "Hook to remove")
  .option("-g, --global", "Remove from global settings", false)
  .option("-p, --project", "Remove from project settings", false)
  .option("-t, --target <target>", "Agent target: claude, gemini, all (default: claude)", "claude")
  .option("-j, --json", "Output as JSON", false)
  .description("Remove an installed hook")
  .action((hook: string, options: { global?: boolean; project?: boolean; target?: string; json: boolean }) => {
    const scope = resolveScope(options);
    const target = resolveTarget(options);

    // Did-you-mean for unknown hook names
    if (!getHook(hook)) {
      const suggestions = suggestHooks(hook);
      const hint = suggestions.length ? ` — did you mean: ${suggestions.join(", ")}?` : "";
      if (options.json) {
        console.log(JSON.stringify({ hook, removed: false, scope, target, error: `Hook '${hook}' not found${hint}`, suggestions }));
      } else {
        console.log(chalk.red(`✗ Hook '${hook}' not found${hint}`));
      }
      return;
    }

    const removed = removeHook(hook, scope, target);
    if (options.json) {
      console.log(JSON.stringify({ hook, removed, scope, target }));
      return;
    }
    if (removed) {
      console.log(chalk.green(`✓ Removed ${hook} (${scope}, ${target})`));
    } else {
      console.log(chalk.red(`✗ ${hook} is not installed (${scope}, ${target})`));
    }
  });

// Categories command
program
  .command("categories")
  .option("-j, --json", "Output as JSON", false)
  .description("List all categories")
  .action((options: { json: boolean }) => {
    if (options.json) {
      const result = CATEGORIES.map((cat) => ({
        name: cat,
        count: getHooksByCategory(cat).length,
      }));
      console.log(JSON.stringify(result));
      return;
    }
    console.log(chalk.bold("\nCategories:\n"));
    for (const category of CATEGORIES) {
      const count = getHooksByCategory(category).length;
      console.log(`  ${category} (${count})`);
    }
  });

// Info command
program
  .command("info")
  .argument("<hook>", "Hook name")
  .option("-j, --json", "Output as JSON", false)
  .description("Show detailed info about a hook")
  .action((hook: string, options: { json: boolean }) => {
    const meta = getHook(hook);
    if (!meta) {
      const suggestions = suggestHooks(hook);
      const hint = suggestions.length ? ` — did you mean: ${suggestions.join(", ")}?` : "";
      if (options.json) {
        console.log(JSON.stringify({ error: `Hook '${hook}' not found${hint}`, suggestions }));
      } else {
        console.log(chalk.red(`Hook '${hook}' not found${hint}`));
      }
      return;
    }

    const globalInstalled = getRegisteredHooks("global").includes(meta.name);
    const projectInstalled = getRegisteredHooks("project").includes(meta.name);

    if (options.json) {
      console.log(JSON.stringify({ ...meta, global: globalInstalled, project: projectInstalled }));
      return;
    }

    console.log(chalk.bold(`\n${meta.displayName}\n`));
    console.log(`  ${meta.description}`);
    console.log();
    console.log(`  ${chalk.dim("Category:")}  ${meta.category}`);
    console.log(`  ${chalk.dim("Version:")}   ${meta.version}`);
    console.log(`  ${chalk.dim("Event:")}     ${meta.event}`);
    console.log(`  ${chalk.dim("Matcher:")}   ${meta.matcher || "(none)"}`);
    console.log(`  ${chalk.dim("Tags:")}      ${meta.tags.join(", ")}`);
    console.log(`  ${chalk.dim("Command:")}   hooks run ${meta.name}`);
    console.log();

    if (globalInstalled) {
      console.log(chalk.green("  ● Installed globally"));
    } else {
      console.log(chalk.dim("  ○ Not installed globally"));
    }

    if (projectInstalled) {
      console.log(chalk.green("  ● Installed in project"));
    } else {
      console.log(chalk.dim("  ○ Not installed in project"));
    }
  });

// Doctor command
program
  .command("doctor")
  .option("-g, --global", "Check global settings", false)
  .option("-p, --project", "Check project settings", false)
  .option("-j, --json", "Output as JSON", false)
  .description("Check health of installed hooks")
  .action((options: { global?: boolean; project?: boolean; json: boolean }) => {
    const scope = resolveScope(options);
    const settingsPath = getSettingsPath(scope);
    const issues: { hook: string; issue: string; severity: "error" | "warning" }[] = [];
    const healthy: string[] = [];

    const settingsExist = existsSync(settingsPath);
    if (!settingsExist) {
      issues.push({ hook: "(settings)", issue: `${settingsPath} not found`, severity: "warning" });
    }

    const registered = getRegisteredHooks(scope);

    for (const name of registered) {
      const meta = getHook(name);
      let hookHealthy = true;

      // Check hook exists in the package
      if (!hookExists(name)) {
        issues.push({ hook: name, issue: "Hook not found in @hasna/hooks package", severity: "error" });
        hookHealthy = false;
        continue;
      }

      // Check hook has source
      const hookDir = getHookPath(name);
      const hookScript = join(hookDir, "src", "hook.ts");
      if (!existsSync(hookScript)) {
        issues.push({ hook: name, issue: "Missing src/hook.ts in package", severity: "error" });
        hookHealthy = false;
      }

      // Verify correct event registration
      if (meta && settingsExist) {
        try {
          const settings = JSON.parse(readFileSync(settingsPath, "utf-8"));
          const eventHooks = settings.hooks?.[meta.event] || [];
          const found = eventHooks.some((entry: any) =>
            entry.hooks?.some((h: any) => {
              const match = h.command?.match(/^hooks run (\w+)/);
              return match && match[1] === name;
            })
          );
          if (!found) {
            issues.push({ hook: name, issue: `Not registered under correct event (${meta.event})`, severity: "error" });
            hookHealthy = false;
          }
        } catch {}
      }

      if (hookHealthy) {
        healthy.push(name);
      }
    }

    if (options.json) {
      console.log(JSON.stringify({ healthy: issues.length === 0, healthy_hooks: healthy, issues, registered, scope }));
      return;
    }

    console.log(chalk.bold(`\nHook Health Check (${scope})\n`));

    if (registered.length === 0) {
      console.log(chalk.dim("  No hooks registered."));
      console.log(chalk.dim("  Run: hooks install gitguard"));
      return;
    }

    if (healthy.length > 0) {
      console.log(chalk.green(`  ✓ ${healthy.length} hook(s) healthy:`));
      for (const name of healthy) {
        console.log(chalk.green(`    ${name}`));
      }
    }

    if (issues.length > 0) {
      console.log();
      for (const issue of issues) {
        const icon = issue.severity === "error" ? chalk.red("✗") : chalk.yellow("!");
        console.log(`  ${icon} ${chalk.cyan(issue.hook)}: ${issue.issue}`);
      }
    }

    if (issues.length === 0) {
      console.log(chalk.green("\n  All hooks healthy!"));
    }

    console.log();
  });

// Update command
program
  .command("update")
  .argument("[hooks...]", "Hooks to update (defaults to all installed)")
  .option("-g, --global", "Update global hooks", false)
  .option("-p, --project", "Update project hooks", false)
  .option("-j, --json", "Output as JSON", false)
  .description("Re-register hooks (picks up new package version)")
  .action((hooks: string[], options: { global?: boolean; project?: boolean; json: boolean }) => {
    const scope = resolveScope(options);
    const installed = getInstalledHooks(scope);
    const toUpdate = hooks.length > 0 ? hooks : installed;

    if (toUpdate.length === 0) {
      if (options.json) {
        console.log(JSON.stringify({ updated: [], error: "No hooks installed" }));
      } else {
        console.log(chalk.dim("No hooks installed to update."));
      }
      return;
    }

    const results = [];
    for (const name of toUpdate) {
      if (!installed.includes(name)) {
        results.push({ hook: name, success: false, error: "Not installed" });
        continue;
      }
      const result = installHook(name, { scope, overwrite: true });
      results.push(result);
    }

    if (options.json) {
      console.log(JSON.stringify({
        updated: results.filter((r) => r.success).map((r) => r.hook),
        failed: results.filter((r) => !r.success).map((r) => ({ hook: r.hook, error: r.error })),
      }));
      return;
    }

    console.log(chalk.bold("\nUpdating hooks...\n"));
    for (const result of results) {
      if (result.success) {
        console.log(chalk.green(`✓ ${result.hook} updated`));
      } else {
        console.log(chalk.red(`✗ ${result.hook}: ${result.error}`));
      }
    }
  });

// Docs command
program
  .command("docs")
  .argument("[hook]", "Hook name (shows general docs if omitted)")
  .option("-j, --json", "Output as JSON", false)
  .description("Show documentation for hooks")
  .action((hook: string | undefined, options: { json: boolean }) => {
    if (hook) {
      const meta = getHook(hook);
      if (!meta) {
        if (options.json) {
          console.log(JSON.stringify({ error: `Hook '${hook}' not found` }));
        } else {
          console.log(chalk.red(`Hook '${hook}' not found`));
        }
        return;
      }

      const hookPath = getHookPath(hook);
      const readmePath = join(hookPath, "README.md");
      let readme = "";
      if (existsSync(readmePath)) {
        readme = readFileSync(readmePath, "utf-8");
      }

      if (options.json) {
        console.log(JSON.stringify({ ...meta, readme }));
        return;
      }

      console.log(chalk.bold(`\n${meta.displayName} v${meta.version}\n`));
      console.log(`  ${meta.description}\n`);
      console.log(chalk.bold("  Configuration:"));
      console.log(`    Event:    ${meta.event}`);
      console.log(`    Matcher:  ${meta.matcher || "(all tools)"}`);
      console.log(`    Command:  hooks run ${meta.name}`);
      console.log();
      console.log(chalk.bold("  Install:"));
      console.log(`    hooks install ${meta.name}            # global`);
      console.log(`    hooks install ${meta.name} --project   # project only`);
      console.log();

      if (readme) {
        console.log(chalk.bold("  README:\n"));
        for (const line of readme.split("\n")) {
          console.log(`    ${line}`);
        }
      }
      return;
    }

    // General docs
    const generalDocs = {
      overview: "Hooks are scripts that run at specific points in an AI coding agent session. Install @hasna/hooks globally, then register hooks — no files are copied to your project.",
      events: {
        PreToolUse: "Fires before a tool executes. Can block the operation by returning { \"decision\": \"block\" }.",
        PostToolUse: "Fires after a tool executes. Runs asynchronously, cannot block.",
        Stop: "Fires when a session ends. Useful for notifications and cleanup.",
        Notification: "Fires on notification events like context compaction.",
      },
      installation: {
        global: "hooks install gitguard",
        project: "hooks install gitguard --project",
        category: "hooks install --category \"Git Safety\"",
        all: "hooks install --all",
      },
      management: {
        list: "hooks list",
        listInstalled: "hooks list --installed",
        search: "hooks search <query>",
        info: "hooks info <name>",
        remove: "hooks remove <name>",
        update: "hooks update",
        doctor: "hooks doctor",
        docs: "hooks docs <name>",
      },
      howItWorks: {
        install: "bun install -g @hasna/hooks",
        register: "hooks install gitguard → writes to ~/.claude/settings.json",
        execution: "Agent runs 'hooks run gitguard' → executes hook from global package",
        noFileCopy: "No files are copied to your project. Hooks run from the global @hasna/hooks package.",
      },
    };

    if (options.json) {
      console.log(JSON.stringify(generalDocs));
      return;
    }

    console.log(chalk.bold("\n@hasna/hooks Documentation\n"));

    console.log(chalk.bold("  Overview\n"));
    console.log(`    ${generalDocs.overview}\n`);

    console.log(chalk.bold("  How It Works\n"));
    for (const [label, desc] of Object.entries(generalDocs.howItWorks)) {
      console.log(`    ${chalk.dim(label + ":")}  ${desc}`);
    }

    console.log(chalk.bold("\n  Hook Events\n"));
    for (const [event, desc] of Object.entries(generalDocs.events)) {
      console.log(`    ${chalk.cyan(event)}`);
      console.log(`      ${desc}\n`);
    }

    console.log(chalk.bold("  Installation\n"));
    for (const [label, cmd] of Object.entries(generalDocs.installation)) {
      console.log(`    ${chalk.dim(label + ":")}  ${cmd}`);
    }

    console.log(chalk.bold("\n  Management\n"));
    for (const [label, cmd] of Object.entries(generalDocs.management)) {
      console.log(`    ${chalk.dim(label + ":")}  ${cmd}`);
    }

    console.log(chalk.bold("\n  Hook-Specific Docs\n"));
    console.log(`    hooks docs <name>     View README for a specific hook`);
    console.log(`    hooks docs --json     Machine-readable documentation`);
    console.log();
  });

// Upgrade command — self-update the @hasna/hooks package
program
  .command("upgrade")
  .option("-c, --check", "Check for updates without installing", false)
  .option("-j, --json", "Output as JSON", false)
  .description("Update the @hasna/hooks package to the latest version")
  .action(async (options: { check: boolean; json: boolean }) => {
    const current = pkg.version;

    // Detect package manager: prefer bun, fallback to npm
    let pm = "npm";
    try {
      const which = Bun.spawnSync(["which", "bun"]);
      if (which.exitCode === 0) pm = "bun";
    } catch {}

    if (options.check) {
      // Fetch latest version from npm registry
      const proc = Bun.spawnSync(["npm", "view", "@hasna/hooks", "version"]);
      const latest = new TextDecoder().decode(proc.stdout).trim();

      if (!latest) {
        if (options.json) {
          console.log(JSON.stringify({ error: "Failed to fetch latest version" }));
        } else {
          console.log(chalk.red("Failed to fetch latest version from npm registry."));
        }
        process.exit(1);
      }

      const upToDate = current === latest;
      if (options.json) {
        console.log(JSON.stringify({ current, latest, upToDate }));
      } else if (upToDate) {
        console.log(chalk.green(`✓ Already on latest version (${current})`));
      } else {
        console.log(chalk.yellow(`Update available: ${current} → ${latest}`));
        console.log(chalk.dim(`  Run: hooks upgrade`));
      }
      return;
    }

    // Perform the upgrade
    const installCmd = pm === "bun"
      ? ["bun", "install", "-g", "@hasna/hooks@latest"]
      : ["npm", "install", "-g", "@hasna/hooks@latest"];

    if (!options.json) {
      console.log(chalk.bold(`\nUpgrading @hasna/hooks (${pm})...\n`));
      console.log(chalk.dim(`  $ ${installCmd.join(" ")}\n`));
    }

    const proc = Bun.spawn(installCmd, {
      stdout: options.json ? "pipe" : "inherit",
      stderr: options.json ? "pipe" : "inherit",
      env: process.env,
    });

    const exitCode = await proc.exited;

    if (exitCode !== 0) {
      if (options.json) {
        console.log(JSON.stringify({ current, updated: false, error: `${pm} exited with code ${exitCode}` }));
      } else {
        console.log(chalk.red(`\n✗ Upgrade failed (exit code ${exitCode})`));
      }
      process.exit(exitCode);
    }

    // Check new version
    const versionProc = Bun.spawnSync(["npm", "view", "@hasna/hooks", "version"]);
    const latest = new TextDecoder().decode(versionProc.stdout).trim() || "unknown";

    if (options.json) {
      console.log(JSON.stringify({ current, latest, updated: true }));
    } else {
      console.log(chalk.green(`\n✓ Upgraded: ${current} → ${latest}`));
    }
  });

// Profile export command
program
  .command("profile-export")
  .description("Export all agent profiles as JSON (for backup/cross-machine setup)")
  .option("-o, --output <file>", "Write to file instead of stdout")
  .option("-j, --json", "Output as JSON (default: true)", false)
  .action(async (options: { output?: string; json: boolean }) => {
    const profiles = exportProfiles();
    const json = JSON.stringify(profiles, null, 2);
    if (options.output) {
      const { writeFileSync } = await import("fs");
      writeFileSync(options.output, json + "\n");
      console.log(chalk.green(`✓ Exported ${profiles.length} profile(s) to ${options.output}`));
    } else {
      console.log(json);
    }
  });

// Profile import command
program
  .command("profile-import")
  .argument("<file>", "JSON file to import profiles from (use - for stdin)")
  .description("Import agent profiles from a JSON export file")
  .option("-j, --json", "Output result as JSON", false)
  .action(async (file: string, options: { json: boolean }) => {
    let raw: string;
    if (file === "-") {
      raw = await new Response(Bun.stdin.stream()).text();
    } else {
      const { readFileSync } = await import("fs");
      try {
        raw = readFileSync(file, "utf-8");
      } catch {
        if (options.json) {
          console.log(JSON.stringify({ error: `Cannot read file: ${file}` }));
        } else {
          console.log(chalk.red(`✗ Cannot read file: ${file}`));
        }
        return;
      }
    }

    let profiles: any[];
    try {
      const parsed = JSON.parse(raw);
      profiles = Array.isArray(parsed) ? parsed : [parsed];
    } catch {
      if (options.json) {
        console.log(JSON.stringify({ error: "Invalid JSON" }));
      } else {
        console.log(chalk.red("✗ Invalid JSON"));
      }
      return;
    }

    const result = importProfiles(profiles);
    if (options.json) {
      console.log(JSON.stringify(result));
    } else {
      console.log(chalk.green(`✓ Imported ${result.imported} profile(s)`));
      if (result.skipped > 0) console.log(chalk.dim(`  Skipped ${result.skipped} (already exist or invalid)`));
    }
  });

// Log command group — query hook events from SQLite
const logCmd = program
  .command("log")
  .description("Query hook event logs from SQLite (~/.hasna/hooks/hooks.db)");

logCmd
  .command("list")
  .description("List hook events")
  .option("--hook <name>", "Filter by hook name")
  .option("--session <id>", "Filter by session ID")
  .option("-n, --limit <n>", "Number of rows to show", "50")
  .option("-j, --json", "Output as JSON", false)
  .action(async (options: { hook?: string; session?: string; limit: string; json: boolean }) => {
    const { getDb } = await import("../db/index.js");
    const db = getDb();
    const limit = parseInt(options.limit) || 50;

    let sql = "SELECT * FROM hook_events WHERE 1=1";
    const params: string[] = [];

    if (options.hook) { sql += " AND hook_name = ?"; params.push(options.hook); }
    if (options.session) { sql += " AND session_id LIKE ?"; params.push(`${options.session}%`); }
    sql += " ORDER BY timestamp DESC LIMIT ?";
    params.push(String(limit));

    const rows = db.query(sql).all(...params) as any[];

    if (options.json) { console.log(JSON.stringify(rows, null, 2)); return; }
    if (rows.length === 0) { console.log(chalk.dim("No events found.")); return; }

    console.log(chalk.bold(`\n  Hook Events (${rows.length})\n`));
    for (const row of rows) {
      const ts = row.timestamp.slice(0, 19).replace("T", " ");
      const err = row.error ? chalk.red(` ERR: ${row.error.slice(0, 60)}`) : "";
      const tool = row.tool_name ? chalk.dim(` [${row.tool_name}]`) : "";
      console.log(`  ${chalk.dim(ts)}  ${chalk.cyan(row.hook_name.padEnd(14))}${tool}${err}`);
    }
    console.log();
  });

logCmd
  .command("search <text>")
  .description("Search hook events by tool_input or error text")
  .option("-n, --limit <n>", "Number of rows to show", "50")
  .option("-j, --json", "Output as JSON", false)
  .action(async (text: string, options: { limit: string; json: boolean }) => {
    const { getDb } = await import("../db/index.js");
    const db = getDb();
    const limit = parseInt(options.limit) || 50;
    const q = `%${text}%`;
    const rows = db.query(
      "SELECT * FROM hook_events WHERE tool_input LIKE ? OR error LIKE ? ORDER BY timestamp DESC LIMIT ?"
    ).all(q, q, limit) as any[];

    if (options.json) { console.log(JSON.stringify(rows, null, 2)); return; }
    if (rows.length === 0) { console.log(chalk.dim(`No events matching "${text}".`)); return; }

    console.log(chalk.bold(`\n  Search results for "${text}" (${rows.length})\n`));
    for (const row of rows) {
      const ts = row.timestamp.slice(0, 19).replace("T", " ");
      const snippet = (row.tool_input || row.error || "").slice(0, 80);
      console.log(`  ${chalk.dim(ts)}  ${chalk.cyan(row.hook_name.padEnd(14))}  ${chalk.dim(snippet)}`);
    }
    console.log();
  });

logCmd
  .command("tail")
  .description("Show most recent hook events")
  .option("-n <n>", "Number of rows", "20")
  .option("-j, --json", "Output as JSON", false)
  .action(async (options: { n: string; json: boolean }) => {
    const { getDb } = await import("../db/index.js");
    const db = getDb();
    const limit = parseInt(options.n) || 20;
    const rows = db.query(
      "SELECT * FROM hook_events ORDER BY timestamp DESC LIMIT ?"
    ).all(limit) as any[];

    if (options.json) { console.log(JSON.stringify(rows, null, 2)); return; }
    if (rows.length === 0) { console.log(chalk.dim("No events yet.")); return; }

    console.log(chalk.bold(`\n  Last ${rows.length} events\n`));
    for (const row of rows) {
      const ts = row.timestamp.slice(0, 19).replace("T", " ");
      const err = row.error ? chalk.red(` ✗ ${row.error.slice(0, 60)}`) : "";
      const tool = row.tool_name ? chalk.dim(` [${row.tool_name}]`) : "";
      console.log(`  ${chalk.dim(ts)}  ${chalk.cyan(row.hook_name.padEnd(14))}${tool}${err}`);
    }
    console.log();
  });

logCmd
  .command("errors")
  .description("Show hook events that contain errors")
  .option("--since <duration>", "Only show errors since this duration (e.g. 1h, 30m, 7d)", "24h")
  .option("-n, --limit <n>", "Number of rows to show", "50")
  .option("-j, --json", "Output as JSON", false)
  .action(async (options: { since: string; limit: string; json: boolean }) => {
    const { getDb } = await import("../db/index.js");
    const db = getDb();
    const limit = parseInt(options.limit) || 50;

    // Parse duration string to milliseconds
    function parseDuration(s: string): number {
      const m = s.match(/^(\d+)(s|m|h|d)$/);
      if (!m) return 24 * 60 * 60 * 1000;
      const n = parseInt(m[1]);
      switch (m[2]) {
        case "s": return n * 1000;
        case "m": return n * 60 * 1000;
        case "h": return n * 60 * 60 * 1000;
        case "d": return n * 24 * 60 * 60 * 1000;
        default: return 24 * 60 * 60 * 1000;
      }
    }

    const since = new Date(Date.now() - parseDuration(options.since)).toISOString();
    const rows = db.query(
      "SELECT * FROM hook_events WHERE error IS NOT NULL AND timestamp >= ? ORDER BY timestamp DESC LIMIT ?"
    ).all(since, limit) as any[];

    if (options.json) { console.log(JSON.stringify(rows, null, 2)); return; }
    if (rows.length === 0) { console.log(chalk.dim(`No errors in the last ${options.since}.`)); return; }

    console.log(chalk.bold(`\n  Errors (last ${options.since}, ${rows.length} found)\n`));
    for (const row of rows) {
      const ts = row.timestamp.slice(0, 19).replace("T", " ");
      console.log(`  ${chalk.dim(ts)}  ${chalk.cyan(row.hook_name.padEnd(14))}  ${chalk.red(row.error.slice(0, 100))}`);
    }
    console.log();
  });

logCmd
  .command("clear")
  .description("Delete hook event logs")
  .option("--hook <name>", "Only delete events for this hook")
  .option("-y, --yes", "Skip confirmation prompt", false)
  .action(async (options: { hook?: string; yes: boolean }) => {
    const { getDb } = await import("../db/index.js");
    const db = getDb();

    const countRow = options.hook
      ? db.query("SELECT COUNT(*) as n FROM hook_events WHERE hook_name = ?").get(options.hook) as any
      : db.query("SELECT COUNT(*) as n FROM hook_events").get() as any;
    const count = countRow?.n ?? 0;

    if (count === 0) { console.log(chalk.dim("Nothing to clear.")); return; }

    if (!options.yes) {
      const scope = options.hook ? `hook "${options.hook}"` : "all hooks";
      console.log(chalk.yellow(`About to delete ${count} event(s) for ${scope}.`));
      console.log(chalk.dim("Re-run with --yes to confirm."));
      return;
    }

    if (options.hook) {
      db.run("DELETE FROM hook_events WHERE hook_name = ?", [options.hook]);
    } else {
      db.run("DELETE FROM hook_events");
    }

    console.log(chalk.green(`✓ Cleared ${count} event(s).`));
  });

// MCP server command
program
  .command("mcp")
  .option("-s, --stdio", "Use stdio transport (for agent MCP integration)", false)
  .option("-p, --port <port>", "Port for SSE transport", "39427")
  .description("Start MCP server for AI agent integration")
  .action(async (options: { stdio: boolean; port: string }) => {
    if (options.stdio) {
      const { startStdioServer } = await import("../mcp/server.js");
      await startStdioServer();
    } else {
      const { startSSEServer } = await import("../mcp/server.js");
      await startSSEServer(parseInt(options.port));
    }
  });

program.parse();
