import type { Command } from "commander";
import { render } from "ink";
import chalk from "chalk";
import { existsSync, readFileSync } from "fs";
import { join } from "path";
import { App } from "../components/App.js";
import {
  HOOKS,
  CATEGORIES,
  getHooksByCategory,
  searchHooks,
  getHook,
} from "../../lib/registry.js";
import {
  installHook,
  getInstalledHooks,
  getRegisteredHooks,
  getRegisteredHooksForTarget,
  removeHook,
  hookExists,
  getHookPath,
  getSettingsPath,
} from "../../lib/installer.js";
import { createProfile, getProfile, touchProfile } from "../../lib/profiles.js";
import {
  hookSummaryLine,
  parseLimit,
  printDisclosureHint,
  resolveScope,
  resolveTarget,
  suggestHooks,
} from "./helpers.js";

export function registerCoreCommands(program: Command): void {
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
  .option("-t, --target <target>", "Agent target: claude, gemini, codewith, all (default: claude)", "claude")
  .option("--profile <id>", "Agent profile ID to scope hooks to")
  .option("--dry-run", "Preview what would be installed without writing to settings", false)
  .option("--apply-codewith", "Explicitly append Codewith TOML to a config file (prefer open-configs for managed configs)", false)
  .option("--codewith-config <path>", "Explicit Codewith config path required with --apply-codewith")
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

    if (options.applyCodewith && (target === "codewith" || target === "all") && !options.codewithConfig) {
      const message = "--apply-codewith requires --codewith-config <path>; refusing to write default ~/.codewith/config.toml.";
      if (options.json) {
        console.log(JSON.stringify({ error: message, scope, target, applied: false }));
      } else {
        console.log(chalk.red(message));
      }
      return;
    }

    // Dry-run: preview what would be installed
    if (options.dryRun) {
      const known = toInstall.filter((n) => getHook(n));
      const unknown = toInstall.filter((n) => !getHook(n));
      if (options.json) {
        console.log(JSON.stringify({ dryRun: true, would_install: known, unknown, scope, target, mode: target === "codewith" ? "fragment" : "write" }));
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
      const result = installHook(name, {
        scope,
        overwrite: options.overwrite,
        target,
        profile: options.profile,
        codewithMode: options.applyCodewith ? "write" : "fragment",
        codewithConfigPath: options.codewithConfig,
      });
      results.push(result);
    }

    if (options.json) {
      console.log(JSON.stringify({
        installed: results.filter((r) => r.success).map((r) => r.hook),
        failed: results.filter((r) => !r.success).map((r) => ({ hook: r.hook, error: r.error })),
        fragments: results.filter((r) => r.success && r.fragment).map((r) => ({ hook: r.hook, fragment: r.fragment, applied: r.applied, configPath: r.configPath, note: r.note })),
        total: results.length,
        success: results.filter((r) => r.success).length,
        scope,
        target,
        applied: results.some((r) => r.applied),
      }));
      return;
    }

    const settingsFile = target === "codewith"
      ? (options.applyCodewith ? options.codewithConfig : "TOML fragment only (open-configs should apply)")
      : scope === "project" ? ".claude/settings.json" : "~/.claude/settings.json";
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
        if (result.fragment && target === "codewith") {
          console.log(chalk.dim("  Codewith TOML fragment:"));
          console.log(chalk.cyan(result.fragment.trimEnd().split("\n").map((line) => `    ${line}`).join("\n")));
          if (result.note) console.log(chalk.yellow(`  ⚠ ${result.note}`));
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
  .option("-t, --target <target>", "Agent target: claude, gemini, codewith (default: claude)", "claude")
  .option("-n, --limit <n>", "Max rows to show in compact output", "20")
  .option("--verbose", "Show descriptions and full detail columns", false)
  .option("-j, --json", "Output as JSON", false)
  .description("List available or installed hooks")
  .action((options) => {
    const scope = resolveScope(options);
    const limit = options.all ? Number.MAX_SAFE_INTEGER : parseLimit(options.limit, 20, 200);

    if (options.registered || options.installed) {
      const target = (options.target === "gemini" ? "gemini" : options.target === "codewith" ? "codewith" : "claude") as "claude" | "gemini" | "codewith";
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
      const visible = registered.slice(0, limit);
      console.log(chalk.bold(`\nRegistered hooks — ${scope}/${target} (${registered.length}, showing ${visible.length}):\n`));
      for (const name of visible) {
        const meta = getHook(name);
        if (meta) console.log(hookSummaryLine(meta, { verbose: options.verbose }));
        else console.log(`  ${chalk.cyan(name)} ${chalk.dim("[unknown]")}`);
      }
      printDisclosureHint(registered.length - visible.length, "hooks info <name>", { includeAll: true });
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
      const visible = hooks.slice(0, limit);
      console.log(chalk.bold(`\n${category} (${hooks.length}, showing ${visible.length}):\n`));
      for (const h of visible) console.log(hookSummaryLine(h, { verbose: options.verbose }));
      printDisclosureHint(hooks.length - visible.length, "hooks info <name>", { includeAll: true });
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

    const visible = HOOKS.slice(0, limit);
    console.log(chalk.bold(`\nAvailable hooks (${HOOKS.length}, showing ${visible.length}):\n`));
    for (const h of visible) console.log(hookSummaryLine(h, { verbose: options.verbose }));
    printDisclosureHint(HOOKS.length - visible.length, "hooks info <name>", { includeAll: true });
  });

// Search command
program
  .command("search")
  .argument("<query>", "Search term")
  .option("-n, --limit <n>", "Max rows to show in compact output", "10")
  .option("--verbose", "Show descriptions for search results", false)
  .option("-j, --json", "Output as JSON", false)
  .description("Search for hooks")
  .action((query: string, options: { limit: string; verbose: boolean; json: boolean }) => {
    const results = searchHooks(query);
    if (options.json) {
      console.log(JSON.stringify(results));
      return;
    }
    if (results.length === 0) {
      console.log(chalk.dim(`No hooks found for "${query}"`));
      return;
    }
    const limit = parseLimit(options.limit, 10, 100);
    const visible = results.slice(0, limit);
    console.log(chalk.bold(`\nFound ${results.length} hook(s), showing ${visible.length}:\n`));
    for (const h of visible) console.log(hookSummaryLine(h, { verbose: options.verbose }));
    printDisclosureHint(results.length - visible.length, "hooks info <name>");
  });

// Remove command
program
  .command("remove")
  .alias("rm")
  .argument("<hook>", "Hook to remove")
  .option("-g, --global", "Remove from global settings", false)
  .option("-p, --project", "Remove from project settings", false)
  .option("-t, --target <target>", "Agent target: claude, gemini, codewith, all (default: claude)", "claude")
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
              const match = h.command?.match(/^hooks run ([\w-]+)/);
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
}
