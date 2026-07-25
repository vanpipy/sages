/**
 * worktree.ts — Git worktree isolation for agents.
 *
 * Two coexisting surfaces:
 *
 *  1. Ephemeral Agent-tool isolation (`createWorktree` / `cleanupWorktree`):
 *     a one-shot, tmpdir-backed copy used by `Agent` calls with
 *     `isolation: "worktree"`. Automatically commits any agent changes on
 *     teardown. Branch name is `pi-agent-<id>`.
 *
 *  2. Managed-worktree domain for the orchestrator (`*ManagedWorktree*`):
 *     the long-lived, repo-contained worktree the SAGES DAG orchestrator
 *     hands to each dispatched task. Provisioned at
 *     `<repoRoot>/.pi/worktree/<dag>/<worktree>` with branch
 *     `sages/<dag>/<worktree>`, derived from `origin/main`. The orchestrator
 *     owns inspection (`inspectManagedWorktree`) and release
 *     (`releaseManagedWorktree`); the helper never auto-stages, auto-commits,
 *     auto-merges, or auto-cleans a changed worktree. GC-2026-008 P1.
 */

import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
	existsSync,
	mkdirSync,
	readFileSync,
	realpathSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, normalize, relative, sep } from "node:path";

export interface WorktreeInfo {
	/** Absolute path to the worktree directory (the copied repo's root). */
	path: string;
	/** Branch name created for this worktree (if changes exist). */
	branch: string;
	/** Commit SHA that the worktree was created from. */
	baseSha: string;
	/**
	 * Where the agent should work inside the worktree: the equivalent of the
	 * cwd the worktree was created from. Equals `path` when that cwd was the
	 * repo root; points at the copied subdirectory when it was deeper (e.g. a
	 * monorepo package), so the requested scoping survives isolation.
	 */
	workPath: string;
}

export interface WorktreeCleanupResult {
	/** Whether changes were found in the worktree. */
	hasChanges: boolean;
	/** Branch name if changes were committed. */
	branch?: string;
	/** Worktree path if it was kept. */
	path?: string;
}

/**
 * Create a temporary git worktree for an agent.
 * Returns the worktree path, or undefined if not in a git repo.
 */
export function createWorktree(
	cwd: string,
	agentId: string,
): WorktreeInfo | undefined {
	// Verify we're in a git repo with at least one commit (HEAD must exist)
	let baseSha: string;
	let subdir: string;
	try {
		execFileSync("git", ["rev-parse", "--is-inside-work-tree"], {
			cwd,
			stdio: "pipe",
			timeout: 5000,
		});
		baseSha = execFileSync("git", ["rev-parse", "HEAD"], {
			cwd,
			stdio: "pipe",
			timeout: 5000,
		})
			.toString()
			.trim();
		// Where cwd sits inside the repo ("" at the root): the agent must work at
		// the same subdirectory inside the copy, or a monorepo-package cwd would
		// silently widen to the whole repo. realpath both sides — git emits
		// resolved paths while cwd may arrive through a symlink (macOS /tmp).
		const topLevel = execFileSync("git", ["rev-parse", "--show-toplevel"], {
			cwd,
			stdio: "pipe",
			timeout: 5000,
		})
			.toString()
			.trim();
		subdir = relative(realpathSync(topLevel), realpathSync(cwd));
	} catch {
		return undefined;
	}

	const branch = `pi-agent-${agentId}`;
	const suffix = randomUUID().slice(0, 8);
	const worktreePath = join(tmpdir(), `pi-agent-${agentId}-${suffix}`);

	try {
		// Create detached worktree at HEAD
		execFileSync("git", ["worktree", "add", "--detach", worktreePath, "HEAD"], {
			cwd,
			stdio: "pipe",
			timeout: 30000,
		});
		return {
			path: worktreePath,
			branch,
			baseSha,
			workPath: subdir ? join(worktreePath, subdir) : worktreePath,
		};
	} catch {
		// If worktree creation fails, return undefined (agent runs in normal cwd)
		return undefined;
	}
}

/**
 * Clean up a worktree after agent completion.
 * - If no changes: remove worktree entirely.
 * - If changes exist: create a branch, commit changes, return branch info.
 */
export function cleanupWorktree(
	cwd: string,
	worktree: WorktreeInfo,
	agentDescription: string,
): WorktreeCleanupResult {
	if (!existsSync(worktree.path)) {
		return { hasChanges: false };
	}

	try {
		// Check for uncommitted changes in the worktree
		const status = execFileSync("git", ["status", "--porcelain"], {
			cwd: worktree.path,
			stdio: "pipe",
			timeout: 10000,
		})
			.toString()
			.trim();

		if (status) {
			// Changes exist — stage, commit, and create a branch
			execFileSync("git", ["add", "-A"], {
				cwd: worktree.path,
				stdio: "pipe",
				timeout: 10000,
			});
			// Truncate description for commit message (no shell sanitization needed — execFileSync uses argv)
			const safeDesc = agentDescription.slice(0, 200);
			const commitMsg = `pi-agent: ${safeDesc}`;
			execFileSync("git", ["commit", "--no-verify", "-m", commitMsg], {
				cwd: worktree.path,
				stdio: "pipe",
				timeout: 10000,
			});
		} else {
			const currentSha = execFileSync("git", ["rev-parse", "HEAD"], {
				cwd: worktree.path,
				stdio: "pipe",
				timeout: 5000,
			})
				.toString()
				.trim();

			if (currentSha === worktree.baseSha) {
				// No changes — remove worktree
				removeWorktree(cwd, worktree.path);
				return { hasChanges: false };
			}
		}

		// Create a branch pointing to the worktree's HEAD.
		// If the branch already exists, append a suffix to avoid overwriting previous work.
		let branchName = worktree.branch;
		try {
			execFileSync("git", ["branch", branchName], {
				cwd: worktree.path,
				stdio: "pipe",
				timeout: 5000,
			});
		} catch {
			// Branch already exists — use a unique suffix
			branchName = `${worktree.branch}-${Date.now()}`;
			execFileSync("git", ["branch", branchName], {
				cwd: worktree.path,
				stdio: "pipe",
				timeout: 5000,
			});
		}
		// Update branch name in worktree info for the caller
		worktree.branch = branchName;

		// Remove the worktree (branch persists in main repo)
		removeWorktree(cwd, worktree.path);

		return {
			hasChanges: true,
			branch: worktree.branch,
			path: worktree.path,
		};
	} catch {
		// Best effort cleanup on error
		try {
			removeWorktree(cwd, worktree.path);
		} catch {
			/* ignore */
		}
		return { hasChanges: false };
	}
}

