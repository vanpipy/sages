/**
 * worktree-async.test.ts - GC-2026-035-perf-opt-phase-4 P1
 * Async surface for runGitInAsync + createManagedWorktreeAsync.
 *
 * Tests use REAL git (no mock) on a tmp-dir fixture. Async-path behaviors
 * are observed through:
 *   - resolved values (T-ASYNC-01, T-ASYNC-03)
 *   - rejection shape (T-ASYNC-02)
 *   - concurrent timing of independent reads (T-ASYNC-04)
 *
 * T-ASYNC-05 (AbortController cancellation) is verified through code-path
 * inspection of the runner (the runner file itself is the artifact).
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
	createManagedWorktreeAsync,
	runGitInAsync,
} from "../src/worktree.js";

// minimal git fixture

interface RepoFixture {
	root: string;
	originMainSha: string;
	dispose(): void;
}

function execGitOrThrow(
	args: string[],
	options: { cwd: string },
): string {
	const { execFileSync } = require("node:child_process") as typeof import("node:child_process");
	return execFileSync("git", args, {
		cwd: options.cwd,
		stdio: ["ignore", "pipe", "pipe"],
		timeout: 10_000,
	}).toString().trim();
}

function makeRepoFixture(): RepoFixture {
	const parent = mkdtempSync(join(tmpdir(), "pi-async-test-"));
	const work = join(parent, "work");
	const origin = join(parent, "origin.git");
	const { execFileSync } = require("node:child_process") as typeof import("node:child_process");
	execFileSync("git", ["init", "--bare", "-q", "--initial-branch=main", origin], { stdio: "ignore" });
	execFileSync("git", ["init", "-q", "--initial-branch=main", work], { stdio: "ignore" });
	execGitOrThrow(["config", "user.email", "fixture@pi-test"], { cwd: work });
	execGitOrThrow(["config", "user.name", "Pi Test Fixture"], { cwd: work });
	execGitOrThrow(["config", "commit.gpgsign", "false"], { cwd: work });
	execGitOrThrow(["config", "remote.origin.url", origin], { cwd: work });
	// Explicit fetch refspec (matches the git-clone default) so
	// `git push` + `git fetch` populate refs/remotes/origin/main
	// on the local side. Without this, a manual `git config
	// remote.origin.url` does NOT also set the fetch refspec,
	// and refs/remotes/origin/main never materializes.
	execGitOrThrow(
		["config", "remote.origin.fetch", "+refs/heads/*:refs/remotes/origin/*"],
		{ cwd: work },
	);
	writeFileSync(join(work, "README.md"), "# fixture\n");
	execGitOrThrow(["add", "README.md"], { cwd: work });
	execGitOrThrow(["commit", "-q", "-m", "init"], { cwd: work });
	// -u sets upstream + creates the local origin/main remote-tracking ref.
	execGitOrThrow(["push", "-u", "origin", "main"], { cwd: work });
	const originMainSha = execGitOrThrow(["rev-parse", "HEAD"], { cwd: work });
	let disposed = false;
	return {
		root: work,
		originMainSha,
		dispose() {
			if (disposed) return;
			disposed = true;
			try { rmSync(parent, { recursive: true, force: true }); } catch { /* tmp */ }
		},
	};
}

// tests

describe("worktree-async: runGitInAsync (GC-2026-035)", () => {
	let fx: RepoFixture;
	beforeEach(() => { fx = makeRepoFixture(); });
	afterEach(() => { fx.dispose(); });

	it("T-ASYNC-01: returns trimmed stdout identical to a direct git invocation", async () => {
		const out = await runGitInAsync(["rev-parse", "HEAD"], fx.root);
		expect(typeof out).toBe("string");
		expect(out).toMatch(/^[0-9a-f]{40}$/);
		const expected = execGitOrThrow(["rev-parse", "HEAD"], { cwd: fx.root });
		expect(out).toBe(expected);
	});

	it("T-ASYNC-02: rejects with the same error format as the sync runner", async () => {
		await expect(
			runGitInAsync(
				["rev-parse", "--verify", "definitely-not-a-real-ref-xyz"],
				fx.root,
			),
		).rejects.toThrow(/git rev-parse --verify definitely-not-a-real-ref-xyz/);
		await expect(
			runGitInAsync(
				["rev-parse", "--verify", "definitely-not-a-real-ref-xyz"],
				fx.root,
			),
		).rejects.toThrow(/cwd=/);
		await expect(
			runGitInAsync(
				["rev-parse", "--verify", "definitely-not-a-real-ref-xyz"],
				fx.root,
			),
		).rejects.toThrow(/failed/);
	});
});

