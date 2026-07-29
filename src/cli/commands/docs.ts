import type { Command } from "commander";
import chalk from "chalk";
import { existsSync, readFileSync } from "fs";
import { join } from "path";
import { getHook } from "../../lib/registry.js";
import { getHookPath } from "../../lib/installer.js";
import { exportProfiles, importProfiles } from "../../lib/profiles.js";
import { readmePreview } from "./helpers.js";

export function registerDocsCommands(program: Command, version: string): void {
program
  .command("docs")
  .argument("[hook]", "Hook name (shows general docs if omitted)")
  .option("--verbose", "Print full hook README content", false)
  .option("-j, --json", "Output as JSON", false)
  .description("Show documentation for hooks")
  .action((hook: string | undefined, options: { verbose: boolean; json: boolean }) => {
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

      if (readme && options.verbose) {
        console.log(chalk.bold("  README:\n"));
        for (const line of readme.split("\n")) {
          console.log(`    ${line}`);
        }
      } else if (readme) {
        const preview = readmePreview(readme);
        if (preview) {
          console.log(chalk.bold("  README Preview:\n"));
          console.log(`    ${preview}\n`);
        }
        console.log(chalk.dim(`  README has ${readme.split("\n").length} lines. Use hooks docs ${meta.name} --verbose for the full README, or --json for machine-readable output.`));
      }
      return;
    }

    // General docs
    const generalDocs = {
      overview: "Hooks are scripts that run at specific points in an AI coding agent session. Install @hasna/hooks globally, then register hooks — no files are copied to your project.",
      events: {
        SessionStart: "Fires when a session starts or resumes. Codewith can inject context via hookSpecificOutput.additionalContext.",
        UserPromptSubmit: "Codewith-native event when a user prompt is submitted; can block obvious injection attempts.",
        PreToolUse: "Fires before a tool executes. Can block the operation by returning { \"decision\": \"block\" }.",
        PostToolUse: "Fires after a tool executes. Runs asynchronously, cannot block.",
        Stop: "Fires at turn end in Codewith and when other agents finish responding. Useful for notifications and cleanup.",
        Notification: "Fires on notification events like context compaction.",
        SessionEnd: "Fires when a session terminates. Useful for cleanup and final announcements.",
      },
      installation: {
        global: "hooks install gitguard",
        project: "hooks install gitguard --project",
        codewith: "hooks install session-start --target codewith  # emits TOML for open-configs to apply",
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
        register: "hooks install gitguard → writes to ~/.claude/settings.json; hooks install session-start --target codewith emits a TOML fragment",
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
    console.log(`    hooks docs <name>              Compact hook docs`);
    console.log(`    hooks docs <name> --verbose    Full hook README`);
    console.log(`    hooks docs --json              Machine-readable documentation`);
    console.log();
  });

// Upgrade command — self-update the @hasna/hooks package
program
  .command("upgrade")
  .option("-c, --check", "Check for updates without installing", false)
  .option("-j, --json", "Output as JSON", false)
  .description("Update the @hasna/hooks package to the latest version")
  .action(async (options: { check: boolean; json: boolean }) => {
    const current = version;

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
}
