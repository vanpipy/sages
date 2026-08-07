#!/usr/bin/env bun
/**
 * scripts/profile-worktree-async.ts — GC-2026-035 phase-4 baseline.
 *
 * Exercises the new async worktree provisioning path (Promise.all on
 * read-only pre-check, AbortController timeout) and reports the
 * phase-1/2/3 profile counters that phase-4 instrumentation now
 * attributes to the async path.
 *
 * Run from pi-subagents:
 *   SAGES_PI_PROFILE=1 timeout 30s bun run scripts/profile-worktree-async.ts
 */

// Enable the env-flagged profile before importing the module that caches it.
process.env.SAGES_PI_PROFILE = "1";

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

import {
	createManagedWorktreeAsync,
	inspectManagedWorktree,
	releaseManagedWorktree,
	runGitInAsync,
	_clearWorktreeLease as _unused_lease, // satisfy the linter if unused
} from "../src/worktree.js";
import {
	snapshot,
	_resetForTests,
	startSummary,
	stopSummary,
} from "../src/profile.js";

void _unused_lease; // referenced for type only; not used in this harness

const N = 10;
const parent = mkdtempSync(join(tmpdir(), "pi-baseline-"));
const work = join(parent, "work");
const origin = join(parent, "origin.git");

function execGit(args: string[], cwd: string): string {
	return execFileSync("git", args, {
		cwd,
		stdio: ["ignore", "pipe", "pipe"],
		timeout: 10_000,
	}).toString().trim();
}

function setupRepo() {
	execFileSync("git", ["init", "--bare", "-q", origin], { stdio: "ignore" });
	execFileSync("git", ["init", "-q", "-b", "main", work], { stdio: "ignore" });
	execGit(["config", "user.email", "baseline@pi"], work);
	execGit(["config", "user.name", "Baseline"], work);
	execGit(["config", "commit.gpgsign", "false"], work);
	execGit(["config", "remote.origin.url", origin], work);
	execGit(
		["config", "remote.origin.fetch", "+refs/heads/*:refs/remotes/origin/*"],
		work,
	);
	writeFileSync(join(work, "README.md"), "# baseline\n");
	execGit(["add", "."], work);
	execGit(["commit", "-q", "-m", "init"], work);
	execGit(["push", "-u", "origin", "main"], work);
}

async function main() {
	setupRepo();
	_resetForTests();
	startSummary();

	// Warm-up: a single sync call so V8 doesn't count JIT compilation.
	await createManagedWorktreeAsync({
		repoRoot: work,
		dag: "GC-2026-035",
		worktree: "warmup",
	});
	const t0 = Date.now();
	for (let i = 0; i < N; i++) {
		const id = `wt-${i.toString().padStart(2, "0")}`;
		const wt = await createManagedWorktreeAsync({
			repoRoot: work,
			dag: "GC-2026-035",
			worktree: id,
		});
		// Inspect + release to also exercise the sync/async mixed path.
		inspectManagedWorktree(wt);
		await releaseManagedWorktree(wt, { force: true });
	}
	const elapsed = Date.now() - t0;
	const snap = snapshot();

	// Drive a few read-only async calls too (T-ASYNC-01 / Promise.all cluster).
	const tRead = Date.now();
	await Promise.all(
		Array.from({ length: N }, () => runGitInAsync(["rev-parse", "HEAD"], work)),
	);
	const readElapsed = Date.now() - tRead;

	stopSummary();

	console.log("");
	console.log("=== GC-2026-035 phase-4 async worktree baseline ===");
	console.log(`Repo: ${work}  (${N} create+inspect+release cycles)`);
	console.log("");
	console.log(`create+inspect+release (${N} cycles): ${elapsed}ms (${(elapsed / N).toFixed(2)}ms/cycle)`);
	console.log(`Promise.all ${N} read-only rev-parse:    ${readElapsed}ms (${(readElapsed / N).toFixed(2)}ms/call avg in parallel)`);
	console.log("");
	console.log("--- phase-1 worktree counters (create path) ---");
	console.log(`worktree_create_count = ${snap.worktree_create_count}`);
	console.log(`worktree_create_ms_p50 = ${snap.worktree_create_ms_p50.toFixed(2)}`);
	console.log(`worktree_reuse_count = ${snap.worktree_reuse_count}`);
	console.log(`worktree_inspect_count = ${snap.worktree_inspect_count}`);
	console.log(`worktree_release_count = ${snap.worktree_release_count}`);
	console.log("");
	console.log("--- phase-1 git call counters ---");
	console.log(`git_call_count_create = ${snap.git_call_count_create}`);
	console.log(`git_call_count_inspect = ${snap.git_call_count_inspect}`);
	console.log(`git_call_count_release = ${snap.git_call_count_release}`);
	console.log(`git_call_count_total = ${snap.git_call_count_total}`);
	console.log("");
	console.log(`Average git calls per create+inspect+release cycle: ${(snap.git_call_count_total / N).toFixed(2)}`);

	rmSync(parent, { recursive: true, force: true });
}

await main();
