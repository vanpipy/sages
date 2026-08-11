import { execFileSync } from "node:child_process";
import {
	existsSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	rmSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { createManagedWorktree } from "../src/worktree.js";
import {
	verifyWorktreeOwnership,
	WorktreeGitPointerIsDirectory,
	WorktreeGitPointerMissing,
	WorktreeOwnershipMismatch,
} from "../src/worktree-ownership.js";
import { makeRepoFixture, type RepoFixture } from "./_fixture.js";

const FAKE_FIXTURE = join(
	import.meta.dirname,
	"fixtures",
	"worktree-ownership-fake.sh",
);

function runForeignFixture(): {
	repoRoot: string;
	foreignRoot: string;
	foreignWorktree: string;
	baseDir: string;
} {
	const baseDir = mkdtempSync(join(tmpdir(), "sages-ownership-"));
	const output = execFileSync("bash", [FAKE_FIXTURE, baseDir], {
		encoding: "utf8",
	});
	const [repoRoot, foreignRoot, foreignWorktree] = output.trim().split("\n");
	return { repoRoot, foreignRoot, foreignWorktree, baseDir };
}

afterEach(() => {
	// The tests use unique temp roots and clean their own roots in each test.
});

describe("verifyWorktreeOwnership", () => {
	test("accepts a fresh worktree belonging to the expected repository", () => {
		const fixture = runForeignFixture();
		try {
			const result = verifyWorktreeOwnership(
				fixture.foreignWorktree,
				fixture.foreignRoot,
			);
			expect(result.commondir).toBe(join(fixture.foreignRoot, ".git"));
			expect(result.gitdir).toContain(
				join(fixture.foreignRoot, ".git", "worktrees"),
			);
		} finally {
			rmSync(fixture.baseDir, { recursive: true, force: true });
		}
	});

	test("rejects a worktree whose gitdir belongs to a foreign clone", () => {
		const fixture = runForeignFixture();
		try {
			expect(() =>
				verifyWorktreeOwnership(fixture.foreignWorktree, fixture.repoRoot),
			).toThrow(WorktreeOwnershipMismatch);
			expect(() =>
				verifyWorktreeOwnership(fixture.foreignWorktree, fixture.repoRoot),
			).toThrow(
				new RegExp(
					`${fixture.repoRoot}.*${fixture.foreignRoot}|${fixture.foreignRoot}.*${fixture.repoRoot}`,
				),
			);
		} finally {
			rmSync(fixture.baseDir, { recursive: true, force: true });
		}
	});

	test("resolves the commondir fallback when the pointer has no commondir line", () => {
		const fixture = runForeignFixture();
		const fakeWorktree = join(fixture.baseDir, "pointer-without-commondir");
		const gitdir = join(fixture.repoRoot, ".git", "synthetic-worktree");
		try {
			mkdirSync(gitdir, { recursive: true });
			mkdirSync(fakeWorktree, { recursive: true });
			writeFileSync(join(fakeWorktree, ".git"), `gitdir: ${gitdir}\n`);
			const result = verifyWorktreeOwnership(fakeWorktree, fixture.repoRoot);
			expect(result.commondir).toBe(join(fixture.repoRoot, ".git"));
		} finally {
			rmSync(fixture.baseDir, { recursive: true, force: true });
		}
	});

	test("rejects a .git directory with a distinct pointer error", () => {
		const fixture = runForeignFixture();
		const fakeWorktree = join(fixture.baseDir, "git-directory");
		try {
			mkdirSync(join(fakeWorktree, ".git"), { recursive: true });
			expect(() =>
				verifyWorktreeOwnership(fakeWorktree, fixture.repoRoot),
			).toThrow(WorktreeGitPointerIsDirectory);
		} finally {
			rmSync(fixture.baseDir, { recursive: true, force: true });
		}
	});

	test("rejects a missing .git pointer with a distinct pointer error", () => {
		const fixture = runForeignFixture();
		const fakeWorktree = join(fixture.baseDir, "missing-git");
		try {
			mkdirSync(fakeWorktree, { recursive: true });
			expect(() =>
				verifyWorktreeOwnership(fakeWorktree, fixture.repoRoot),
			).toThrow(WorktreeGitPointerMissing);
		} finally {
			rmSync(fixture.baseDir, { recursive: true, force: true });
		}
	});

	test("canonicalizes a symlinked repository root", () => {
		const fixture = runForeignFixture();
		const alias = join(fixture.baseDir, "repo-alias");
		try {
			// `ln -s` is intentionally represented through Node's fs so this test
			// remains portable to the supported Unix test environments.
			execFileSync("ln", ["-s", fixture.repoRoot, alias]);
			const wt = join(fixture.repoRoot, "..", "repo-wt");
			execFileSync("git", [
				"-C",
				fixture.repoRoot,
				"worktree",
				"add",
				"--detach",
				wt,
				"HEAD",
			]);
			const result = verifyWorktreeOwnership(wt, alias);
			expect(result.commondir).toBe(join(fixture.repoRoot, ".git"));
		} finally {
			rmSync(fixture.baseDir, { recursive: true, force: true });
		}
	});

	test("uses canonical paths when both worktree and expected root arrive through aliases", () => {
		const fixture = runForeignFixture();
		const rootAlias = join(fixture.baseDir, "repo-alias-2");
		const worktreeAlias = join(fixture.baseDir, "foreign-wt-alias");
		try {
			execFileSync("ln", ["-s", fixture.foreignRoot, rootAlias]);
			execFileSync("ln", ["-s", fixture.foreignWorktree, worktreeAlias]);
			const result = verifyWorktreeOwnership(worktreeAlias, rootAlias);
			expect(result.commondir).toBe(join(fixture.foreignRoot, ".git"));
			expect(existsSync(join(worktreeAlias, ".git"))).toBe(true);
		} finally {
			rmSync(fixture.baseDir, { recursive: true, force: true });
		}
	});
});

describe("worktree integration call sites", () => {
	let fixture: RepoFixture;
	afterEach(() => fixture?.dispose());

	test("managed create and reuse both pass the ownership guard", () => {
		fixture = makeRepoFixture("ownership-managed");
		const created = createManagedWorktree({
			repoRoot: fixture.root,
			dag: "DAG",
			worktree: "T1",
		});
		const reused = createManagedWorktree({
			repoRoot: fixture.root,
			dag: "DAG",
			worktree: "T1",
			reuse: true,
		});
		expect(reused.reused).toBe(true);
		expect(reused.path).toBe(created.path);
	});
});

void dirname;
void lstatSync;
void unlinkSync;
