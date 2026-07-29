export type { CodewithHookInput, CodewithHookOutput, CommandResult } from "./codewith-native-common/base";
export {
  readInput,
  respond,
  warn,
  cap,
  commandExists,
  runCommand,
  getCommand,
  isBashPreToolUse,
  cacheDir,
  cachePath,
  readCache,
  writeCache,
  safeJsonSummary,
  getAgentName,
  isTopLevelSession,
} from "./codewith-native-common/base";

export type { GitCommandInfo } from "./codewith-native-common/git-command";
export {
  gitCommandInfo,
  isGitCommitOrPush,
  isGitPushOrCommitCommand,
  isRiskyOperation,
} from "./codewith-native-common/git-command";

export type { DangerousOperationMatch } from "./codewith-native-common/protected-paths";
export {
  SYSTEM_PROTECTED_ROOTS,
  globComponentMatches,
} from "./codewith-native-common/protected-paths";
export { emptyExpansionCollapse } from "./codewith-native-common/shell-expansions";
export { classifyDangerousOperation } from "./codewith-native-common/dangerous-operation";

export type {
  ManagedWorktreeLayout,
  ManagedWorktreeInfo,
  CanonicalRepoIdentity,
} from "./codewith-native-common/worktrees";
export {
  defaultWorktreesRoot,
  isInsidePath,
  CANONICAL_WORKTREE_SEGMENTS,
  LEGACY_LEASE_WORKTREE_SEGMENTS,
  legacyWorktreeToleranceEnabled,
  canonicalWorktreeTemplate,
  managedWorktreeInfo,
  gitRepoRoot,
  gitRemoteSlug,
  gitRemoteHostSlug,
  canonicalRepoIdentity,
  claimCommand,
  taskIdFrom,
  runIdFrom,
  redactGitleaksOutput,
} from "./codewith-native-common/worktrees";
