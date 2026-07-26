import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { join } from "path";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { claimCommand, getAgentName, gitCommandInfo, gitRemoteHostSlug, managedWorktreeInfo } from "./codewith-native-common";

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

    /** A worktree root as git leaves it: `.git` is a file for a linked worktree. */
    const makeWorktree = (repo: string, worktree: string, gitEntry: "file" | "dir" = "file"): string => {
      const worktreeRoot = join(root, repo, worktree);
      mkdirSync(worktreeRoot, { recursive: true });
      if (gitEntry === "file") writeFileSync(join(worktreeRoot, ".git"), "gitdir: /elsewhere/.git/worktrees/wt\n");
      else mkdirSync(join(worktreeRoot, ".git"), { recursive: true });
      return worktreeRoot;
    };

    test("accepts the canonical <repo-name>/<worktree-name> worktree root", () => {
      const worktreeRoot = makeWorktree("open-hooks", "OPE61-00004-worktree-guard");
      const info = managedWorktreeInfo(worktreeRoot);
      expect(info.managed).toBe(true);
      expect(info.layout).toBe("canonical");
      expect(info.repo).toBe("open-hooks");
      expect(info.worktree).toBe("OPE61-00004-worktree-guard");
      expect(info.worktreeRoot).toBe(worktreeRoot);
      expect(info.deprecated).toBeUndefined();
    });

    test("accepts a canonical path whose checkout is a standalone repo", () => {
      // Rule 8 governs where the checkout lives, not whether it is a linked worktree.
      expect(managedWorktreeInfo(makeWorktree("open-hooks", "standalone", "dir")).managed).toBe(true);
    });

    test("accepts subdirectories of a canonical worktree", () => {
      const worktreeRoot = makeWorktree("open-hooks", "OPE61-00004-worktree-guard");
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

    test("rejects a subdirectory of a flat worktree, which has the canonical shape", () => {
      // The whole point of the flat prohibition: `<root>/<flat-wt>/<subdir>` is
      // shape-identical to `<root>/<repo>/<worktree>`, so a `cd` must not launder it.
      const flat = join(root, "open-hooks-flat-worktree");
      mkdirSync(join(flat, "src"), { recursive: true });
      writeFileSync(join(flat, ".git"), "gitdir: /elsewhere\n");

      const info = managedWorktreeInfo(join(flat, "src"));
      expect(info.managed).toBe(false);
      expect(info.reason).toContain("is not a git worktree root (no .git)");
    });

    test("rejects a canonical-shaped path that is not a worktree root", () => {
      mkdirSync(join(root, "invented", "worktree"), { recursive: true });
      expect(managedWorktreeInfo(join(root, "invented", "worktree")).reason).toContain("not a git worktree root");
      expect(managedWorktreeInfo(join(root, "never", "created")).reason).toContain("no worktree exists at");
    });

    test("rejects a canonical-shaped path reached through a symlink", () => {
      // A symlinked segment can aim a compliant-looking path at a shared checkout.
      const shared = join(tmp, "shared-checkout");
      mkdirSync(shared, { recursive: true });
      writeFileSync(join(shared, ".git"), "gitdir: /elsewhere\n");
      mkdirSync(join(root, "open-hooks"), { recursive: true });
      symlinkSync(shared, join(root, "open-hooks", "linked"));
      symlinkSync(join(tmp, "shared-checkout"), join(root, "linked-repo"));
      mkdirSync(join(tmp, "shared-checkout", "wt"), { recursive: true });

      expect(managedWorktreeInfo(join(root, "open-hooks", "linked")).reason).toContain("traverses a symlink");
      expect(managedWorktreeInfo(join(root, "linked-repo", "wt")).reason).toContain("traverses a symlink");
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

    test("recognises the legacy lease layout from inside it, like a canonical subdirectory", () => {
      const info = managedWorktreeInfo(join(root, "station01", "open-hooks-a55c105a", "wt_2ab04216a30ef5ece642792e", "repo", "src"));
      expect(info.managed).toBe(false);
      expect(info.layout).toBe("legacy-station-lease");
      expect(info.worktreeRoot).toBe(join(root, "station01", "open-hooks-a55c105a", "wt_2ab04216a30ef5ece642792e"));
    });

    test("rejects nesting deeper than the canonical shape", () => {
      const info = managedWorktreeInfo(join(root, "station01", "open-hooks", "wt-name", "repo"));
      expect(info.managed).toBe(false);
      expect(info.layout).toBeUndefined();
      expect(info.reason).toContain("station-id/machine segment or extra nesting");
    });

    test("rejects malformed canonical segments", () => {
      expect(managedWorktreeInfo(join(root, "-bad-repo", "worktree")).reason).toContain("repo-name segment is malformed");
      expect(managedWorktreeInfo(join(root, "open-hooks", "-bad-worktree")).reason).toContain("worktree-name segment is malformed");
      expect(managedWorktreeInfo(join(root, ".hidden", "worktree")).reason).toContain("repo-name segment is malformed");
      expect(managedWorktreeInfo(join(root, "open-hooks", ".git")).reason).toContain("worktree-name segment is malformed");
    });

    test("accepts ordinary directory names an allowlist would wrongly reject", () => {
      // Observed on the fleet: connectors/_base. Long and punctuated names are legal
      // directory names, so the guard must not invent a stricter naming rule.
      for (const [repo, worktree] of [
        ["connectors", "_base"],
        ["c++utils", "OPE61-00004"],
        ["open-hooks", "e".repeat(200)],
        ["Open-Hooks", "task~1 with spaces"],
      ]) {
        expect(managedWorktreeInfo(makeWorktree(repo!, worktree!)).managed, `${repo}/${worktree}`).toBe(true);
      }
    });
  });

  test("claimCommand renders the canonical worktree path template", () => {
    const previous = process.env.HASNA_REPOS_WORKTREES_ROOT;
    process.env.HASNA_REPOS_WORKTREES_ROOT = "/root/worktrees";
    try {
      // The canonical repo name comes from the repos CLI, and is frequently not the
      // git remote basename: `open-hooks` is `github.com/hasna/hooks`.
      expect(claimCommand("open-hooks", "OPE61-00004", "main")).toBe(
        "git worktree add -b OPE61-00004 /root/worktrees/open-hooks/OPE61-00004 origin/main && repos scan",
      );
      expect(claimCommand(null, null)).toContain("/root/worktrees/<repo-name>/<worktree-name>");
      expect(claimCommand("open-hooks", "OPE61-00004")).toContain("origin/<default-branch>");
    } finally {
      if (previous === undefined) delete process.env.HASNA_REPOS_WORKTREES_ROOT;
      else process.env.HASNA_REPOS_WORKTREES_ROOT = previous;
    }
  });

  test("claimCommand never derives the repo segment from a remote slug", () => {
    // A slug must not silently become `hooks/`; the caller resolves the canonical
    // name, and an unresolved name stays an explicit placeholder.
    const previous = process.env.HASNA_REPOS_WORKTREES_ROOT;
    process.env.HASNA_REPOS_WORKTREES_ROOT = "/root/worktrees";
    try {
      expect(claimCommand(null, "OPE61-00004")).toContain("/root/worktrees/<repo-name>/OPE61-00004");
    } finally {
      if (previous === undefined) delete process.env.HASNA_REPOS_WORKTREES_ROOT;
      else process.env.HASNA_REPOS_WORKTREES_ROOT = previous;
    }
  });

  test("gitRemoteHostSlug normalises origin to the repos CLI's exact host/org/name form", async () => {
    const base = mkdtempSync(join(tmpdir(), "hooks-remote-"));
    try {
      const cases: Array<[string, string | null]> = [
        ["https://github.com/hasna/hooks.git", "github.com/hasna/hooks"],
        ["https://github.com/hasna/hooks", "github.com/hasna/hooks"],
        ["git@github.com:hasna/hooks.git", "github.com/hasna/hooks"],
        ["ssh://git@github.com/hasna/hooks.git", "github.com/hasna/hooks"],
        // Not an org/name pair, so there is no exact repos CLI key to look up.
        ["https://example.com/hooks.git", null],
      ];

      for (const [remote, expected] of cases) {
        const repo = join(base, `repo-${cases.findIndex(([r]) => r === remote)}`);
        mkdirSync(repo, { recursive: true });
        expect(Bun.spawnSync(["git", "init", "-q"], { cwd: repo }).exitCode).toBe(0);
        expect(Bun.spawnSync(["git", "remote", "add", "origin", remote], { cwd: repo }).exitCode).toBe(0);
        expect(await gitRemoteHostSlug(repo), remote).toBe(expected);
      }
    } finally {
      rmSync(base, { recursive: true, force: true });
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