/**
 * Force-remove a worktree.
 */
function removeWorktree(cwd: string, worktreePath: string): void {
	try {
		execFileSync("git", ["worktree", "remove", "--force", worktreePath], {
			cwd,
			stdio: "pipe",
			timeout: 10000,
		});
	} catch {
		// If git worktree remove fails, try pruning
		try {
			execFileSync("git", ["worktree", "prune"], {
				cwd,
				stdio: "pipe",
				timeout: 5000,
			});
		} catch {
			/* ignore */
		}
	}
}

/**
 * Prune any orphaned worktrees (crash recovery).
 */
export function pruneWorktrees(cwd: string): void {
	try {
		execFileSync("git", ["worktree", "prune"], {
			cwd,
			stdio: "pipe",
			timeout: 5000,
		});
	} catch {
		/* ignore */
	}
}

// ---------------------------------------------------------------------------
// §Managed-worktree domain (GC-2026-008 P1)
// ---------------------------------------------------------------------------
//
// The SAGES orchestrator hands each dispatched task an isolated git worktree
// contained inside its repository. The constraint set is stricter than the
// Agent-tool isolation path above:
//
//   * the worktree lives at <repoRoot>/.pi/worktree/<dag>/<worktree> — never
//     in tmpdir(), never in /var, never anywhere else
//   * identity (`<dag>` / `<worktree>`) is validated up front — no path
//     separators, no `..`, no leading dot
//   * the base ref is always `origin/main` — never local HEAD, never
//     detached floating — and missing bases throw (no silent fallback)
//   * the helper itself NEVER stages, NEVER commits, NEVER merges, NEVER
//     emits a merge instruction, and NEVER removes a worktree that has
//     changes without an explicit `{ force: true }` from the caller
//   * release is a separate, explicit operation; the orchestrator decides
//     when — usually after `software-auditor` has run its checks

/**
 * Identifier components for a managed worktree. Both must pass
 * {@link validateIdentity} before any on-disk operation runs.
 */
export interface ManagedWorktreeIdentity {
	/** Goal / DAG id, e.g. `GC-2026-008`. */
	dag: string;
	/** Task / worktree id within the DAG, e.g. `P1`. */
	worktree: string;
}

/** Identifier regex: `[A-Za-z0-9_-]`, must be non-empty. Captured as a single
 * segment so both halves go through one constraint surface. */
const IDENTITY_RE = /^[A-Za-z0-9_-]+$/;

/** Marker file RELATIVE PATH inside the marker directory. */
export const MANAGED_WORKTREE_MARKER = ".pi-worktree.json";

/**
 * Build the marker path for a managed worktree. The marker MUST live OUTSIDE
 * the worktree itself: writing it inside `<worktree>/.pi-worktree.json`
 * would make the worktree dirty (`git status` would show it as untracked),
 * which would corrupt `inspectManagedWorktree`'s hasChanges signal.
 *
 * Shape: `<repoRoot>/.pi/worktree-state/<dag>/<worktree>.json`
 *
 * Same `.pi/` containment rules as the worktree itself: structural identity
 * is enforced by `validateIdentity` before any path is built.
 */
export function markerPath(
	repoRoot: string,
	dag: string,
	worktree: string,
): string {
	validateIdentity(dag, worktree);
	return join(repoRoot, ".pi", "worktree-state", dag, `${worktree}.json`);
}

/**
 * Persistent identity record. Written on first provision; read back at reuse
 * to confirm identity and to pin the originally recorded `baseSha` (origin/main
 * advances over time; the worktree should NOT silently follow).
 */
export interface ManagedWorktreeMarker {
	schema: 1;
	repoRoot: string;
	dag: string;
	worktree: string;
	path: string; // absolute worktree path (informational)
	branch: string;
	baseSha: string;
	baseRef: "origin/main";
	createdAt: number; // epoch ms
}

/** Read the marker for a given (repoRoot, dag, worktree) tuple, else null.
 *
 * Returns null if any component of the marker path doesn't resolve or the
 * JSON is missing/invalid. Callers must never silently fall back — a missing
 * marker IS a "needs verification" signal at the API boundary. */
export function readManagedWorktreeMarker(
	repoRoot: string,
	dag: string,
	worktree: string,
): ManagedWorktreeMarker | null {
	const fp = markerPath(repoRoot, dag, worktree);
	if (!existsSync(fp)) return null;
	try {
		const raw = readFileSync(fp, "utf8");
		const parsed = JSON.parse(raw) as ManagedWorktreeMarker;
		if (parsed && parsed.schema === 1) return parsed;
	} catch {
		// fall through
	}
	return null;
}

