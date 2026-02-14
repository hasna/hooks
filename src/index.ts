/**
 * @hasna/hooks - Open source Claude Code hooks library
 *
 * Install hooks with a single command:
 *   npx @hasna/hooks install gitguard branchprotect
 *
 * Or use the interactive CLI:
 *   npx @hasna/hooks
 */

export {
  HOOKS,
  CATEGORIES,
  getHook,
  getHooksByCategory,
  searchHooks,
  type HookMeta,
  type Category,
} from "./lib/registry.js";

export {
  installHook,
  installHooks,
  getInstalledHooks,
  getRegisteredHooks,
  removeHook,
  hookExists,
  getHookPath,
  getSettingsPath,
  type InstallResult,
  type InstallOptions,
  type Scope,
} from "./lib/installer.js";
