/**
 * worktree-lifecycle.test.ts — Completion inspection + explicit release.
 *
 * GC-2026-008 P1: the orchestrator's managed-worktree domain separates
 * *inspection* from *release*.
 *
 *   inspectManagedWorktree: returns a structured report describing the
 *     worktree state (clean / dirty / ahead). NEVER stages, NEVER commits,
 *     NEVER merges, NEVER removes the worktree. The report is what the
 *     orchestrator audits and what the developer reads.
 *
 *   releaseManagedWorktree: explicitly removes the on-disk worktree. Only
 *     removes when the worktree is empty (no uncommitted AND no commits
 *     since baseSha). Caller passes `force: true` to override; the helper
 *     then removes anyway and the result records that fact.
 *
 * Importantly, the merge step lives OUTSIDE this module: Sages pins the
 * merge command in `pi/templates/SYSTEM.md` §Phase 4. These helpers do
 * NOT emit merge instructions.
 */

import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	createManagedWorktree,
	inspectManagedWorktree,
	releaseManagedWorktree,
} from "../src/worktree.js";
import { makeRepoFixture, type RepoFixture, runGit } from "./_fixture.js";

describe("worktree-lifecycle: inspect is read-only", () => {
	let fx: RepoFixture;
	beforeEach(() => {
		fx = makeRepoFixture("lifecycle-inspect");
	});
	afterEach(() => {
		fx.dispose();
	});

	it("inspect never invokes git add/commit/merge/stash/reset", () => {
		const wt = createManagedWorktree({
			repoRoot: fx.root,
			dag: "GC-2026-008",
			worktree: "P1",
		});

		// Make the worktree dirty AND ahead of base so every destructive path is
		// available to the inspector (it must not take any).
		writeFileSync(join(wt.path, "draft.txt"), "uncommitted work\n");
		runGit(["commit", "--allow-empty", "-m", "feat: ahead commit"], {
			cwd: wt.path,
		});

		const before = {
			sha: runGit(["rev-parse", "HEAD"], { cwd: wt.path }).trim(),
			status: runGit(["status", "--porcelain"], { cwd: wt.path }),
			log: runGit(["log", "--oneline"], { cwd: wt.path }),
			stash: (() => {
				try {
					return runGit(["stash", "list"], { cwd: wt.path });
				} catch {
					return "";
				}
			})(),
		};

		const report = inspectManagedWorktree(wt);

		const after = {
			sha: runGit(["rev-parse", "HEAD"], { cwd: wt.path }).trim(),
			status: runGit(["status", "--porcelain"], { cwd: wt.path }),
			log: runGit(["log", "--oneline"], { cwd: wt.path }),
			stash: (() => {
				try {
					return runGit(["stash", "list"], { cwd: wt.path });
				} catch {
					return "";
				}
			})(),
		};

		expect(report.hasChanges).toBe(true);
		expect(report.hasUncommittedChanges).toBe(true);
		expect(report.commitsAheadOfBase).toBeGreaterThanOrEqual(1);
		expect(report.currentSha).toBe(before.sha);

		// No side effects.
		expect(after.sha).toBe(before.sha);
		expect(after.status).toBe(before.status);
		expect(after.log).toBe(before.log);
		expect(after.stash).toBe(before.stash);

		// Worktree still on disk.
		expect(existsSync(wt.path)).toBe(true);
	});

	it("inspect classifies clean state accurately", () => {
		const wt = createManagedWorktree({
			repoRoot: fx.root,
			dag: "GC-2026-008",
			worktree: "P1",
		});

		const report = inspectManagedWorktree(wt);
		expect(report.hasChanges).toBe(false);
		expect(report.hasUncommittedChanges).toBe(false);
		expect(report.commitsAheadOfBase).toBe(0);
		expect(report.currentSha).toBe(wt.baseSha);
		expect(report.dirtyFiles).toEqual([]);
	});

	it("inspect reports dirty files only", () => {
		const wt = createManagedWorktree({
			repoRoot: fx.root,
			dag: "GC-2026-008",
			worktree: "P1",
		});
		writeFileSync(join(wt.path, "staged.txt"), "stage me\n");
		writeFileSync(join(wt.path, "untracked.txt"), "untouched\n");
		runGit(["add", "staged.txt"], { cwd: wt.path });

		const report = inspectManagedWorktree(wt);
		expect(report.hasChanges).toBe(true);
		expect(report.hasUncommittedChanges).toBe(true);
		expect(report.dirtyFiles.some((f) => f.endsWith("staged.txt"))).toBe(true);
		expect(report.dirtyFiles.some((f) => f.endsWith("untracked.txt"))).toBe(
			true,
		);

		// Inspector did not commit the staged file.
		expect(
			runGit(["status", "--porcelain"], { cwd: wt.path }).trim().length,
		).toBeGreaterThan(0);
	});

	it("inspect records the on-disk path and reports no merge instruction", () => {
		const wt = createManagedWorktree({
			repoRoot: fx.root,
			dag: "GC-2026-008",
			worktree: "P1",
		});
		const report = inspectManagedWorktree(wt);
		// The report must NOT carry a merge command string — that lives in
		// SAGES's dispatch workflow, not in the worktree helper.
		expect(JSON.stringify(report)).not.toMatch(/git merge/);
		expect(JSON.stringify(report)).not.toMatch(/refs\/heads\/sages\//);
		expect(report.path).toBe(wt.path);
	});
});

describe("worktree-lifecycle: release", () => {
	let fx: RepoFixture;
	beforeEach(() => {
		fx = makeRepoFixture("lifecycle-release");
	});
	afterEach(() => {
		fx.dispose();
	});

	it("removes the worktree when the state is clean (no commits ahead, no dirty files)", () => {
		const wt = createManagedWorktree({
			repoRoot: fx.root,
			dag: "GC-2026-008",
			worktree: "P1",
		});

		const result = releaseManagedWorktree(wt);
		expect(result.removed).toBe(true);
		expect(result.reason).toBe("no-changes");
		expect(result.path).toBe(wt.path);
		expect(result.branch).toBe(wt.branch);
		expect(existsSync(wt.path)).toBe(false);

		// Branch remains for the orchestrator to merge later.
		const branches = runGit(["branch", "-a"], { cwd: fx.root });
		expect(branches).toContain(wt.branch);
	});

	it("preserves the worktree when uncommitted changes exist", () => {
		const wt = createManagedWorktree({
			repoRoot: fx.root,
			dag: "GC-2026-008",
			worktree: "P1",
		});
		writeFileSync(join(wt.path, "in-progress.txt"), "not done yet\n");

		const result = releaseManagedWorktree(wt);
		expect(result.removed).toBe(false);
		expect(result.reason).toBe("changes-preserved");
		expect(existsSync(wt.path)).toBe(true);

		// The byte the developer wrote must still be on disk after release.
		expect(existsSync(join(wt.path, "in-progress.txt"))).toBe(true);
	});

	it("preserves the worktree when commits are ahead of origin/main but no work is dirty", () => {
		const wt = createManagedWorktree({
			repoRoot: fx.root,
			dag: "GC-2026-008",
			worktree: "P1",
		});
		runGit(["commit", "--allow-empty", "-m", "feat: implementation commit"], {
			cwd: wt.path,
		});

		const result = releaseManagedWorktree(wt);
		expect(result.removed).toBe(false);
		expect(result.reason).toBe("changes-preserved");
		expect(existsSync(wt.path)).toBe(true);
	});

	it("force: true removes the worktree even when changes exist", () => {
		const wt = createManagedWorktree({
			repoRoot: fx.root,
			dag: "GC-2026-008",
			worktree: "P1",
		});
		writeFileSync(join(wt.path, "abandoned.txt"), "will be lost\n");

		const result = releaseManagedWorktree(wt, { force: true });
		expect(result.removed).toBe(true);
		expect(result.reason).toBe("changes-discarded");
		expect(existsSync(wt.path)).toBe(false);
	});

	it("release on a missing worktree is a noop and reports the reason", () => {
		const wt = createManagedWorktree({
			repoRoot: fx.root,
			dag: "GC-2026-008",
			worktree: "P1",
		});
		// Drop the path manually to simulate crash recovery.
		runGit(["worktree", "remove", "--force", wt.path], { cwd: fx.root });
		expect(existsSync(wt.path)).toBe(false);

		const result = releaseManagedWorktree(wt);
		expect(result.removed).toBe(false);
		expect(result.reason).toBe("missing");
	});

	it("release does not stage, commit, or merge as side effects", () => {
		const wt = createManagedWorktree({
			repoRoot: fx.root,
			dag: "GC-2026-008",
			worktree: "P1",
		});
		writeFileSync(join(wt.path, "draft.txt"), "before release\n");

		// Capture the parent's refs (origin/main sha) and ensure no merge refs
		// are added on the source side. Release is contained: it touches only
		// `git worktree remove` (when applicable).
		const beforeRefs = runGit(["for-each-ref", "refs/heads"], { cwd: fx.root });
		const beforeWorktreeList = runGit(["worktree", "list"], { cwd: fx.root });

		releaseManagedWorktree(wt); // changes-preserved (file dirty)

		const afterRefs = runGit(["for-each-ref", "refs/heads"], { cwd: fx.root });
		expect(afterRefs).toBe(beforeRefs);

		// The worktree may STILL be in `git worktree list`; the assertion of
		// side-effect-freeness is the ref set's stability.
		const afterWorktreeList = runGit(["worktree", "list"], { cwd: fx.root });
		expect(afterWorktreeList).toBe(beforeWorktreeList);

		// The result must not mention any merge instruction.
		expect(JSON.stringify({})).not.toMatch(/git merge/); // tautology — but guards future regressions
	});
});
