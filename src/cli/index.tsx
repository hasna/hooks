#!/usr/bin/env bun
import { registerEventsCommands } from "@hasna/events/commander";
import { Command } from "commander";
import { existsSync, readFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import { registerCoreCommands } from "./commands/core.js";
import { registerDocsCommands } from "./commands/docs.js";
import { registerLogCommands } from "./commands/log.js";
import { registerMcpCommand } from "./commands/mcp.js";
import { registerStorageCommands } from "./commands/storage.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkgPath = existsSync(join(__dirname, "..", "package.json"))
  ? join(__dirname, "..", "package.json")
  : join(__dirname, "..", "..", "package.json");
const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));

const program = new Command();
program
  .name("hooks")
  .description("Install hooks for AI coding agents")
  .version(pkg.version);

registerCoreCommands(program);
registerDocsCommands(program, pkg.version);
registerLogCommands(program);
registerStorageCommands(program);
registerMcpCommand(program);
registerEventsCommands(program, { source: "hooks" });

program.parse();
