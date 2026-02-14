#!/usr/bin/env bun
import React from "react";
import { render } from "ink";
import { Command } from "commander";
import chalk from "chalk";
import { existsSync, readFileSync } from "fs";
import { join } from "path";
import { homedir } from "os";
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
  removeHook,
  hookExists,
  getHookPath,
  getSettingsPath,
  type Scope,
} from "../lib/installer.js";

const program = new Command();

function resolveScope(options: { global?: boolean; project?: boolean }): Scope {
  if (options.project) return "project";
  return "global";
}

program
  .name("hooks")
  .description("Install Claude Code hooks for your project")
  .version("0.1.0");

// Interactive mode (default)
program
  .command("interactive", { isDefault: true })
  .alias("i")
  .description("Interactive hook browser")
  .action(() => {
    render(<App />);
  });

// Run command — executes a hook, called by Claude Code via settings.json
program
  .command("run")
  .argument("<hook>", "Hook to run")
  .description("Execute a hook (called by Claude Code)")
  .action(async (hook: string) => {
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

    // Read stdin (Claude Code passes hook context as JSON)
    const stdin = await new Response(Bun.stdin.stream()).text();

    // Execute the hook script with bun, passing stdin through
    const proc = Bun.spawn(["bun", "run", hookScript], {
      stdin: new Response(stdin),
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
  .option("-j, --json", "Output as JSON", false)
  .description("Install one or more hooks")
  .action((hooks: string[], options) => {
    const scope = resolveScope(options);
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

    const results = [];
    for (const name of toInstall) {
      const result = installHook(name, { scope, overwrite: options.overwrite });
      results.push(result);
    }

    if (options.json) {
      console.log(JSON.stringify({
        installed: results.filter((r) => r.success).map((r) => r.hook),
        failed: results.filter((r) => !r.success).map((r) => ({ hook: r.hook, error: r.error })),
        total: results.length,
        success: results.filter((r) => r.success).length,
        scope,
      }));
      return;
    }

    const settingsFile = scope === "project" ? ".claude/settings.json" : "~/.claude/settings.json";
    console.log(chalk.bold(`\nInstalling hooks (${scope})...\n`));
    for (const result of results) {
      if (result.success) {
        const meta = getHook(result.hook);
        console.log(chalk.green(`✓ ${result.hook}`));
        if (meta) {
          console.log(
            chalk.dim(`  ${meta.event}${meta.matcher ? ` [${meta.matcher}]` : ""} → hooks run ${result.hook}`)
          );
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
  .option("-r, --registered", "Show hooks registered in Claude settings", false)
  .option("-g, --global", "Check global settings", false)
  .option("-p, --project", "Check project settings", false)
  .option("-j, --json", "Output as JSON", false)
  .description("List available or installed hooks")
  .action((options) => {
    const scope = resolveScope(options);

    if (options.registered || options.installed) {
      const registered = getRegisteredHooks(scope);
      if (options.json) {
        console.log(JSON.stringify(registered.map((name) => {
          const meta = getHook(name);
          return { name, event: meta?.event, version: meta?.version, description: meta?.description, scope };
        })));
        return;
      }
      if (registered.length === 0) {
        console.log(chalk.dim(`No hooks registered (${scope})`));
        return;
      }
      console.log(chalk.bold(`\nRegistered hooks — ${scope} (${registered.length}):\n`));
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
  .option("-j, --json", "Output as JSON", false)
  .description("Remove an installed hook")
  .action((hook: string, options: { global?: boolean; project?: boolean; json: boolean }) => {
    const scope = resolveScope(options);
    const removed = removeHook(hook, scope);
    if (options.json) {
      console.log(JSON.stringify({ hook, removed, scope }));
      return;
    }
    if (removed) {
      console.log(chalk.green(`✓ Removed ${hook} (${scope})`));
    } else {
      console.log(chalk.red(`✗ ${hook} is not installed (${scope})`));
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
      if (options.json) {
        console.log(JSON.stringify({ error: `Hook '${hook}' not found` }));
      } else {
        console.log(chalk.red(`Hook '${hook}' not found`));
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
            entry.hooks?.some((h: any) => h.command === `hooks run ${name}`)
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
      console.log(JSON.stringify({ healthy, issues, registered, scope }));
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
      overview: "Claude Code hooks are scripts that run at specific points in a Claude Code session. Install @hasna/hooks globally, then register hooks — no files are copied to your project.",
      events: {
        PreToolUse: "Fires before a tool executes. Can block the operation by returning { \"decision\": \"block\" }.",
        PostToolUse: "Fires after a tool executes. Runs asynchronously, cannot block.",
        Stop: "Fires when a Claude Code session ends. Useful for notifications and cleanup.",
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
        execution: "Claude Code runs 'hooks run gitguard' → executes hook from global package",
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

// MCP server command
program
  .command("mcp")
  .option("-s, --stdio", "Use stdio transport (for Claude Code integration)", false)
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
