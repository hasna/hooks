/**
 * Hook registry - metadata about all available hooks
 */

export interface HookMeta {
  name: string;
  displayName: string;
  description: string;
  version: string;
  category: string;
  event: "PreToolUse" | "PostToolUse" | "Stop" | "Notification";
  matcher: string;
  tags: string[];
}

export const CATEGORIES = [
  "Git Safety",
  "Code Quality",
  "Security",
  "Notifications",
  "Context Management",
] as const;

export type Category = (typeof CATEGORIES)[number];

export const HOOKS: HookMeta[] = [
  // Git Safety
  {
    name: "gitguard",
    displayName: "Git Guard",
    description: "Blocks destructive git operations like reset --hard, push --force, clean -f",
    version: "0.1.0",
    category: "Git Safety",
    event: "PreToolUse",
    matcher: "Bash",
    tags: ["git", "safety", "destructive", "guard"],
  },
  {
    name: "branchprotect",
    displayName: "Branch Protect",
    description: "Prevents editing files directly on main/master branch",
    version: "0.1.0",
    category: "Git Safety",
    event: "PreToolUse",
    matcher: "Write|Edit|NotebookEdit",
    tags: ["git", "branch", "protection", "main"],
  },
  {
    name: "checkpoint",
    displayName: "Checkpoint",
    description: "Creates shadow git snapshots before file modifications for easy rollback",
    version: "0.1.0",
    category: "Git Safety",
    event: "PreToolUse",
    matcher: "Write|Edit|NotebookEdit",
    tags: ["git", "snapshot", "rollback", "backup"],
  },

  // Code Quality
  {
    name: "checktests",
    displayName: "Check Tests",
    description: "Checks for missing tests after file edits",
    version: "0.1.6",
    category: "Code Quality",
    event: "PostToolUse",
    matcher: "Edit|Write|NotebookEdit",
    tags: ["tests", "coverage", "quality"],
  },
  {
    name: "checklint",
    displayName: "Check Lint",
    description: "Runs linting after file edits and creates tasks for errors",
    version: "0.1.7",
    category: "Code Quality",
    event: "PostToolUse",
    matcher: "Edit|Write|NotebookEdit",
    tags: ["lint", "style", "quality"],
  },
  {
    name: "checkfiles",
    displayName: "Check Files",
    description: "Runs headless agent to review files and create tasks",
    version: "0.1.4",
    category: "Code Quality",
    event: "PostToolUse",
    matcher: "Edit|Write|NotebookEdit",
    tags: ["review", "files", "quality"],
  },
  {
    name: "checkbugs",
    displayName: "Check Bugs",
    description: "Checks for bugs via Codex headless agent",
    version: "0.1.6",
    category: "Code Quality",
    event: "PostToolUse",
    matcher: "Edit|Write|NotebookEdit",
    tags: ["bugs", "analysis", "quality"],
  },
  {
    name: "checkdocs",
    displayName: "Check Docs",
    description: "Checks for missing documentation and creates tasks",
    version: "0.2.1",
    category: "Code Quality",
    event: "PostToolUse",
    matcher: "Edit|Write|NotebookEdit",
    tags: ["docs", "documentation", "quality"],
  },
  {
    name: "checktasks",
    displayName: "Check Tasks",
    description: "Validates task completion and tracks progress",
    version: "1.0.8",
    category: "Code Quality",
    event: "PostToolUse",
    matcher: "Edit|Write|NotebookEdit",
    tags: ["tasks", "tracking", "quality"],
  },

  // Security
  {
    name: "checksecurity",
    displayName: "Check Security",
    description: "Runs security checks via Claude and Codex headless agents",
    version: "0.1.6",
    category: "Security",
    event: "PostToolUse",
    matcher: "Edit|Write|NotebookEdit",
    tags: ["security", "audit", "vulnerabilities"],
  },
  {
    name: "packageage",
    displayName: "Package Age",
    description: "Checks package age before install to prevent typosquatting",
    version: "0.1.1",
    category: "Security",
    event: "PreToolUse",
    matcher: "Bash",
    tags: ["npm", "packages", "typosquatting", "supply-chain"],
  },

  // Notifications
  {
    name: "phonenotify",
    displayName: "Phone Notify",
    description: "Sends push notifications to phone via ntfy.sh",
    version: "0.1.0",
    category: "Notifications",
    event: "Stop",
    matcher: "",
    tags: ["notification", "phone", "push", "ntfy"],
  },
  {
    name: "agentmessages",
    displayName: "Agent Messages",
    description: "Inter-agent messaging integration for service-message",
    version: "0.1.0",
    category: "Notifications",
    event: "Stop",
    matcher: "",
    tags: ["messaging", "agents", "inter-agent"],
  },

  // Context Management
  {
    name: "contextrefresh",
    displayName: "Context Refresh",
    description: "Re-injects important context every N prompts to prevent drift",
    version: "0.1.0",
    category: "Context Management",
    event: "Notification",
    matcher: "",
    tags: ["context", "memory", "prompts", "refresh"],
  },
  {
    name: "precompact",
    displayName: "Pre-Compact",
    description: "Saves session state before context compaction",
    version: "0.1.0",
    category: "Context Management",
    event: "Notification",
    matcher: "",
    tags: ["context", "compaction", "state", "backup"],
  },
];

export function getHooksByCategory(category: Category): HookMeta[] {
  return HOOKS.filter((h) => h.category === category);
}

export function searchHooks(query: string): HookMeta[] {
  const q = query.toLowerCase();
  return HOOKS.filter(
    (h) =>
      h.name.toLowerCase().includes(q) ||
      h.displayName.toLowerCase().includes(q) ||
      h.description.toLowerCase().includes(q) ||
      h.tags.some((t) => t.includes(q))
  );
}

export function getHook(name: string): HookMeta | undefined {
  return HOOKS.find((h) => h.name === name);
}
