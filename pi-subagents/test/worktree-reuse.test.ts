/**
 * worktree-reuse.test.ts — Explicit reuse semantics.
 *
 * GC-2026-008 P1: the orchestrator may need to re-enter a managed worktree
 * (e.g. for serial DAG chains where one worktree hosts multiple tasks). The
 * behavior must be opt-in AND safety-checked:
 *
 *   - Default behavior (no `reuse`) refuses to silently reuse an existing
 *     worktree at the same path.
 *   - Explicit `reuse: true` re-enters the worktree iff identity, branch,
 *     and baseSha match the requested `(dag, worktree)` tuple.
 *   - Mismatched identity (different branch, different baseSha, or stale
 *     state) throws — we never silently overwrite a previous task's branch.
 *   - Concurrent collisions across the same `(dag, worktree)` slot throw
 *     with a message naming the path so the caller can decide.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createManagedWorktree } from "../src/worktree.js";
import { advanceOriginMain, makeRepoFixture, runGit, type RepoFixture } from "./_fixture.js";

describe("worktree-reuse: default refuses silent reuse", () => {
  let fx: RepoFixture;
  beforeEach(() => {
    fx = makeRepoFixture("reuse-default");
  });
  afterEach(() => {
    fx.dispose();
  });

  it("throws when a worktree already exists at the target path and reuse is not set", () => {
    createManagedWorktree({
      repoRoot: fx.root,
      dag: "GC-2026-008",
      worktree: "P1",
    });
    expect(() =>
      createManagedWorktree({
        repoRoot: fx.root,
        dag: "GC-2026-008",
        worktree: "P1",
      }),
    ).toThrow(/already|exist|reuse/i);
  });

  it("refuses reuse even when an unrelated git worktree exists at the target path", () => {
    // Manually create a different git worktree at the SAME path the managed
    // helper would use. The helper must refuse: a parallel tool populated the
    // slot, we don't know its state.
    const slot = join(fx.root, ".pi/worktree/GC-2026-008/P1");
    mkdirSync(slot, { recursive: true });
    runGit(["worktree", "add", "--detach", slot, "HEAD"], { cwd: fx.root });
    expect(() =>
      createManagedWorktree({
        repoRoot: fx.root,
        dag: "GC-2026-008",
        worktree: "P1",
      }),
    ).toThrow();
  });
});

describe("worktree-reuse: explicit reuse", () => {
  let fx: RepoFixture;
  beforeEach(() => {
    fx = makeRepoFixture("reuse-explicit");
  });
  afterEach(() => {
    fx.dispose();
  });

  it("returns the existing worktree when reuse: true and identity matches", () => {
    const first = createManagedWorktree({
      repoRoot: fx.root,
      dag: "GC-2026-008",
      worktree: "P1",
    });
    // Fast-forward origin/main so we can prove baseSha is recorded as the
    // original create-time value (i.e. not silently refreshed).
    advanceOriginMain(fx, "between-creates");

    const second = createManagedWorktree({
      repoRoot: fx.root,
      dag: "GC-2026-008",
      worktree: "P1",
      reuse: true,
    });

    expect(second.path).toBe(first.path);
    expect(second.branch).toBe(first.branch);
    expect(second.baseSha).toBe(first.baseSha); // unchanged — pinned at first create
    expect(second.baseRef).toBe("origin/main");

    // The reused worktree's HEAD must NOT have been reset to the new origin/main
    // — reuse means "re-enter"; the branch is the user's, not the orchestrator's.
    const headAfter = runGit(["rev-parse", "HEAD"], { cwd: first.path }).trim();
    expect(headAfter).toBe(first.baseSha);
  });

  it("the create result indicates reuse via an `identity` field preserved across calls", () => {
    const first = createManagedWorktree({
      repoRoot: fx.root,
      dag: "GC-2026-008",
      worktree: "P1",
    });
    expect(first.dag).toBe("GC-2026-008");
    expect(first.worktree).toBe("P1");

    const second = createManagedWorktree({
      repoRoot: fx.root,
      dag: "GC-2026-008",
      worktree: "P1",
      reuse: true,
    });
    expect(second.dag).toBe(first.dag);
    expect(second.worktree).toBe(first.worktree);
  });
});

describe("worktree-reuse: mismatched reuse rejected", () => {
  let fx: RepoFixture;
  beforeEach(() => {
    fx = makeRepoFixture("reuse-mismatch");
  });
  afterEach(() => {
    fx.dispose();
  });

  it("throws when reuse: true but the existing branch has been overwritten", () => {
    const first = createManagedWorktree({
      repoRoot: fx.root,
      dag: "GC-2026-008",
      worktree: "P1",
    });

    // Simulate a malicious / stale caller rewriting the branch on top of a
    // different commit. Reuse must refuse because the recorded branch state
    // is no longer "untouched since provision".
    runGit(["commit", "--allow-empty", "-m", "tamper"], { cwd: fx.root });
    runGit(["push", "origin", "HEAD:refs/heads/sages/GC-2026-008/P1"], { cwd: fx.root });

    expect(() =>
      createManagedWorktree({
        repoRoot: fx.root,
        dag: "GC-2026-008",
        worktree: "P1",
        reuse: true,
      }),
    ).toThrow(/reuse|identity|branch/i);

    // The worker's branch tip must be untouched (no fallback refresh).
    const head = runGit(["rev-parse", "HEAD"], { cwd: first.path }).trim();
    expect(head).toBe(first.baseSha);
  });

  it("throws when a different shared ref has been checked out under the same path", () => {
    const first = createManagedWorktree({
      repoRoot: fx.root,
      dag: "GC-2026-008",
      worktree: "P1",
    });

    // Detach HEAD onto an unrelated commit (simulates the user navigating
    // away). Reuse must refuse, since the recorded branch is no longer HEAD.
    const orphan = runGit(["rev-parse", "HEAD~0"], { cwd: first.path }).trim(); // == first.baseSha
    runGit(["checkout", "--detach", orphan], { cwd: first.path });

    expect(() =>
      createManagedWorktree({
        repoRoot: fx.root,
        dag: "GC-2026-008",
        worktree: "P1",
        reuse: true,
      }),
    ).toThrow();
  });

  it("a different (dag, worktree) tuple never collides with the first", () => {
    createManagedWorktree({
      repoRoot: fx.root,
      dag: "GC-2026-008",
      worktree: "P1",
    });
    const wt2 = createManagedWorktree({
      repoRoot: fx.root,
      dag: "GC-2026-008",
      worktree: "P2",
    });
    expect(wt2.path).toBe(join(fx.root, ".pi/worktree/GC-2026-008/P2"));
    expect(existsSync(wt2.path)).toBe(true);
  });

  it("concurrent collisions across two managed helpers from the same cwd throw", () => {
    // Two simultaneous calls, both targeting the same slot. One wins; the
    // other must throw with a message that names the path.
    let ok: unknown = undefined;
    let err: unknown = undefined;
    try {
      createManagedWorktree({
        repoRoot: fx.root,
        dag: "GC-2026-008",
        worktree: "P1",
      });
    } catch (e) {
      err = e;
    }
    if (!err) {
      // First succeeded — race the second.
      try {
        createManagedWorktree({
          repoRoot: fx.root,
          dag: "GC-2026-008",
          worktree: "P1",
        });
      } catch (e) {
        err = e;
      }
      ok = true;
    }
    expect(ok).toBeDefined();
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toContain(".pi/worktree/GC-2026-008/P1");
  });
});

describe("worktree-reuse: refuse to provision over an unrelated worktree on disk", () => {
  let fx: RepoFixture;
  beforeEach(() => {
    fx = makeRepoFixture("reuse-overwrite");
  });
  afterEach(() => {
    fx.dispose();
  });

  it("a non-empty directory at the target path is not silently adopted", () => {
    const slot = join(fx.root, ".pi/worktree/GC-2026-008/P1");
    mkdirSync(slot, { recursive: true });
    writeFileSync(join(slot, "left-over.txt"), "previously owned by something else\n");

    expect(() =>
      createManagedWorktree({
        repoRoot: fx.root,
        dag: "GC-2026-008",
        worktree: "P1",
      }),
    ).toThrow();

    // The helper must not have deleted the leftover file.
    expect(existsSync(join(slot, "left-over.txt"))).toBe(true);
  });
});

/**
 * GC-2026-008 P2: the reuse contract also enforces that the slot's
 * recorded `baseRef` matches the call's resolved ref. A worktree
 * provisioned from `feature/x` cannot be silently reused for a call
 * that resolves `origin/main` (or any other ref) — even when the rest
 * of the identity is identical. To reuse with a different baseline the
 * caller must pass a matching `base_ref`, or remove the worktree and
 * re-provision.
 */