function writeManagedWorktreeMarker(marker: ManagedWorktreeMarker): void {
	const fp = markerPath(marker.repoRoot, marker.dag, marker.worktree);
	// The marker lives at `<repoRoot>/.pi/worktree-state/<dag>/<worktree>.json`;
	// the intermediate directories are repo-level state and are NOT created by
	// `git worktree add`. Create them on demand so the first provision on a
	// fresh repo doesn't fail with ENOENT. Idempotent under `{ recursive: true }`.
	mkdirSync(dirname(fp), { recursive: true });
	writeFileSync(fp, JSON.stringify(marker, null, 2), "utf8");
}

/** Remove the marker for a managed worktree. Idempotent. */
export function deleteManagedWorktreeMarker(
	repoRoot: string,
	dag: string,
	worktree: string,
): void {
	const fp = markerPath(repoRoot, dag, worktree);
	try {
		if (existsSync(fp)) {
			unlinkSync(fp);
		}
	} catch {
		// ignore — marker is a state-record; a leaked file is harmless
	}
}

/** Validate the `(dag, worktree)` tuple. Throws on any structural problem. */
export function validateIdentity(dag: string, worktree: string): void {
	for (const [name, value] of [
		["dag", dag],
		["worktree", worktree],
	] as const) {
		if (typeof value !== "string") {
			throw new Error(
				`managed-worktree: ${name} must be a string (got ${typeof value})`,
			);
		}
		if (value.length === 0) {
			throw new Error(`managed-worktree: ${name} must not be empty`);
		}
		if (value !== value.trim()) {
			throw new Error(
				`managed-worktree: ${name} must not contain leading/trailing whitespace (got ${JSON.stringify(value)})`,
			);
		}
		if (!IDENTITY_RE.test(value)) {
			throw new Error(
				`managed-worktree: ${name} ${JSON.stringify(value)} is not a safe path segment ` +
					`(only [A-Za-z0-9_-] allowed; reject '/', '\\\\', '..', '.', whitespace)`,
			);
		}
	}
}

/** Result of provisioning a managed worktree. The fields are stable across
 * calls and reused across calls (so the orchestrator can compare results
 * from a re-enter).
 */
export interface ManagedWorktree extends ManagedWorktreeIdentity {
	/** Absolute path to the on-disk worktree, after realpath normalization. */
	path: string;
	/** Branch checked out in the worktree. Always `sages/<dag>/<worktree>`. */
	branch: string;
	/** sha of the commit the worktree was provisioned from (pinned at first provision). */
	baseSha: string;
	/** The ref the worktree was provisioned from. Always `origin/main`. */
	baseRef: "origin/main";
	/** Repo root hosting `.pi/worktree/<dag>/<worktree>`. */
	repoRoot: string;
	/** True when the helper re-entered an existing managed worktree. */
	reused: boolean;
}

export interface CreateManagedWorktreeOptions extends ManagedWorktreeIdentity {
	/** Repo root. Used as the cwd for every `git` invocation. */
	repoRoot: string;
	/**
	 * Re-enter an existing managed worktree at the same `(dag, worktree)`
	 * slot instead of throwing. Identity checks (`branch`, `baseSha`,
	 * `repoRoot`) still apply — a tampered worktree is refused.
	 */
	reuse?: boolean;
	/**
	 * Run `git fetch origin main` before resolving the base ref. Default:
	 * `true` so the helper always provisions from the latest `origin/main`.
	 * Set to `false` for offline tests or tooling that controls fetching.
	 */
	fetch?: boolean;
}

export interface ManagedWorktreeInspection {
	/** Path of the inspected worktree. */
	path: string;
	/** Branch checked out in the worktree. */
	branch: string;
	/** SHA recorded at provision time. */
	baseSha: string;
	/** Current HEAD SHA. */
	currentSha: string;
	/** True when the worktree has dirty files OR commits ahead of base. */
	hasChanges: boolean;
	/** True when `git status --porcelain` is non-empty in the worktree. */
	hasUncommittedChanges: boolean;
	/** Commits between `baseSha..HEAD` (forward count). */
	commitsAheadOfBase: number;
	/** Files `git status --porcelain` reports as dirty, relative paths. */
	dirtyFiles: string[];
}

export interface ManagedWorktreeReleaseOptions {
	/** Remove even when the worktree has changes. Caller owns the consequences. */
	force?: boolean;
}

export type ManagedWorktreeReleaseReason =
	| "no-changes"
	| "changes-preserved"
	| "changes-discarded"
	| "missing";

export interface ManagedWorktreeReleaseResult {
	path: string;
	branch: string;
	/** True when the worktree was actually removed from disk. */
	removed: boolean;
	/** Why the helper behaved as it did. */
	reason: ManagedWorktreeReleaseReason;
}

/**
 * Build the canonical path `<repoRoot>/.pi/worktree/<dag>/<worktree>` and
 * realpath it on both sides. The realpath comparison is defense-in-depth —
 * `validateIdentity` already rejects any character that could escape, but if
 * a future change relaxes identity constraints this guard catches it.
 *
 * If `<repoRoot>` doesn't exist on disk yet (rare; this is a pure path
 * builder, it does NOT need a real repo to compute a path), we skip realpath
 * and rely on identity validation + the `relative()` containment check on
 * the normalized path.
 */
