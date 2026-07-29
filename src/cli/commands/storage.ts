import type { Command } from "commander";
import chalk from "chalk";

export function registerStorageCommands(program: Command): void {
const storageCmd = program
  .command("storage")
  .description("Sync local hook data with storage PostgreSQL");

storageCmd
  .command("status")
  .description("Show storage sync status")
  .option("-j, --json", "Output as JSON", false)
  .action(async (options: { json: boolean }) => {
    const { getStorageStatus } = await import("../storage.js");
    const status = getStorageStatus();
    if (options.json) {
      console.log(JSON.stringify(status, null, 2));
      return;
    }
    console.log(chalk.bold("\n  Storage Status\n"));
    console.log(`  Configured: ${status.configured ? chalk.green(`yes (${status.activeEnv})`) : chalk.red("no")}`);
    console.log(`  Mode:       ${status.mode}`);
    console.log(`  Tables:     ${status.tables.join(", ")}`);
    console.log(`  Sync rows:  ${status.sync.length}`);
  });

storageCmd
  .command("push")
  .description("Push local hook data to storage PostgreSQL")
  .option("-t, --tables <tables>", "Comma-separated table names")
  .option("-j, --json", "Output as JSON", false)
  .action(async (options: { tables?: string; json: boolean }) => {
    try {
      const { parseStorageTables, storagePush } = await import("../storage.js");
      const results = await storagePush({ tables: parseStorageTables(options.tables) });
      if (options.json) {
        console.log(JSON.stringify(results, null, 2));
        return;
      }
      const written = results.reduce((sum, result) => sum + result.rowsWritten, 0);
      console.log(chalk.green(`✓ Pushed ${written} row(s)`));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (options.json) console.log(JSON.stringify({ error: message }));
      else console.error(chalk.red(`✗ ${message}`));
      process.exitCode = 1;
    }
  });

storageCmd
  .command("pull")
  .description("Pull hook data from storage PostgreSQL to local SQLite")
  .option("-t, --tables <tables>", "Comma-separated table names")
  .option("-j, --json", "Output as JSON", false)
  .action(async (options: { tables?: string; json: boolean }) => {
    try {
      const { parseStorageTables, storagePull } = await import("../storage.js");
      const results = await storagePull({ tables: parseStorageTables(options.tables) });
      if (options.json) {
        console.log(JSON.stringify(results, null, 2));
        return;
      }
      const written = results.reduce((sum, result) => sum + result.rowsWritten, 0);
      console.log(chalk.green(`✓ Pulled ${written} row(s)`));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (options.json) console.log(JSON.stringify({ error: message }));
      else console.error(chalk.red(`✗ ${message}`));
      process.exitCode = 1;
    }
  });

storageCmd
  .command("sync")
  .description("Bidirectional storage sync: pull then push")
  .option("-t, --tables <tables>", "Comma-separated table names")
  .option("-j, --json", "Output as JSON", false)
  .action(async (options: { tables?: string; json: boolean }) => {
    try {
      const { parseStorageTables, storageSync } = await import("../storage.js");
      const result = await storageSync({ tables: parseStorageTables(options.tables) });
      if (options.json) {
        console.log(JSON.stringify(result, null, 2));
        return;
      }
      const pulled = result.pull.reduce((sum, entry) => sum + entry.rowsWritten, 0);
      const pushed = result.push.reduce((sum, entry) => sum + entry.rowsWritten, 0);
      console.log(chalk.green(`✓ Synced ${pulled} pulled row(s), ${pushed} pushed row(s)`));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (options.json) console.log(JSON.stringify({ error: message }));
      else console.error(chalk.red(`✗ ${message}`));
      process.exitCode = 1;
    }
  });

// MCP server command
}