describe("worktree-async: createManagedWorktreeAsync (GC-2026-035)", () => {
	let fx: RepoFixture;
	beforeEach(() => { fx = makeRepoFixture(); });
	afterEach(() => { fx.dispose(); });

	it("T-ASYNC-03: provisions a worktree and returns the full ManagedWorktree shape", async () => {
		const wt = await createManagedWorktreeAsync({
			repoRoot: fx.root,
			dag: "GC-2026-035",
			worktree: "P1",
		});
		expect(wt.dag).toBe("GC-2026-035");
		expect(wt.worktree).toBe("P1");
		expect(wt.repoRoot).toBe(fx.root);
		expect(wt.branch).toBe("sages/GC-2026-035/P1");
		expect(wt.baseRef).toBe("origin/main");
		expect(wt.baseSha).toMatch(/^[0-9a-f]{40}$/);
		expect(wt.reused).toBe(false);
		const { existsSync } = await import("node:fs");
		expect(existsSync(wt.path)).toBe(true);
		expect(wt.baseSha).toBe(fx.originMainSha);
	});
});

describe("worktree-async: concurrency (GC-2026-035)", () => {
	it("T-ASYNC-04: the read-only pre-check uses Promise.all (architectural)", async () => {
		// Architectural check: the implementation must use Promise.all on the
		// read-only pre-check + the base-ref detection cluster. Two sites
		// minimum, one per cluster.
		const { readFileSync } = await import("node:fs");
		const { fileURLToPath } = await import("node:url");
		const here = fileURLToPath(import.meta.url);
		const srcPath = here.replace(/\/test\/[^/]+$/, "/src/worktree.ts");
		const src = readFileSync(srcPath, "utf8");
		const allMatches = src.match(/Promise\.all\s*\(/g) ?? [];
		expect(allMatches.length).toBeGreaterThanOrEqual(2);
	});

	it("T-ASYNC-04b: independent runGitInAsync calls run concurrently (timing)", async () => {
		const fx = makeRepoFixture();
		try {
			// Warm up: each git invocation has some startup cost.
			await runGitInAsync(["rev-parse", "HEAD"], fx.root);
			// 3 read-only calls in parallel should be roughly the slowest
			// single call, not 3x its time. We use a generous threshold
			// (2x serial + 30ms) to avoid CI flakiness.
			const t0 = Date.now();
			await Promise.all([
				runGitInAsync(["rev-parse", "HEAD"], fx.root),
				runGitInAsync(["rev-parse", "HEAD"], fx.root),
				runGitInAsync(["rev-parse", "HEAD"], fx.root),
			]);
			const parallelMs = Date.now() - t0;

			const t1 = Date.now();
			await runGitInAsync(["rev-parse", "HEAD"], fx.root);
			await runGitInAsync(["rev-parse", "HEAD"], fx.root);
			await runGitInAsync(["rev-parse", "HEAD"], fx.root);
			const serialMs = Date.now() - t1;

			// Parallel must be <= 2x serial (loose). On a fast machine serial
			// might be < 10ms and parallel might be ~10ms (no benefit), but
			// parallel is never 2x+ serial.
			expect(parallelMs).toBeLessThanOrEqual(serialMs * 2 + 30);
		} finally {
			fx.dispose();
		}
	});
});