export function worktreePath(
	repoRoot: string,
	dag: string,
	worktree: string,
): string {
	validateIdentity(dag, worktree);
	let realRoot: string;
	try {
		realRoot = realpathSync(repoRoot);
	} catch (err: any) {
		if (err?.code === "ENOENT") {
			realRoot = normalize(repoRoot);
		} else {
			throw err;
		}
	}
	const candidate = normalize(join(realRoot, ".pi", "worktree", dag, worktree));
	// Containment: `<candidate>` must live under `<realRoot>/`. Symlink-aware.
	const rel = relative(realRoot, candidate);
	if (rel === "" || rel.startsWith("..") || rel.startsWith(sep)) {
		throw new Error(
			`managed-worktree: path ${candidate} escapes repoRoot ${realRoot}`,
		);
	}
	return candidate;
}

/** The branch carried by every managed worktree: `sages/<dag>/<worktree>`. */
export function branchName(dag: string, worktree: string): string {
	validateIdentity(dag, worktree);
	return `sages/${dag}/${worktree}`;
}

/**
 * Provision a managed worktree at `<repoRoot>/.pi/worktree/<dag>/<worktree>`,
 * branched as `sages/<dag>/<worktree>` from `origin/main`.
 *
 * Throws on:
 *   - any identity-validation failure
 *   - `<repoRoot>` not a git repository (or is the bare `origin/`)
 *   - `origin/main` missing (NO silent fallback to HEAD or main)
 *   - the target path already occupied and `reuse: true` not supplied, or
 *     `reuse: true` but identity/branch/baseSha don't match what this call
 *     expects
 */
export function createManagedWorktree(
	opts: CreateManagedWorktreeOptions,
): ManagedWorktree {
	validateIdentity(opts.dag, opts.worktree);
	let realRoot: string;
	try {
		realRoot = realpathSync(opts.repoRoot);
	} catch (err: any) {
		if (err?.code === "ENOENT") {
			throw new Error(
				`managed-worktree: ${opts.repoRoot} does not exist on disk`,
			);
		}
		throw err;
	}
	// Pre-condition: `<repoRoot>` must be a git working tree (not a bare repo).
	// `--is-inside-work-tree` is exactly the predicate git uses for this.
	try {
		runGitIn(["rev-parse", "--is-inside-work-tree"], realRoot);
	} catch {
		throw new Error(
			`managed-worktree: ${realRoot} is not a git working tree (provide a repository working copy, not a bare repo or random directory)`,
		);
	}
	// Bare-repo safety net: even if `--is-inside-work-tree` slips, refuse when the
	// common-dir is itself (which signals bare).
	let commonDir: string;
	try {
		commonDir = runGitIn(["rev-parse", "--git-common-dir"], realRoot);
	} catch {
		throw new Error(
			`managed-worktree: cannot resolve git common dir for ${realRoot}`,
		);
	}
	if (normalize(commonDir) === normalize(realRoot)) {
		throw new Error(
			`managed-worktree: ${realRoot} is a bare repository; managed worktrees need a working tree`,
		);
	}

	// Fetch latest origin/main unless caller opts out.
	const fetchEnabled = opts.fetch !== false;
	if (fetchEnabled) {
		// Best-effort: a network failure must NOT silently degrade to a stale
		// base. Re-throw unless the remote is genuinely unavailable (e.g.
		// fixture repos). For now, ALWAYS fetch: stale bases are worse than
		// explicit fetch errors.
		try {
			runGitIn(["fetch", "--no-tags", "origin", "main"], realRoot);
		} catch (err) {
			throw new Error(
				`managed-worktree: 'git fetch origin main' failed in ${realRoot}: ${formatGitErr(err)}. ` +
					`Provision refuses to proceed on stale 'origin/main'.`,
			);
		}
	}

	// Resolve base ref — NEVER fall back. Missing ref => throw.
	let baseSha: string;
	try {
		baseSha = runGitIn(["rev-parse", "--verify", "origin/main"], realRoot);
	} catch {
		throw new Error(
			`managed-worktree: 'origin/main' does not resolve in ${realRoot}. ` +
				`Provision refuses to fall back to local HEAD — create a 'main' branch on 'origin' first.`,
		);
	}

	const path = worktreePath(realRoot, opts.dag, opts.worktree);
	const branch = branchName(opts.dag, opts.worktree);

	// Pre-check: if a path already exists at the target, decide reuse-vs-error.
	const pathExists = existsSync(path);
	if (pathExists) {
		if (!opts.reuse) {
			throw new Error(
				`managed-worktree: target ${path} already exists. ` +
					`Pass { reuse: true } to re-enter an existing managed worktree, or remove it first.`,
			);
		}
		// reuse: true — verify the persisted marker matches what this call
		// expects AND that the branch has NOT been advanced beyond the recorded
		// baseSha (a parallel actor rewrote the branch; reuse refuses).
		return reuseManagedWorktree({
			repoRoot: realRoot,
			dag: opts.dag,
			worktree: opts.worktree,
			path,
			branch,
			recordedBaseSha: baseSha,
		});
	}

	// Fresh provision: create the worktree as a detached checkout at origin/main,
	// then promote to the `sages/...` branch. Doing the branch promotion AFTER
	// the worktree is registered keeps the worktree list semantically meaningful
	// (the user's branch is visible immediately after create returns).
	// The `<path>` must NOT exist already (checked above) — `git worktree add`
	// creates it. We create the parent `.pi/worktree/<dag>/` directory lazily.
	runGitIn(["worktree", "add", "--detach", path, "origin/main"], realRoot);
	runGitIn(["checkout", "-B", branch], path);

	// Persist identity marker so subsequent reuse re-enters deterministically.
	const marker: ManagedWorktreeMarker = {
		schema: 1,
		repoRoot: realRoot,
		dag: opts.dag,
		worktree: opts.worktree,
		path,
		branch,
		baseSha,
		baseRef: "origin/main",
		createdAt: Date.now(),
	};
	writeManagedWorktreeMarker(marker);

	return {
		path,
		branch,
		baseSha,
		baseRef: "origin/main",
		dag: opts.dag,
		worktree: opts.worktree,
		repoRoot: realRoot,
		reused: false,
	};
}