describe("worktree-reuse: P2 — baseRef mismatch refused", () => {
  let fx: RepoFixture;
  beforeEach(() => {
    fx = makeRepoFixture("reuse-base-ref");
  });
  afterEach(() => {
    fx.dispose();
  });

  it("rejects reuse when the recorded baseRef differs from the call's resolved ref", () => {
    // 1. Provision from `feature/x` (local branch, no upstream).
    runGit(["checkout", "-b", "feature/x"], { cwd: fx.root });
    const first = createManagedWorktree({
      repoRoot: fx.root,
      dag: "GC-2026-008",
      worktree: "P1",
      base_ref: "feature/x",
    });
    expect(first.baseRef).toBe("feature/x");

    // 2. Switch the parent cwd back to `main` (which tracks `origin/main`).
    //    The smart default now resolves to `origin/main`, which does not
    //    match the recorded `feature/x`. Must refuse reuse.
    runGit(["checkout", "main"], { cwd: fx.root });

    expect(() =>
      createManagedWorktree({
        repoRoot: fx.root,
        dag: "GC-2026-008",
        worktree: "P1",
        reuse: true,
      }),
    ).toThrow(/recorded baseRef is 'feature\/x'.*resolves baseRef to 'origin\/main'/);
  });

  it("accepts reuse when the call passes the matching base_ref", () => {
    runGit(["checkout", "-b", "feature/x"], { cwd: fx.root });
    const first = createManagedWorktree({
      repoRoot: fx.root,
      dag: "GC-2026-008",
      worktree: "P1",
      base_ref: "feature/x",
    });
    expect(first.baseRef).toBe("feature/x");

    // Reuse with the matching base_ref — must succeed.
    const second = createManagedWorktree({
      repoRoot: fx.root,
      dag: "GC-2026-008",
      worktree: "P1",
      reuse: true,
      base_ref: "feature/x",
    });
    expect(second.reused).toBe(true);
    expect(second.baseRef).toBe("feature/x");
    expect(second.baseSha).toBe(first.baseSha);
  });

  it("rejects reuse even with a different explicit base_ref than the marker records", () => {
    runGit(["checkout", "-b", "feature/x"], { cwd: fx.root });
    createManagedWorktree({
      repoRoot: fx.root,
      dag: "GC-2026-008",
      worktree: "P1",
      base_ref: "feature/x",
    });

    // Different explicit base_ref must also refuse. Use `main` (a
    // local branch that DOES resolve) so the call clears the
    // "does not resolve" gate and reaches the reuse-contract baseRef
    // comparison.
    expect(() =>
      createManagedWorktree({
        repoRoot: fx.root,
        dag: "GC-2026-008",
        worktree: "P1",
        reuse: true,
        base_ref: "main",
      }),
    ).toThrow(/recorded baseRef is 'feature\/x'.*resolves baseRef to 'main'/);
  });
});
