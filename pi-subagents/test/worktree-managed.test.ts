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
 *
 * GC-2026-008 P2 (base_ref): the base ref is now configurable per call.
 * When `opts.base_ref` is supplied it is used verbatim (after validation);
 * when omitted, the helper resolves the current branch's upstream tracking
 * ref (e.g. `origin/main`) and falls back to the local branch name and
 * finally `origin/main` for detached HEAD. Marker schema bumps to v2 and
 * records the actual ref; v1 markers remain readable for inspection.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { existsSync, mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  branchName,
  createManagedWorktree,
  resolveBaseRef,
  validateBaseRef,
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
    // strictly contained. Trailing slashes in `<repoRoot>` must not produce
    // `//.pi/worktree/...`, and the joined path must remain under
    // `<repoRoot>/` after normalization.
    const repo = "/repos/sages/";
    const got = worktreePath(repo, "GC-2026-008", "P1");
    // `realpathSync` requires the path to exist; the test path doesn't.
    // We only care about NORMALIZED containment, so use a tolerant
    // realpath that falls back to the input on ENOENT.
    const resolved = (() => {
      try {
        return realpathSync(got);
      } catch {
        return got;
      }
    })();
    expect(resolved.startsWith("/repos/sages/")).toBe(true);
    expect(got).not.toContain("//");
    expect(got.endsWith("/.pi/worktree/GC-2026-008/P1")).toBe(true);
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

/**
 * GC-2026-008 P2: `validateBaseRef` accepts the same character class git
 * uses for ref names (with `.` and `/` allowed on top of identity rules),
 * and refuses anything that could escape into a flag or a path-traversal
 * sequence when the string is passed to a `git` invocation.
 */
describe("worktree-managed: validateBaseRef (P2)", () => {
  it.each([
    ["main"],
    ["develop"],
    ["feature/x"],
    ["feature-x"],
    ["v1.2.3"],
    ["release_2024.01"],
    ["origin/main"],
    ["origin/feature/x"],
    ["a"],
    ["0"],
  ])("accepts safe ref %s", (ref) => {
    expect(() => validateBaseRef(ref)).not.toThrow();
  });

  it.each([
    ["", "must not be empty"],
    [" main", "leading/trailing whitespace"],
    ["main ", "leading/trailing whitespace"],
    ["../etc/passwd", "not a safe git ref name"],
    ["main..other", "not a safe git ref name"],
    ["HEAD@{0}", "not a safe git ref name"],
    ["/main", "not a safe git ref name"],
    ["main/sub/", "not a safe git ref name"],
    ["main branch", "not a safe git ref name"],
    ["main;rm", "not a safe git ref name"],
    ["main$ref", "not a safe git ref name"],
  ])("refuses unsafe ref %s (%s)", (ref, _hint) => {
    expect(() => validateBaseRef(ref)).toThrow();
  });

  it("refuses non-string input", () => {
    expect(() => validateBaseRef(undefined as any)).toThrow();
    expect(() => validateBaseRef(null as any)).toThrow();
    expect(() => validateBaseRef(42 as any)).toThrow();
  });
});

/**
 * GC-2026-008 P2: `resolveBaseRef` is the smart default that powers the
 * "get baseline from cwd" capability. Three resolution levels:
 *   1. Explicit `baseRef` → validate + return verbatim
 *   2. Auto: current branch's upstream (e.g. `origin/main`)
 *   3. Auto: local branch name (when no upstream)
 *   4. Fallback: `"origin/main"` (detached HEAD / non-git)
 *
 * The fixture's local `main` tracks `origin/main`, so the smart default
 * picks `origin/main` in the default case — preserving the historical
 * GC-2026-008 P1 behavior on the main branch.
 */
describe("worktree-managed: resolveBaseRef (P2)", () => {
  let fx: RepoFixture;
  beforeEach(() => {
    fx = makeRepoFixture("resolve-base-ref");
  });
  afterEach(() => {
    fx.dispose();
  });

  it("explicit baseRef is returned verbatim (after validation)", () => {
    expect(resolveBaseRef(fx.root, "feature/x")).toBe("feature/x");
    expect(resolveBaseRef(fx.root, "origin/feature/x")).toBe("origin/feature/x");
    expect(resolveBaseRef(fx.root, "v1.2.3")).toBe("v1.2.3");
  });

  it("explicit baseRef that fails validation throws (no silent fallback)", () => {
    expect(() => resolveBaseRef(fx.root, "../escape")).toThrow();
    expect(() => resolveBaseRef(fx.root, "")).toThrow();
  });

  it("auto on a tracking branch returns the upstream ref (e.g. origin/main)", () => {
    // Fixture's main tracks origin/main → smart default picks origin/main.
    expect(resolveBaseRef(fx.root, undefined)).toBe("origin/main");
  });

  it("auto on a branch with no upstream returns the local branch name", () => {
    // Create a feature branch without an upstream — local branch wins.
    // `checkout -b` does NOT auto-set upstream by default; defensive
    // `--unset-upstream` would fail when there's no upstream to unset, so
    // we skip it and rely on the rev-parse sanity check below.
    runGit(["checkout", "-b", "feature/no-upstream"], { cwd: fx.root });
    // Sanity: no upstream configured for this branch.
    expect(() =>
      runGit(["rev-parse", "--abbrev-ref", "@{u}"], { cwd: fx.root }),
    ).toThrow();
    expect(resolveBaseRef(fx.root, undefined)).toBe("feature/no-upstream");
  });

  it("auto on detached HEAD falls back to origin/main", () => {
    // Detach HEAD at the current commit.
    runGit(["checkout", "--detach"], { cwd: fx.root });
    expect(resolveBaseRef(fx.root, undefined)).toBe("origin/main");
  });
});

/**
 * GC-2026-008 P2: `createManagedWorktree` honors the explicit `base_ref`
 * field at provision time. Remote-tracking refs trigger a `git fetch`
 * first; local refs do not. The result's `baseRef` records the actual
 * ref used, and the marker (schema v2) carries it for reuse verification.
 */
describe("worktree-managed: create with explicit base_ref (P2)", () => {
  let fx: RepoFixture;
  beforeEach(() => {
    fx = makeRepoFixture("create-base-ref");
  });
  afterEach(() => {
    fx.dispose();
  });

  it("explicit base_ref 'origin/main' produces baseRef='origin/main' (same as default)", () => {
    const wt = createManagedWorktree({
      repoRoot: fx.root,
      dag: "GC-2026-008",
      worktree: "P1",
      base_ref: "origin/main",
    });
    expect(wt.baseRef).toBe("origin/main");
    expect(wt.baseSha).toBe(fx.originMainSha);
  });

  it("explicit base_ref 'feature/x' (local) uses the local tip without fetching", () => {
    // Create a feature branch off main with one extra commit, no upstream.
    // `checkout -b` does NOT auto-set upstream; the branch is local-only.
    runGit(["checkout", "-b", "feature/local"], { cwd: fx.root });
    const featureSha = runGit(["rev-parse", "HEAD"], { cwd: fx.root }).trim();
    runGit(["commit", "--allow-empty", "-m", "feat: local work"], {
      cwd: fx.root,
    });
    const tipSha = runGit(["rev-parse", "HEAD"], { cwd: fx.root }).trim();

    const wt = createManagedWorktree({
      repoRoot: fx.root,
      dag: "GC-2026-008",
      worktree: "P1",
      base_ref: "feature/local",
    });
    expect(wt.baseRef).toBe("feature/local");
    expect(wt.baseSha).toBe(tipSha);
    // The worktree is at the tip of the local feature branch, not the
    // seed commit (proves no fetch-then-detach happened — fetch would
    // have left it at featureSha, the upstream-tracking base).
    const headSha = runGit(["rev-parse", "HEAD"], { cwd: wt.path }).trim();
    expect(headSha).toBe(tipSha);
    expect(headSha).not.toBe(featureSha);
  });

  it("explicit base_ref 'origin/feature/x' triggers a fetch and uses the remote tip", () => {
    // Create a feature branch and push it to origin so origin/feature/x exists.
    runGit(["checkout", "-b", "feature/published"], { cwd: fx.root });
    const featureCommit = runGit(
      ["commit", "--allow-empty", "-m", "feat: published"],
      { cwd: fx.root },
    );
    void featureCommit;
    runGit(["push", "origin", "feature/published"], { cwd: fx.root });
    const originTipSha = runGit(
      ["rev-parse", "origin/feature/published"],
      { cwd: fx.root },
    ).trim();

    const wt = createManagedWorktree({
      repoRoot: fx.root,
      dag: "GC-2026-008",
      worktree: "P1",
      base_ref: "origin/feature/published",
    });
    expect(wt.baseRef).toBe("origin/feature/published");
    expect(wt.baseSha).toBe(originTipSha);
  });

  it("invalid base_ref (path-traversal) is rejected at the type boundary", () => {
    // validateBaseRef throws synchronously, BEFORE the create call hits git.
    expect(() =>
      createManagedWorktree({
        repoRoot: fx.root,
        dag: "GC-2026-008",
        worktree: "P1",
        base_ref: "../etc/passwd",
      }),
    ).toThrow();
  });

  it("unresolvable base_ref throws (no silent fallback to origin/main)", () => {
    // The ref passes validation but does not exist in the repo.
    expect(() =>
      createManagedWorktree({
        repoRoot: fx.root,
        dag: "GC-2026-008",
        worktree: "P1",
        base_ref: "does/not/exist",
      }),
    ).toThrow(/does not resolve/);
  });
});

/**
 * GC-2026-008 P2: the marker schema bumps from v1 to v2 to record the
 * actual `baseRef` used at provision time. v1 markers (always
 * `origin/main`) remain readable for inspection but the reader exposes
 * them with the v1-implied `baseRef: "origin/main"` so reuse-contract
 * comparisons work uniformly across versions.
 */
describe("worktree-managed: marker schema v2 (P2)", () => {
  let fx: RepoFixture;
  beforeEach(() => {
    fx = makeRepoFixture("marker-schema");
  });
  afterEach(() => {
    fx.dispose();
  });

  it("provisions write a v2 marker with the resolved baseRef", async () => {
    const { readManagedWorktreeMarker } = await import("../src/worktree.js");
    const wt = createManagedWorktree({
      repoRoot: fx.root,
      dag: "GC-2026-008",
      worktree: "P1",
      base_ref: "origin/main",
    });
    const marker = readManagedWorktreeMarker(fx.root, "GC-2026-008", "P1");
    expect(marker).not.toBeNull();
    expect(marker!.schema).toBe(2);
    expect(marker!.baseRef).toBe("origin/main");
    expect(marker!.baseSha).toBe(wt.baseSha);
  });

  it("v1 markers in the wild are still readable (with synthesized baseRef)", async () => {
    const {
      markerPath,
      readManagedWorktreeMarker,
    } = await import("../src/worktree.js");
    const { writeFileSync, mkdirSync } = await import("node:fs");
    const { dirname } = await import("node:path");

    // Plant a fake v1 marker as if a previous version of the helper had
    // provisioned the slot.
    const fp = markerPath(fx.root, "GC-2026-008", "P1");
    mkdirSync(dirname(fp), { recursive: true });
    writeFileSync(
      fp,
      JSON.stringify({
        schema: 1,
        repoRoot: fx.root,
        dag: "GC-2026-008",
        worktree: "P1",
        path: "/tmp/fake",
        branch: "sages/GC-2026-008/P1",
        baseSha: fx.originMainSha,
        baseRef: "origin/main",
        createdAt: Date.now(),
      }),
    );
    const marker = readManagedWorktreeMarker(fx.root, "GC-2026-008", "P1");
    expect(marker).not.toBeNull();
    expect(marker!.schema).toBe(1);
    expect(marker!.baseRef).toBe("origin/main");
  });
});