function reuseManagedWorktree(args: {
	repoRoot: string;
	dag: string;
	worktree: string;
	path: string;
	branch: string;
	/** The freshly-resolved origin/main sha. Kept for parity with the create
	 *  call site; the reuse contract does NOT use it to refresh state. */
	recordedBaseSha: string;
}): ManagedWorktree {
	const {
		repoRoot,
		dag,
		worktree,
		path,
		branch,
		recordedBaseSha: _recordedBaseSha,
	} = args;
	void _recordedBaseSha;

	// 1. Read the persisted marker. Mismatch on any of (repoRoot, dag,
	//    worktree, branch) is a refusal — a different managed worktree owns
	//    this slot.
	const marker = readManagedWorktreeMarker(repoRoot, dag, worktree);
	if (!marker) {
		throw new Error(
			`managed-worktree: cannot reuse ${path} — no .pi-worktree.json marker was found. ` +
				`The slot may have been provisioned by a different process. ` +
				`Remove the path manually before retrying.`,
		);
	}
	for (const [field, expected] of [
		["repoRoot", repoRoot],
		["dag", dag],
		["worktree", worktree],
		["branch", branch],
	] as const) {
		if (marker[field] !== expected) {
			throw new Error(
				`managed-worktree: cannot reuse ${path} — persisted marker field '${field}' is '${marker[field]}', ` +
					`expected '${expected}'. The slot is owned by a different identity.`,
			);
		}
	}

	// 2. Reuse contract: the branch on disk MUST still point at the recorded
	//    baseSha AND be on the recorded branch name. Any of the following is
	//    a refusal:
	//
	//      a. HEAD is detached / on a different branch (parallel checkout)
	//      b. The branch tip moved past baseSha (developer did work or a
	//         stale caller force-pushed) — reuse is NOT for "re-enter my
	//         in-progress worktree"; it's for "re-enter my untouched slot".
	//         A branch advanced by the developer is still recoverable, but
	//         only after an explicit decision the orchestrator makes — not
	//         silently through `reuse: true`.
	const currentBranch = runGitIn(["rev-parse", "--abbrev-ref", "HEAD"], path);
	if (currentBranch !== branch) {
		throw new Error(
			`managed-worktree: cannot reuse ${path} — the worktree's HEAD branch is '${currentBranch}', ` +
				`expected branch identity '${branch}'. Reuse refuses: a parallel checkout switched branch identity, ` +
				`or the worktree was set up under a different branch identity. Switch back to '${branch}' ` +
				`at '${marker.baseSha}' to reuse, or refuse reuse.`,
		);
	}
	const currentSha = runGitIn(["rev-parse", "HEAD"], path);
	if (currentSha !== marker.baseSha) {
		throw new Error(
			`managed-worktree: cannot reuse ${path} — branch tip ${currentSha} moved past recorded baseSha ${marker.baseSha}. ` +
				`The branch has been advanced or rewritten. Reuse refuses; audit the branch or remove the worktree and re-provision.`,
		);
	}

	// 2b. Even when the LOCAL branch tip is untouched, the REMOTE branch
	//     may have been force-pushed / rewritten by a parallel actor. Pull the
	//     remote-tracking ref and refuse reuse if it has diverged ahead of
	//     `marker.baseSha` (an unrelated history rewrite would also differ —
	//     either way the worktree's branch identity no longer maps 1:1 to the
	//     recorded base).
	//
	//     If the remote ref does not exist locally (the branch was never
	//     pushed, or `git fetch` cannot resolve it) we treat the local copy
	//     as the source of truth and skip the check. This keeps the contract
	//     usable in pure-local workflow / test fixtures where the branch
	//     lives only inside the worktree's gitdir link.
	(() => {
		let divergence: string | null = null;
		try {
			runGitIn(["fetch", "--no-tags", "origin", branch], repoRoot);
			const remoteSha = runGitIn(
				["rev-parse", "--verify", `origin/${branch}`],
				repoRoot,
				false /* throw on empty */,
				false /* don't throw on missing ref */,
			);
			if (remoteSha && remoteSha !== marker.baseSha) {
				divergence = remoteSha;
			}
		} catch {
			// Remote fetch failed / no tracking ref — local is source of truth.
			// This is benign: branches that were never pushed simply have no
			// `origin/<branch>` to compare against.
		}
		if (divergence !== null) {
			throw new Error(
				`managed-worktree: cannot reuse ${path} — remote branch origin/${branch} at ${divergence} ` +
					`diverged from recorded baseSha ${marker.baseSha}. The branch has been rewritten upstream. ` +
					`Reuse refuses; audit the branch or remove the worktree and re-provision.`,
			);
		}
	})();

	// 3. Reuse succeeds. baseSha is pinned at marker.baseSha so subsequent
	//    inspections compute "commits ahead of baseSha" reproducibly,
	//    regardless of how origin/main has moved in the meantime.
	return {
		path,
		branch,
		baseSha: marker.baseSha,
		baseRef: "origin/main",
		dag,
		worktree,
		repoRoot,
		reused: true,
	};
}

/**
 * Inspect a managed worktree — pure read against `git status` + `git rev-parse`.
 *
 * NEVER stages. NEVER commits. NEVER merges. NEVER removes the worktree.
 * Idempotent under arbitrary state.
 */
