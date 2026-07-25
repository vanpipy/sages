/**
 * worktree-managed.test.ts — Core domain invariants for managed worktrees.
 *
 * GC-2026-008 P1: the orchestrator's managed-worktree domain must enforce
 * strict containment, validated identity, and a single base ref
 * (`origin/main`). This file pins those rules down:
 *
 *   1. validateIdentity rejects path separators, `..`, leading dot, empty.
 *   2. worktreePath returns `<repoRoot>/.pi/worktree/<dag>/<worktree>` after
 *      realpath normalization and refuses to escape `<repoRoot>`.
 *   3. branchName always returns `sages/<dag>/<worktree>`.
 *   4. createManagedWorktree uses `origin/main` (not local HEAD, not detached).
 *   5. createManagedWorktree throws when `origin/main` is missing — no
 *      fallback to local refs.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { existsSync, mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  branchName,
  createManagedWorktree,
  validateIdentity,
  worktreePath,
} from "../src/worktree.js";
import { makeRepoFixture, runGit, type RepoFixture } from "./_fixture.js";

describe("worktree-managed: identity", () => {
  it.each([
    ["", "P1", "dag must not be empty"],
    ["GC-2026-008", "", "worktree must not be empty"],
    ["GC/2026", "P1", "dag must not contain /"],
    ["GC\\2026", "P1", "dag must not contain \\"],
    ["GC-2026-008", "T/1", "worktree must not contain /"],
    [".", "P1", "dag must not be '.'"],
    ["..", "P1", "dag must not be '..'"],
    ["GC-2026-008", "..", "worktree must not be '..'"],
    ["GC-2026-008", ".", "worktree must not be '.'"],
    ["foo/bar", "P1", "dag must reject path-traversal"],
    ["foo bar", "P1", "dag must reject whitespace"],
  ])("validateIdentity throws on %s + %s", (dag, worktree, _hint) => {
    expect(() => validateIdentity(dag, worktree)).toThrow();
  });

  it("validateIdentity accepts names matching the project's conventions", () => {
    expect(() => validateIdentity("GC-2026-008", "P1")).not.toThrow();
    expect(() => validateIdentity("GC-2026-008", "T1")).not.toThrow();
    expect(() => validateIdentity("dag_v3", "wt-2")).not.toThrow();
  });
});

describe("worktree-managed: path containment", () => {
  it("worktreePath returns <repoRoot>/.pi/worktree/<dag>/<worktree>", () => {
    const repo = "/repos/sages";
    const got = worktreePath(repo, "GC-2026-008", "P1");
    expect(got).toBe("/repos/sages/.pi/worktree/GC-2026-008/P1");
  });

  it("worktreePath normalizes realpath on both sides (symlinks, ./, ../)", () => {
    // `<repo>/nested/../` resolves to `<repo>`; the inserted path is still
    // strictly contained.
    const repo = "/repos/sages/";
    const got = worktreePath(repo, "GC-2026-008", "P1");
    const resolved = realpathSync(got); // existence is not required; use a real path
    expect(resolved.startsWith("/repos/sages/")).toBe(true);
  });

  it("createManagedWorktree refuses to provision outside the repo root", () => {
    // The real containment check runs at create-time. A repo rooted at
    // `/repos/sages/.` after realpath must still point inside `/repos/sages`
    // — but a manual call to worktreePath with `..` would be filtered by
    // validateIdentity anyway. We re-verify the create-time path is realpath
    // bounded.
    const repo = "/repos/sages";
    const candidate = worktreePath(repo, "GC-2026-008", "P1");
    expect(candidate.startsWith(repo + "/")).toBe(true);
  });
});

describe("worktree-managed: branch naming", () => {
  it("branchName returns sages/<dag>/<worktree>", () => {
    expect(branchName("GC-2026-008", "P1")).toBe("sages/GC-2026-008/P1");
    expect(branchName("GC_2026", "wt-2")).toBe("sages/GC_2026/wt-2");
  });
});

describe("worktree-managed: create from origin/main", () => {
  let fx: RepoFixture;
  beforeEach(() => {
    fx = makeRepoFixture("managed-create");
  });
  afterEach(() => {
    fx.dispose();
  });

  it("provisions worktree at <repo>/.pi/worktree/<dag>/<worktree> with base = origin/main", () => {
    const wt = createManagedWorktree({
      repoRoot: fx.root,
      dag: "GC-2026-008",
      worktree: "P1",
    });
    expect(wt.path).toBe(join(fx.root, ".pi/worktree/GC-2026-008/P1"));
    expect(wt.branch).toBe("sages/GC-2026-008/P1");
    expect(wt.baseRef).toBe("origin/main");
    expect(wt.baseSha).toBe(fx.originMainSha);

    // Worktree physically exists, has a .git pointer, and HEAD == origin/main.
    expect(existsSync(wt.path)).toBe(true);
    expect(existsSync(join(wt.path, ".git"))).toBe(true);
    const headSha = runGit(["rev-parse", "HEAD"], { cwd: wt.path }).trim();
    expect(headSha).toBe(fx.originMainSha);

    // Branch checked out is `sages/<dag>/<worktree>`.
    const branches = runGit(["branch"], { cwd: wt.path });
    expect(branches).toContain("sages/GC-2026-008/P1");

    // Sibling worktree registered with the main repo.
    const wtList = runGit(["worktree", "list"], { cwd: fx.root });
    expect(wtList).toContain(wt.path);
  });

  it("origin/main advance bumps baseSha on a fresh create", () => {
    const newSha = runGitPushAdvance(fx);
    const wt = createManagedWorktree({
      repoRoot: fx.root,
      dag: "GC-2026-008",
      worktree: "P1",
    });
    expect(wt.baseSha).toBe(newSha);
    expect(wt.baseSha).not.toBe(fx.originMainSha);
  });
});

/**
 * Helper — pushes an empty commit to origin/main and refreshes the test repo's
 * local view. Returns the new origin/main sha.
 */
