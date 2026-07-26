import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { join } from "path";
import { mkdirSync, mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { claimCommand, getAgentName, gitCommandInfo, managedWorktreeInfo } from "./codewith-native-common";

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

  describe("managedWorktreeInfo canonical path shape (Agent Operating Rules rule 8)", () => {
    let tmp: string;
    let root: string;
    let previous: string | undefined;

    beforeEach(() => {
      tmp = mkdtempSync(join(tmpdir(), "hooks-worktrees-"));
      root = join(tmp, "worktrees");
      previous = process.env.HASNA_REPOS_WORKTREES_ROOT;
      process.env.HASNA_REPOS_WORKTREES_ROOT = root;
    });

    afterEach(() => {
      if (previous === undefined) delete process.env.HASNA_REPOS_WORKTREES_ROOT;
      else process.env.HASNA_REPOS_WORKTREES_ROOT = previous;
      rmSync(tmp, { recursive: true, force: true });
    });

    test("accepts the canonical <repo-name>/<worktree-name> worktree root", () => {
      const info = managedWorktreeInfo(join(root, "open-hooks", "OPE61-00004-worktree-guard"));
      expect(info.managed).toBe(true);
      expect(info.layout).toBe("canonical");
      expect(info.repo).toBe("open-hooks");
      expect(info.worktree).toBe("OPE61-00004-worktree-guard");
      expect(info.worktreeRoot).toBe(join(root, "open-hooks", "OPE61-00004-worktree-guard"));
      expect(info.deprecated).toBeUndefined();
    });

    test("accepts subdirectories of a canonical worktree", () => {
      const worktreeRoot = join(root, "open-hooks", "OPE61-00004-worktree-guard");
      mkdirSync(join(worktreeRoot, ".git"), { recursive: true });
      mkdirSync(join(worktreeRoot, "hooks", "worktree-guard", "src"), { recursive: true });

      for (const nested of [
        join(worktreeRoot, "hooks"),
        join(worktreeRoot, "hooks", "worktree-guard", "src"),
      ]) {
        const info = managedWorktreeInfo(nested);
        expect(info.managed).toBe(true);
        expect(info.layout).toBe("canonical");
        expect(info.worktreeRoot).toBe(worktreeRoot);
      }
    });

    test("rejects a flat single-segment worktree under the worktrees root", () => {
      const info = managedWorktreeInfo(join(root, "open-hooks-flat-worktree"));
      expect(info.managed).toBe(false);
      expect(info.layout).toBeUndefined();
      expect(info.reason).toContain("flat under the worktrees root");
      expect(info.reason).toContain(join(root, "<repo-name>", "<worktree-name>"));
    });

    test("rejects the worktrees root itself", () => {
      const info = managedWorktreeInfo(root);
      expect(info.managed).toBe(false);
      expect(info.reason).toContain("worktrees root itself");
    });

    test("rejects paths outside the worktrees root", () => {
      const info = managedWorktreeInfo(join(tmp, "elsewhere", "open-hooks"));
      expect(info.managed).toBe(false);
      expect(info.reason).toBe("outside worktrees root");
    });

    test("rejects a station-id segment in front of <repo>/<worktree>", () => {
      const info = managedWorktreeInfo(join(root, "station01", "open-hooks", "OPE61-00004-worktree-guard"));
      expect(info.managed).toBe(false);
      expect(info.reason).toContain("station-id/machine segment or extra nesting");
      expect(info.reason).toContain(join(root, "<repo-name>", "<worktree-name>"));
    });

    test("rejects the deprecated station-id lease layout, labelling it for migration", () => {
      const info = managedWorktreeInfo(join(root, "station01", "open-hooks-a55c105a", "wt_2ab04216a30ef5ece642792e"));
      expect(info.managed).toBe(false);
      expect(info.layout).toBe("legacy-station-lease");
      expect(info.deprecated).toBe(true);
      expect(info.reason).toContain("deprecated station-id lease layout");
      expect(info.reason).toContain(join(root, "<repo-name>", "<worktree-name>"));
    });

    test("rejects nesting deeper than the canonical shape", () => {
      const info = managedWorktreeInfo(join(root, "station01", "open-hooks-a55c105a", "wt_2ab04216a30ef5ece642792e", "repo"));
      expect(info.managed).toBe(false);
      expect(info.reason).toContain("station-id/machine segment or extra nesting");
    });

    test("rejects malformed canonical segments", () => {
      expect(managedWorktreeInfo(join(root, "-bad-repo", "worktree")).reason).toContain("repo-name segment is malformed");
      expect(managedWorktreeInfo(join(root, "open-hooks", "-bad-worktree")).reason).toContain("worktree-name segment is malformed");
      expect(managedWorktreeInfo(join(root, ".hidden", "worktree")).reason).toContain("repo-name segment is malformed");
      expect(managedWorktreeInfo(join(root, "open-hooks", ".git")).reason).toContain("worktree-name segment is malformed");
    });

    test("accepts ordinary directory names, including a leading underscore", () => {
      // Observed on the fleet: connectors/_base.
      expect(managedWorktreeInfo(join(root, "connectors", "_base")).managed).toBe(true);
    });
  });

  test("claimCommand renders the canonical worktree path template", () => {
    const previous = process.env.HASNA_REPOS_WORKTREES_ROOT;
    process.env.HASNA_REPOS_WORKTREES_ROOT = "/root/worktrees";
    try {
      expect(claimCommand("hasna/hooks", "OPE61-00004")).toBe(
        "git worktree add -b OPE61-00004 /root/worktrees/hooks/OPE61-00004 origin/<base> && repos scan",
      );
      expect(claimCommand(null, null)).toContain("/root/worktrees/<repo-name>/<worktree-name>");
    } finally {
      if (previous === undefined) delete process.env.HASNA_REPOS_WORKTREES_ROOT;
      else process.env.HASNA_REPOS_WORKTREES_ROOT = previous;
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
