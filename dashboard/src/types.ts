export interface HookMeta {
  name: string;
  displayName: string;
  description: string;
  version: string;
  category: string;
  event: "PreToolUse" | "PostToolUse" | "Stop" | "Notification" | "SessionStart" | "SessionEnd";
  matcher: string;
  tags: string[];
}