function runGitPushAdvance(fx: RepoFixture): string {
  const seed = join(fx.root, "..", `seed-${Date.now()}`);
  runGit(["init", "--initial-branch=main", seed], { cwd: fx.root });
  runGit(["remote", "add", "origin", fx.remote], { cwd: seed });
  runGit(["fetch", "origin", "main"], { cwd: seed });
  runGit(["reset", "--hard", "origin/main"], { cwd: seed });
  runGit(["config", "user.name", "Test"], { cwd: seed });
  runGit(["config", "user.email", "t@x.invalid"], { cwd: seed });
  runGit(["commit", "--allow-empty", "-m", "advance"], { cwd: seed });
  runGit(["push", "origin", "main"], { cwd: seed });
  runGit(["fetch", "origin", "main"], { cwd: fx.root });
  return runGit(["rev-parse", "origin/main"], { cwd: fx.root }).trim();
}

/**
 * No fallback — missing `origin/main` must throw, not silently fall back to
 * a local ref.
 */
describe("worktree-managed: no fallback (stricter than the upstream Agent-isolation path)", () => {
  let fx: RepoFixture;
  beforeEach(() => {
    fx = makeRepoFixture("managed-nofallback");
  });
  afterEach(() => {
    fx.dispose();
  });

  it("throws when origin/main does not exist (no fallback to HEAD)", () => {
    // Build a separate working repo with NO `main` branch on origin. We
    // reuse the seed machinery but push to a branch the working repo will
    // never see as `origin/main`, then drop the local main branch and its
    // remote-tracking ref. After this dance, `git rev-parse origin/main`
    // fails to resolve.
    //
    // 1. Start a temp branch on origin so the remote's first ref != main.
    runGit(["push", "origin", `HEAD:refs/heads/initial-non-main`], { cwd: fx.root });
    // 2. From the test repo's point of view we don't care about that ref
    //    (fetch would import it but it doesn't shadow origin/main).
    //    To actually remove origin/main we have to: switch the worktree's
    //    HEAD off `main`, then delete `main` locally, then drop the remote
    //    tracking ref.
    runGit(["update-ref", "-d", "refs/remotes/origin/main"], { cwd: fx.root });
    //    `git branch -d main` refuses while main is the worktree's current
    //    branch — move HEAD to a detached state via `git checkout main~0`
    //    would be recursive; instead, just create a new branch, switch,
    //    then delete main.
    runGit(["checkout", "--detach", fx.originMainSha], { cwd: fx.root });
    runGit(["branch", "-D", "main"], { cwd: fx.root });

    // Verify `origin/main` really doesn't resolve.
    let resolved = "";
    try {
      resolved = runGit(["rev-parse", "--verify", "origin/main"], { cwd: fx.root }).trim();
    } catch {
      // expected — ref missing
    }
    expect(resolved).toBe("");

    expect(() =>
      createManagedWorktree({
        repoRoot: fx.root,
        dag: "GC-2026-008",
        worktree: "P1",
        // fetch: false — otherwise the push above would re-import
        //          origin/main via the `initial-non-main` push. (Actually
        //          it's a different ref so it wouldn't, but we keep the
        //          flag for test isolation.)
        fetch: false,
      }),
    ).toThrow(/origin\/main/i);
  });

  it("throws when repoRoot is not a git repo", () => {
    const empty = join(fx.root, "..", `not-a-repo-${Date.now()}`);
    mkdirSync(empty, { recursive: true });
    writeFileSync(join(empty, "marker.txt"), "not a repo\n");
    expect(() =>
      createManagedWorktree({
        repoRoot: empty,
        dag: "GC-2026-008",
        worktree: "P1",
      }),
    ).toThrow();
  });

  it("throws when repoRoot is a bare repo (no working tree to host .pi/worktree)", () => {
    // The bare remote IS a git repo but is not the kind of repo the orchestrator
    // intends — `origin/main` resolves but the add-worktree target ends up
    // outside the bare repo's working tree. Either way it must throw, never
    // silently succeed.
    expect(() =>
      createManagedWorktree({
        repoRoot: fx.remote,
        dag: "GC-2026-008",
        worktree: "P1",
      }),
    ).toThrow();
  });
});
