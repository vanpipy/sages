#!/usr/bin/env bun
/**
 * scripts/profile-worktree-sync.ts — baseline for the SYNC createManagedWorktree.
 * Companion to profile-worktree-async.ts. Same workload (N=10 cycles) so
 * the side-by-side numbers isolate the benefit of phase-4's async +
 * Promise.all parallelization.
 */

process.env.SAGES_PI_PROFILE = "1";

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

import {
	createManagedWorktree,
	inspectManagedWorktree,
	releaseManagedWorktree,
} from "../src/worktree.js";
import {
	snapshot,
	_resetForTests,
} from "../src/profile.js";

const N = 10;
const parent = mkdtempSync(join(tmpdir(), "pi-baseline-sync-"));
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

function main() {
	setupRepo();
	_resetForTests();

	// Warm-up.
	createManagedWorktree({
		repoRoot: work,
		dag: "GC-2026-035",
		worktree: "warmup",
	});
	const t0 = Date.now();
	for (let i = 0; i < N; i++) {
		const id = `wt-${i.toString().padStart(2, "0")}`;
		const wt = createManagedWorktree({
			repoRoot: work,
			dag: "GC-2026-035",
			worktree: id,
		});
		inspectManagedWorktree(wt);
		releaseManagedWorktree(wt, { force: true });
	}
	const elapsed = Date.now() - t0;
	const snap = snapshot();

	console.log("");
	console.log("=== GC-2026-035 SYNC baseline (same workload) ===");
	console.log(`create+inspect+release (${N} cycles): ${elapsed}ms (${(elapsed / N).toFixed(2)}ms/cycle)`);
	console.log("");
	console.log(`worktree_create_count = ${snap.worktree_create_count}`);
	console.log(`worktree_create_ms_p50 = ${snap.worktree_create_ms_p50.toFixed(2)}`);
	console.log(`git_call_count_create = ${snap.git_call_count_create}`);
	console.log(`git_call_count_total = ${snap.git_call_count_total}`);
	console.log(`Average git calls per cycle: ${(snap.git_call_count_total / N).toFixed(2)}`);

	rmSync(parent, { recursive: true, force: true });
}

main();
