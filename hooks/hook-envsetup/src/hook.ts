#!/usr/bin/env bun

/**
 * Claude Code Hook: envsetup
 *
 * PreToolUse hook that checks if the environment might need activation
 * before running commands. Since PreToolUse cannot modify commands,
 * this hook logs warnings to stderr when it detects that:
 *
 * - .nvmrc or .node-version exists and command uses node/npm
 * - .python-version or Pipfile exists and command uses python/pip
 * - .tool-versions (asdf) exists
 * - .venv directory exists but command doesn't activate it
 *
 * Always approves — this is advisory only.
 */

import { readFileSync, existsSync } from "fs";
import { join } from "path";

interface HookInput {
  session_id: string;
  cwd: string;
  tool_name: string;
  tool_input: Record<string, unknown>;
}

interface HookOutput {
  decision: "approve";
}

interface EnvCheck {
  name: string;
  files: string[];
  commandPatterns: RegExp[];
  warning: string;
  activationHint: string;
}

function readStdinJson(): HookInput | null {
  try {
    const input = readFileSync(0, "utf-8").trim();
    if (!input) return null;
    return JSON.parse(input);
  } catch {
    return null;
  }
}

function respond(output: HookOutput): void {
  console.log(JSON.stringify(output));
}

const ENV_CHECKS: EnvCheck[] = [
  {
    name: "Node.js (nvm)",
    files: [".nvmrc", ".node-version"],
    commandPatterns: [
      /\bnode\s/,
      /\bnpm\s/,
      /\bnpx\s/,
      /\byarn\s/,
      /\bpnpm\s/,
    ],
    warning: "Project has .nvmrc/.node-version but nvm may not be activated",
    activationHint: "source ~/.nvm/nvm.sh && nvm use",
  },
  {
    name: "Python (venv)",
    files: [".python-version", "Pipfile", "requirements.txt"],
    commandPatterns: [
      /\bpython\b/,
      /\bpython3\b/,
      /\bpip\b/,
      /\bpip3\b/,
      /\bpipenv\b/,
    ],
    warning: "Project has Python config but virtualenv may not be activated",
    activationHint: "source .venv/bin/activate",
  },
  {
    name: "asdf",
    files: [".tool-versions"],
    commandPatterns: [
      /\bnode\s/,
      /\bnpm\s/,
      /\bpython\b/,
      /\bruby\b/,
      /\belixir\b/,
      /\berlang\b/,
      /\bjava\b/,
      /\bgo\s/,
    ],
    warning: "Project has .tool-versions but asdf may not be sourced",
    activationHint: "source ~/.asdf/asdf.sh",
  },
  {
    name: "Python (Poetry)",
    files: ["poetry.lock"],
    commandPatterns: [
      /\bpython\b/,
      /\bpython3\b/,
      /\bpip\b/,
      /\bpoetry\b/,
    ],
    warning: "Project uses Poetry but virtualenv may not be activated",
    activationHint: "poetry shell",
  },
  {
    name: "Ruby (rbenv)",
    files: [".ruby-version"],
    commandPatterns: [
      /\bruby\b/,
      /\bgem\b/,
      /\bbundle\b/,
      /\brails\b/,
      /\brake\b/,
    ],
    warning: "Project has .ruby-version but rbenv may not be initialized",
    activationHint: "eval \"$(rbenv init -)\"",
  },
];

function checkEnvironment(cwd: string, command: string): void {
  for (const check of ENV_CHECKS) {
    // Check if any of the config files exist
    const hasConfigFile = check.files.some((file) => existsSync(join(cwd, file)));
    if (!hasConfigFile) continue;

    // Check if the command matches any of the patterns
    const matchesCommand = check.commandPatterns.some((pattern) => pattern.test(command));
    if (!matchesCommand) continue;

    // Check if the command already includes the activation
    if (command.includes("nvm use") || command.includes("nvm.sh")) continue;
    if (command.includes(".venv/bin/activate") || command.includes("venv/bin/activate")) continue;
    if (command.includes("asdf.sh")) continue;
    if (command.includes("poetry shell") || command.includes("poetry run")) continue;
    if (command.includes("rbenv init")) continue;

    // For Python: check if .venv exists (if not, no point warning)
    if (check.name === "Python (venv)") {
      const hasVenv = existsSync(join(cwd, ".venv")) || existsSync(join(cwd, "venv"));
      if (!hasVenv) {
        // Check if VIRTUAL_ENV is set
        if (!process.env.VIRTUAL_ENV) {
          console.error(`[hook-envsetup] Warning: ${check.warning} (no .venv directory found, consider creating one)`);
        }
        continue;
      }
      // Check if already in a venv
      if (process.env.VIRTUAL_ENV) continue;
    }

    // For nvm: check if NVM_DIR is set
    if (check.name === "Node.js (nvm)") {
      if (!process.env.NVM_DIR) {
        console.error(`[hook-envsetup] Warning: ${check.warning} (NVM_DIR not set)`);
        console.error(`[hook-envsetup] Hint: ${check.activationHint}`);
        continue;
      }
    }

    console.error(`[hook-envsetup] Warning: ${check.warning}`);
    console.error(`[hook-envsetup] Hint: ${check.activationHint}`);
  }
}

export function run(): void {
  const input = readStdinJson();

  if (!input) {
    respond({ decision: "approve" });
    return;
  }

  if (input.tool_name !== "Bash") {
    respond({ decision: "approve" });
    return;
  }

  const command = input.tool_input?.command as string;
  if (!command || typeof command !== "string") {
    respond({ decision: "approve" });
    return;
  }

  const cwd = input.cwd || process.cwd();
  checkEnvironment(cwd, command);

  // Always approve — this hook is advisory only
  respond({ decision: "approve" });
}

if (import.meta.main) {
  run();
}