export function inspectManagedWorktree(
	wt: ManagedWorktree,
): ManagedWorktreeInspection {
	if (!existsSync(wt.path)) {
		throw new Error(
			`managed-worktree: cannot inspect ${wt.path} — path no longer exists`,
		);
	}
	// Capture everything before any git call so a buggy future change can't sneak
	// mutation into the inspector.
	const porcelain = runGitIn(
		["status", "--porcelain"],
		wt.path,
		true /* allowEmpty */,
	);
	const currentSha = runGitIn(["rev-parse", "HEAD"], wt.path);
	let commitsAhead = 0;
	try {
		const count = runGitIn(
			["rev-list", "--count", `${wt.baseSha}..HEAD`],
			wt.path,
			true,
		);
		commitsAhead = Number.parseInt(count.trim(), 10);
		if (!Number.isFinite(commitsAhead)) commitsAhead = 0;
	} catch {
		commitsAhead = 0;
	}
	const dirtyFiles = porcelain
		.split("\n")
		.map((line) => line.replace(/^[ MADU?!]{2} /, "").trim())
		.filter((line) => line.length > 0);

	return {
		path: wt.path,
		branch: wt.branch,
		baseSha: wt.baseSha,
		currentSha,
		hasChanges: porcelain.trim().length > 0 || commitsAhead > 0,
		hasUncommittedChanges: porcelain.trim().length > 0,
		commitsAheadOfBase: commitsAhead,
		dirtyFiles,
	};
}

/**
 * Explicitly release the on-disk worktree. Refuses to drop a worktree that
 * has changes unless `force: true` is passed.
 */
export function releaseManagedWorktree(
	wt: ManagedWorktree,
	opts: ManagedWorktreeReleaseOptions = {},
): ManagedWorktreeReleaseResult {
	const { path, branch } = wt;

	if (!existsSync(path)) {
		return { path, branch, removed: false, reason: "missing" };
	}

	// Inspect first (pure read) to drive the decision.
	let inspection: ManagedWorktreeInspection;
	try {
		inspection = inspectManagedWorktree(wt);
	} catch {
		// If inspect itself fails, defer to the caller — report preserved.
		return { path, branch, removed: false, reason: "changes-preserved" };
	}

	if (inspection.hasChanges && !opts.force) {
		return { path, branch, removed: false, reason: "changes-preserved" };
	}

	// Removal path — only reached when (a) no changes, or (b) force: true.
	// `git worktree remove` returns empty stdout on success — the default is
	// `allowEmptyStdout = true`, so we pass nothing else explicitly.
	runGitIn(["worktree", "remove", "--force", path], wt.repoRoot);
	// Best-effort marker cleanup. A leaked marker file is harmless
	// (subsequent reuse calls just throw "identity mismatch" because the
	// on-disk worktree will be gone), but a clean release also tidies the
	// repoRoot state directory.
	deleteManagedWorktreeMarker(wt.repoRoot, wt.dag, wt.worktree);
	return {
		path,
		branch,
		removed: true,
		reason:
			inspection.hasChanges && opts.force ? "changes-discarded" : "no-changes",
	};
}

// ----- internal git runners -----

/**
 * Default per-call timeout for every `git` invocation. Bounded so a hung git
 * (e.g. credential prompt, NFS hitch) can't hang the orchestrator's dispatch
 * path; call sites that need different limits can wrap their own runner.
 */
const GIT_TIMEOUT_MS_DEFAULT = 15_000;

/**
 * Run `git <args>` in `cwd`, returning the stdout string with leading/trailing
 * whitespace stripped. On failure throws an `Error` whose message includes the
 * command and stderr so a stack trace points straight at the failing call.
 *
 * Many git commands legitimately print nothing on success (`git fetch`,
 * `git checkout -B`, `worktree add`, `worktree remove`, `status --porcelain`
 * when the tree is clean). Empty stdout is therefore NOT treated as an error
 * by default — errors come from git's own exit code (thrown by
 * `execFileSync`). Pass `allowEmptyStdout = false` for the rare caller that
 * specifically wants `""` to fail.
 */
function runGitIn(
	args: string[],
	cwd: string,
	allowEmptyStdout = true,
	allowThrow = true,
): string {
	let out: Buffer;
	try {
		const result = execFileSync("git", args, {
			cwd,
			stdio: ["ignore", "pipe", "pipe"],
			timeout: GIT_TIMEOUT_MS_DEFAULT,
		});
		out = result instanceof Buffer ? result : Buffer.from(String(result));
	} catch (err: unknown) {
		if (!allowThrow) return "";
		throw formatGitInvocationError(args, cwd, err);
	}
	const str = out.toString();
	if (!allowEmptyStdout && str.trim().length === 0) {
		throw new Error(
			`git ${args.join(" ")} (cwd=${cwd}) returned empty stdout unexpectedly`,
		);
	}
	return str.trim();
}

function formatGitInvocationError(
	args: string[],
	cwd: string,
	err: unknown,
): Error {
	const anyErr = err as {
		stderr?: Buffer | string;
		stdout?: Buffer | string;
		message?: string;
	};
	const stderr = anyErr?.stderr ? anyErr.stderr.toString().trim() : "";
	const stdout = anyErr?.stdout ? anyErr.stdout.toString().trim() : "";
	const detail = stderr || stdout || anyErr?.message || String(err);
	return new Error(`git ${args.join(" ")} (cwd=${cwd}) failed: ${detail}`);
}

