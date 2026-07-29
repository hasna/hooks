import type { Command } from "commander";
import chalk from "chalk";
import { truncateText } from "./helpers.js";

export function registerLogCommands(program: Command): void {
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
      const err = row.error ? chalk.red(` ERR: ${truncateText(row.error, 60)}`) : "";
      const tool = row.tool_name ? chalk.dim(` [${row.tool_name}]`) : "";
      console.log(`  ${chalk.dim(ts)}  ${chalk.cyan(row.hook_name.padEnd(14))}${tool}${err}`);
    }
    console.log(chalk.dim("\n  Compact rows shown. Use --json for full event records or --limit <n> to change row count."));
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
      const snippet = truncateText(row.tool_input || row.error || "", 80);
      console.log(`  ${chalk.dim(ts)}  ${chalk.cyan(row.hook_name.padEnd(14))}  ${chalk.dim(snippet)}`);
    }
    console.log(chalk.dim("\n  Compact rows shown. Use --json for full event records or --limit <n> to change row count."));
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
      const err = row.error ? chalk.red(` ✗ ${truncateText(row.error, 60)}`) : "";
      const tool = row.tool_name ? chalk.dim(` [${row.tool_name}]`) : "";
      console.log(`  ${chalk.dim(ts)}  ${chalk.cyan(row.hook_name.padEnd(14))}${tool}${err}`);
    }
    console.log(chalk.dim("\n  Compact rows shown. Use --json for full event records or -n <n> to change row count."));
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
      console.log(`  ${chalk.dim(ts)}  ${chalk.cyan(row.hook_name.padEnd(14))}  ${chalk.red(truncateText(row.error, 100))}`);
    }
    console.log(chalk.dim("\n  Compact rows shown. Use --json for full event records or --limit <n> to change row count."));
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

}
