#!/usr/bin/env bun
/**
 * Install hook-agentmessages into Claude Code settings
 *
 * Adds hooks to ~/.claude/settings.json:
 * - SessionStart: Auto-register agent, project, session
 * - Stop: Check for unread messages
 */

import { homedir } from 'os';
import { join } from 'path';

const CLAUDE_SETTINGS_DIR = join(homedir(), '.claude');
const CLAUDE_SETTINGS_FILE = join(CLAUDE_SETTINGS_DIR, 'settings.json');
const HOOK_DIR = import.meta.dir.replace('/src', '');

interface HookConfig {
  type: 'command';
  command: string;
  timeout?: number;
}

interface HookMatcher {
  matcher?: string;
  hooks: HookConfig[];
}

interface Settings {
  hooks?: {
    SessionStart?: HookMatcher[];
    Stop?: HookMatcher[];
    [key: string]: HookMatcher[] | undefined;
  };
  [key: string]: unknown;
}

async function readSettings(): Promise<Settings> {
  try {
    const file = Bun.file(CLAUDE_SETTINGS_FILE);
    if (await file.exists()) {
      return await file.json();
    }
  } catch {}
  return {};
}

async function writeSettings(settings: Settings): Promise<void> {
  // Ensure .claude directory exists
  await Bun.write(join(CLAUDE_SETTINGS_DIR, '.gitkeep'), '');
  await Bun.write(CLAUDE_SETTINGS_FILE, JSON.stringify(settings, null, 2));
}

function findHookIndex(hooks: HookMatcher[], command: string): number {
  return hooks.findIndex(h =>
    h.hooks.some(hook => hook.command.includes('hook-agentmessages'))
  );
}

async function main() {
  console.log('Installing hook-agentmessages into Claude Code...\n');

  const settings = await readSettings();

  // Initialize hooks object if not exists
  if (!settings.hooks) {
    settings.hooks = {};
  }

  // SessionStart hook
  const sessionStartHook: HookMatcher = {
    hooks: [
      {
        type: 'command',
        command: `bun ${join(HOOK_DIR, 'src/session-start.ts')}`,
        timeout: 10,
      },
    ],
  };

  if (!settings.hooks.SessionStart) {
    settings.hooks.SessionStart = [];
  }

  // Remove existing hook-agentmessages hooks
  const existingSessionStartIdx = findHookIndex(settings.hooks.SessionStart, 'hook-agentmessages');
  if (existingSessionStartIdx >= 0) {
    settings.hooks.SessionStart.splice(existingSessionStartIdx, 1);
  }
  settings.hooks.SessionStart.push(sessionStartHook);

  // Stop hook (check messages after each response)
  const stopHook: HookMatcher = {
    hooks: [
      {
        type: 'command',
        command: `bun ${join(HOOK_DIR, 'src/check-messages.ts')}`,
        timeout: 5,
      },
    ],
  };

  if (!settings.hooks.Stop) {
    settings.hooks.Stop = [];
  }

  const existingStopIdx = findHookIndex(settings.hooks.Stop, 'hook-agentmessages');
  if (existingStopIdx >= 0) {
    settings.hooks.Stop.splice(existingStopIdx, 1);
  }
  settings.hooks.Stop.push(stopHook);

  // Write updated settings
  await writeSettings(settings);

  console.log('Hooks installed successfully!\n');
  console.log('Installed hooks:');
  console.log('  - SessionStart: Auto-registers agent, project, and session');
  console.log('  - Stop: Checks for unread messages after each response\n');
  console.log(`Settings file: ${CLAUDE_SETTINGS_FILE}`);
  console.log('\nRestart Claude Code for hooks to take effect.');
}

main().catch((err) => {
  console.error('Installation failed:', err.message);
  process.exit(1);
});
