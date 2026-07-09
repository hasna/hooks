import { describe, expect, test } from "bun:test";
import { join } from "path";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { getAgentName, gitCommandInfo, managedWorktreeInfo } from "./codewith-native-common";

describe("codewith native common helpers", () => {
  test("gitCommandInfo detects global option commit/push forms and target cwd", () => {
    const base = mkdtempSync(join(tmpdir(), "hooks-common-"));
    try {
      expect(gitCommandInfo("git -c user.name=test commit -m test", base)?.action).toBe("commit");
      expect(gitCommandInfo("git -C ./repo push origin feature", base)).toMatchObject({
        action: "push",
        targetCwd: join(base, "repo"),
      });
      expect(gitCommandInfo("git --git-dir .git --work-tree . commit", base)).toMatchObject({
        action: "commit",
        targetCwd: base,
      });
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  test("managedWorktreeInfo rejects malformed fake managed-root paths", () => {
    const tmp = mkdtempSync(join(tmpdir(), "hooks-worktrees-"));
    const previous = process.env.HASNA_REPOS_WORKTREES_ROOT;
    process.env.HASNA_REPOS_WORKTREES_ROOT = join(tmp, "worktrees");
    try {
      const valid = join(tmp, "worktrees", "station01", "open-hooks-a55c105a", "wt_2ab04216a30ef5ece642792e", "repo");
      expect(managedWorktreeInfo(valid).managed).toBe(true);
      expect(managedWorktreeInfo(join(tmp, "worktrees", "station01", "open-hooks-a55c105a", "wt_fake", "repo")).managed).toBe(false);
      expect(managedWorktreeInfo(join(tmp, "worktrees", "station01", "open-hooks-nohash", "wt_2ab04216a30ef5ece642792e", "repo")).managed).toBe(false);
      expect(managedWorktreeInfo(join(tmp, "worktrees", "station01", "open-hooks-zzzzzzzz", "wt_2ab04216a30ef5ece642792e", "repo")).managed).toBe(false);
    } finally {
      if (previous === undefined) delete process.env.HASNA_REPOS_WORKTREES_ROOT;
      else process.env.HASNA_REPOS_WORKTREES_ROOT = previous;
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("getAgentName reads Codewith input.agent profile injection", () => {
    const saved = {
      HOOKS_AGENT_NAME: process.env.HOOKS_AGENT_NAME,
      CODEWITH_AGENT_NAME: process.env.CODEWITH_AGENT_NAME,
      CONVERSATIONS_AGENT_ID: process.env.CONVERSATIONS_AGENT_ID,
    };
    delete process.env.HOOKS_AGENT_NAME;
    delete process.env.CODEWITH_AGENT_NAME;
    delete process.env.CONVERSATIONS_AGENT_ID;
    try {
      expect(getAgentName({ agent: { name: "profile-agent" } })).toBe("profile-agent");
      expect(getAgentName({ agent: { agent_id: "profile_id" } })).toBe("profile_id");
    } finally {
      for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });
});
