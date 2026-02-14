#!/usr/bin/env bun
/**
 * Uninstall hook-agentmessages from Claude Code settings
 */

import { homedir } from 'os';
import { join } from 'path';

const CLAUDE_SETTINGS_FILE = join(homedir(), '.claude', 'settings.json');

interface HookConfig {
  type: 'command';
  command: string;
}

interface HookMatcher {
  matcher?: string;
  hooks: HookConfig[];
}

interface Settings {
  hooks?: {
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
  await Bun.write(CLAUDE_SETTINGS_FILE, JSON.stringify(settings, null, 2));
}

function removeHookMessageHooks(hooks: HookMatcher[]): HookMatcher[] {
  return hooks.filter(h =>
    !h.hooks.some(hook => hook.command.includes('hook-agentmessages'))
  );
}

async function main() {
  console.log('Uninstalling hook-agentmessages from Claude Code...\n');

  const settings = await readSettings();

  if (!settings.hooks) {
    console.log('No hooks found. Nothing to uninstall.');
    return;
  }

  let removed = 0;

  // Remove from all hook events
  for (const eventName of Object.keys(settings.hooks)) {
    const hooks = settings.hooks[eventName];
    if (hooks && Array.isArray(hooks)) {
      const before = hooks.length;
      settings.hooks[eventName] = removeHookMessageHooks(hooks);
      removed += before - settings.hooks[eventName]!.length;

      // Remove empty arrays
      if (settings.hooks[eventName]!.length === 0) {
        delete settings.hooks[eventName];
      }
    }
  }

  // Remove empty hooks object
  if (Object.keys(settings.hooks).length === 0) {
    delete settings.hooks;
  }

  await writeSettings(settings);

  console.log(`Removed ${removed} hook(s).`);
  console.log('\nRestart Claude Code for changes to take effect.');
}

main().catch((err) => {
  console.error('Uninstall failed:', err.message);
  process.exit(1);
});