function formatGitErr(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

// ---------------------------------------------------------------------------
// §GC-2026-008 P2 — host-owned lease + delete surfaces for the Agent boundary
// ---------------------------------------------------------------------------
//
// The managed-worktree domain has two outbound surfaces the Agent manager
// needs to call:
//
//   1. A lease, so two concurrent spawns of the same (dag, worktree) slot
//      are rejected with a clear error. This is process-local: the
//      orchestrator dispatches from a single parent session, so an in-memory
//      lock is enough — and far cheaper than round-tripping through git or
//      writing to disk. `acquireManagedWorktreeLease` and
//      `releaseManagedWorktreeLease` give callers an opaque token they can
//      embed in handoff metadata and pass to the release path.
//
//   2. An explicit delete path that's "host-owned": removes the on-disk
//      worktree, deletes the marker, optionally deletes the branch, and
//      refuses to escape `.pi/worktree`. The merge step lives elsewhere
//      (Sages pins it in `pi/templates/SYSTEM.md`) so this helper emits no
//      `git merge` instruction.
//
// `releaseManagedWorktree` (above) is the agent-cleanup path; `deleteManagedWorktree`
// (below) is the host-owned release. They differ in two ways:
//
//   - The agent cleanup refuses to drop a worktree with changes unless
//     `force: true` (the orchestrator mustn't lose commits). The host
//     release does not check for changes — the host owns the decision and
//     just needs the worktree gone.
//   - The agent cleanup never deletes the branch (branches outlive the
//     worktree). The host release takes an explicit `deleteBranch` opt-in.

/**
 * Opaque lease handle returned by {@link acquireManagedWorktreeLease}. The
 * token is also stored on the handoff metadata so callers can refer to it
 * later (the Agent manager reuses it on release).
 */
export interface ManagedWorktreeLease {
	token: string;
	dag: string;
	worktree: string;
}

const LEASE_TOKENS = new Map<string, ManagedWorktreeLease>(); // token -> lease

/**
 * Acquire an exclusive lease on the (dag, worktree) slot. If another call
 * already holds it, throws an error naming the path so the caller knows
 * exactly which slot collided.
 *
 * The lease is held by the Agent manager for the duration of one spawn. It
 * survives across get_subagent_result / steer_subagent / resume because those
 * operations reuse the same record. The host releases the lease when the
 * managed worktree is dropped (or the parent session ends).
 *
 * Process-local by design — see the section header for rationale.
 */
export function acquireManagedWorktreeLease(
	dag: string,
	worktree: string,
): ManagedWorktreeLease {
	validateIdentity(dag, worktree);
	for (const held of LEASE_TOKENS.values()) {
		if (held.dag === dag && held.worktree === worktree) {
			throw new Error(
				`managed-worktree: lease already held for ${dag}/${worktree} ` +
					`(path: .pi/worktree/${dag}/${worktree}). ` +
					`Concurrent spawns against the same managed-worktree slot are refused; ` +
					`serialize spawns or use a distinct (dag, worktree) for parallel tasks.`,
			);
		}
	}
	const token = randomUUID();
	const lease: ManagedWorktreeLease = { token, dag, worktree };
	LEASE_TOKENS.set(token, lease);
	return lease;
}

/**
 * Release a previously-acquired lease. Idempotent — releases a token not
 * held by this process are a no-op. Returns `true` when a lease was
 * actually released, `false` when no lease matched (helps tests assert
 * the right token was passed).
 */
export function releaseManagedWorktreeLease(
	lease: ManagedWorktreeLease | null | undefined,
): boolean {
	if (!lease || !lease.token) return false;
	const held = LEASE_TOKENS.get(lease.token);
	if (!held) return false;
	if (held.dag !== lease.dag || held.worktree !== lease.worktree) {
		// Token is real but for a different (dag, worktree). Refuse — the caller
		// almost certainly passed the wrong lease descriptor.
		throw new Error(
			`managed-worktree: lease token ${lease.token} belongs to ${held.dag}/${held.worktree}, ` +
				`not ${lease.dag}/${lease.worktree}`,
		);
	}
	LEASE_TOKENS.delete(lease.token);
	return true;
}

/**
 * Read the lease token currently held for (dag, worktree), or `null` when
 * the slot is free. Pure read — does NOT acquire.
 */
export function readManagedWorktreeLease(
	dag: string,
	worktree: string,
): string | null {
	validateIdentity(dag, worktree);
	for (const held of LEASE_TOKENS.values()) {
		if (held.dag === dag && held.worktree === worktree) return held.token;
	}
	return null;
}

/** Internal helper: drop all leases. Exposed for crash-recovery tests only. */
export function clearAllManagedWorktreeLeases(): void {
	LEASE_TOKENS.clear();
}

/** Options accepted by {@link deleteManagedWorktree} / {@link deleteManagedWorktreeByPath}. */
export interface DeleteManagedWorktreeOptions {
	/** When true, also delete the `sages/<dag>/<worktree>` branch after the worktree is removed. */
	deleteBranch?: boolean;
}

/** Result of a host-owned managed-worktree release. */
export interface DeleteManagedWorktreeResult {
	path: string;
	branch: string;
	removed: boolean;
	/** True only when `deleteBranch: true` was passed AND the branch was actually deleted. */
	branchDeleted: boolean;
	/** Why the helper behaved as it did. Mirrors {@link ManagedWorktreeReleaseReason}. */
	reason: ManagedWorktreeReleaseReason;
}

/**
 * Host-owned release path: delete a managed worktree by `(repoRoot, dag, worktree)`
 * identity. Removes the on-disk worktree, deletes the marker, and — when
 * `deleteBranch: true` is explicitly requested — deletes the
 * `sages/<dag>/<worktree>` branch.
 *
 * No changes-preserved guard: the host owns the decision. The merge step is
 * the orchestrator's responsibility — this helper never emits a merge
 * instruction (Sages pins that to `pi/templates/SYSTEM.md`).
 *
 * Refuses to do anything for an unknown repo (ENOENT) or a missing marker
 * (path-leakage guard: refuses to operate on a path that was not provisioned
 * through the managed-worktree domain).
 */
export function deleteManagedWorktree(
	args: {
		repoRoot: string;
		dag: string;
		worktree: string;
	} & DeleteManagedWorktreeOptions,
): DeleteManagedWorktreeResult {
	const { repoRoot, dag, worktree } = args;
	validateIdentity(dag, worktree);
	let realRoot: string;
	try {
		realRoot = realpathSync(repoRoot);
	} catch (err: any) {
		if (err?.code === "ENOENT") {
			throw new Error(`managed-worktree: ${repoRoot} does not exist on disk`);
		}
		throw err;
	}
	const path = worktreePath(realRoot, dag, worktree);
	const branch = branchName(dag, worktree);
	return deleteManagedWorktreeByPathImpl({
		repoRoot: realRoot,
		path,
		branch,
		deleteBranch: args.deleteBranch,
	});
}

/**
 * Host-owned release path that takes an absolute `path` instead of an
 * identity tuple. The path MUST live under `<repoRoot>/.pi/worktree/...` —
 * anything outside the containment root is refused with a precise error.
 */
export function deleteManagedWorktreeByPath(
	args: {
		repoRoot: string;
		path: string;
	} & DeleteManagedWorktreeOptions,
): DeleteManagedWorktreeResult {
	let realRoot: string;
	try {
		realRoot = realpathSync(args.repoRoot);
	} catch (err: any) {
		if (err?.code === "ENOENT") {
			throw new Error(
				`managed-worktree: ${args.repoRoot} does not exist on disk`,
			);
		}
		throw err;
	}
	// Containment check FIRST — refuse to leak *any* information about a path
	// outside `.pi/worktree`, including whether it exists on disk. We normalize
	// both the supplied path and the containment root, then derive the relative
	// path; `..` or absolute escape routes are an immediate rejection.
	const expected = normalize(join(realRoot, ".pi", "worktree"));
	const got = normalize(args.path);
	const rel = relative(expected, got);
	if (
		rel === "" ||
		rel.startsWith("..") ||
		rel.startsWith(sep) ||
		isAbsolute(got.replace(expected, ""))
	) {
		throw new Error(
			`managed-worktree: path ${args.path} is not contained under ${expected} ` +
				`(managed-worktree deletions are confined to .pi/worktree/${pathSegment(rel)} — ` +
				`requested path escapes the per-repo .pi/worktree containment root).`,
		);
	}
	// Then dereference symlinks for the actual `git worktree remove` call —
	// ENOENT here is a clean error, containment already passed above.
	let realPath: string;
	try {
		realPath = realpathSync(args.path);
	} catch (err: any) {
		if (err?.code === "ENOENT") {
			throw new Error(`managed-worktree: ${args.path} does not exist on disk`);
		}
		throw err;
	}
	// Path-segment under containment root = `<dag>/<worktree>` — recover them
	// for branch deletion.
	const segments = realPath.slice(expected.length + 1).split(sep);
	const dag = segments[0] ?? "";
	const worktree = segments[1] ?? "";
	const branch = branchName(dag, worktree);
	return deleteManagedWorktreeByPathImpl({
		repoRoot: realRoot,
		path: realPath,
		branch,
		deleteBranch: args.deleteBranch,
	});
}

/** Internal: do the actual git worktree remove / marker delete / branch delete. */
function deleteManagedWorktreeByPathImpl(args: {
	repoRoot: string;
	path: string;
	branch: string;
	deleteBranch?: boolean;
}): DeleteManagedWorktreeResult {
	const { repoRoot, path, branch } = args;
	const worktreeStillExists = existsSync(path);
	if (!worktreeStillExists) {
		return {
			path,
			branch,
			removed: false,
			branchDeleted: false,
			reason: "missing",
		};
	}
	// Remove the worktree — force so committed-but-uncommitted state does not
	// block. Caller asked us to drop this, so honoring their intent is correct.
	runGitIn(["worktree", "remove", "--force", path], repoRoot);
	// Marker cleanup is best-effort: the marker may legitimately be missing
	// (e.g. the caller is cleaning up after an aborted provision). We do not
	// throw — a leaked marker is harmless to the next provision attempt.
	// Recover (dag, worktree) from the path so we can target the right marker.
	const rel = relative(join(repoRoot, ".pi", "worktree"), path);
	const segments = rel.split(sep).filter((s) => s.length > 0);
	if (segments.length === 2) {
		try {
			deleteManagedWorktreeMarker(repoRoot, segments[0], segments[1]);
		} catch {
			// ignore — see note above
		}
	}
	let branchDeleted = false;
	if (args.deleteBranch) {
		// Use `git branch -D` to drop the branch unconditionally. The host has
		// already decided the work is dispensable (force-removed the worktree);
		// a stuck branch ref would just leak refs/heads/sages/... for no reason.
		try {
			runGitIn(["branch", "-D", branch], repoRoot);
			branchDeleted = true;
		} catch {
			// Branch may not exist locally (only the worktree's checkout knew of
			// it). Quietly ignore — branchDeleted stays false.
		}
	}
	return { path, branch, removed: true, branchDeleted, reason: "no-changes" };
}

/**
 * Helper for nicer error messages: grab the leading `..` / first path segment
 * so callers see *which* way the path escaped.
 */
function pathSegment(rel: string): string {
	if (!rel) return "";
	const parts = rel.split(sep).filter((s) => s.length > 0);
	return parts.length === 0 ? rel : parts[0];
}
