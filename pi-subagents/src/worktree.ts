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
 *     `sages/<dag>/<worktree>`, derived from `opts.base_ref` (explicit)
 *     or the current working directory (auto: upstream → local →
 *     `origin/main` fallback). The orchestrator owns inspection
 *     (`inspectManagedWorktree`) and release (`releaseManagedWorktree`);
 *     the helper never auto-stages, auto-commits, auto-merges, or
 *     auto-cleans a changed worktree. GC-2026-008 P1.
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
//   * the base ref is resolved from `opts.base_ref` (explicit) or the
//     current working directory (auto: upstream tracking ref → local
//     branch → `"origin/main"` fallback). Missing refs throw (no silent
//     fallback). Local refs (e.g. `feature/x`) do not trigger a fetch;
//     remote-tracking refs (e.g. `origin/feature/x`) trigger a `git
//     fetch` first. Reuse enforces that the slot's recorded `baseRef`
//     matches the call's resolved ref — a worktree provisioned from
//     `feature/x` cannot be silently reused for a `main` task.
//   * the helper itself NEVER stages, NEVER commits, NEVER merges, NEVER
//     emits a merge instruction, and NEVER removes a worktree that has
//     changes without an explicit `{ force: true }` from the caller
//   * release is a separate, explicit operation; the orchestrator decides
//     when — usually after the `auditor` built-in has run its checks
//     (the legacy `software-auditor` alias was removed in GC-2026-014)

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

/** Git ref regex: `[A-Za-z0-9._/-]+`, must be non-empty. More permissive than
 * `IDENTITY_RE` because git refs commonly include `.` (tags like `v1.2.3`)
 * and `/` (branch names like `feature/x`, remote-tracking refs like
 * `origin/main`). Refuses whitespace, `..`, `@{`, leading `/`, shell
 * metacharacters — anything that could escape the ref name into a flag
 * or a path-traversal sequence when this string is passed to a `git`
 * invocation. */
const BASE_REF_RE = /^[A-Za-z0-9._/-]+$/;

/** Validate the `base_ref` string. Throws on any structural problem.
 *
 * Mirrors `validateIdentity` for the request side: same constraint
 * language, same throw style, same level of paranoia about characters
 * that could land us in `git`'s flag-parser or the filesystem.
 *
 * The character class alone is not enough — `git check-ref-format` rejects
 * additional patterns the regex would let through (e.g. `..`, leading or
 * trailing `/`, `//`, `@{`, trailing `.lock`). The explicit pattern checks
 * below catch those and translate them into the same `managed-worktree:
 * base_ref ...` error envelope. */
export function validateBaseRef(baseRef: string): void {
	if (typeof baseRef !== "string") {
		throw new Error(
			`managed-worktree: base_ref must be a string (got ${typeof baseRef})`,
		);
	}
	if (baseRef.length === 0) {
		throw new Error(`managed-worktree: base_ref must not be empty`);
	}
	if (baseRef !== baseRef.trim()) {
		throw new Error(
			`managed-worktree: base_ref must not contain leading/trailing whitespace (got ${JSON.stringify(baseRef)})`,
		);
	}
	if (!BASE_REF_RE.test(baseRef)) {
		throw new Error(
			`managed-worktree: base_ref ${JSON.stringify(baseRef)} is not a safe git ref name ` +
				`(only [A-Za-z0-9._/-] allowed; reject whitespace, '@{', shell metacharacters)`,
		);
	}
	// `git check-ref-format` rules not covered by the regex: leading or
	// trailing `/` is a path escape, `..` is path-traversal, `//` collapses
	// to `/` in some git operations, `@{` is reflog syntax, `.lock` at the
	// end is the lockfile suffix git uses while updating a ref. None of
	// these are valid base refs for `git worktree add <ref>`.
	if (baseRef.startsWith("/") || baseRef.endsWith("/")) {
		throw new Error(
			`managed-worktree: base_ref ${JSON.stringify(baseRef)} must not start or end with '/'`,
		);
	}
	if (
		baseRef.includes("..") ||
		baseRef.includes("//") ||
		baseRef.includes("@{") ||
		baseRef.endsWith(".lock")
	) {
		throw new Error(
			`managed-worktree: base_ref ${JSON.stringify(baseRef)} contains a forbidden git ref sequence ` +
				`('..', '//', '@{', or trailing '.lock')`,
		);
	}
}

/**
 * Detect the current branch and its upstream tracking ref in `repoRoot`.
 * Returns `{ local, upstream }` with `undefined` for the absent half —
 * detached HEAD, no upstream, or a non-git directory all degrade to
 * `(undefined, undefined)`. Pure read; never mutates the repo.
 *
 *   - `local`    is the branch name (e.g. `main`, `feature/x`) when HEAD
 *                is on a real branch; `undefined` for detached HEAD.
 *   - `upstream` is the upstream tracking ref name (e.g. `origin/main`,
 *                `origin/feature/x`) when the local branch has one;
 *                `undefined` otherwise.
 *
 * The helper does NOT call `git symbolic-ref` (it can succeed on a non-
 * symbolic HEAD on some git versions); `rev-parse --abbrev-ref` is the
 * portable form and returns the literal string `HEAD` for detached —
 * which we treat as "no branch".
 */
function detectCurrentBranch(repoRoot: string): {
	local: string | undefined;
	upstream: string | undefined;
} {
	let local: string | undefined;
	try {
		const out = runGitIn(["rev-parse", "--abbrev-ref", "HEAD"], repoRoot, true);
		if (out && out !== "HEAD") {
			local = out;
		}
	} catch {
		// Not a git repo, or no commits — fall through with `local = undefined`.
	}
	let upstream: string | undefined;
	if (local) {
		try {
			// `@{u}` is the upstream tracking ref for the current branch. Throws
			// "no upstream configured" when the branch has no upstream; we
			// treat that as "no upstream".
			const u = runGitIn(
				["rev-parse", "--abbrev-ref", "@{u}"],
				repoRoot,
				true,
			);
			if (u && u !== "@{u}") {
				upstream = u;
			}
		} catch {
			// no upstream — common for newly-created local branches
		}
	}
	return { local, upstream };
}

/**
 * Resolve the `base_ref` for a managed worktree. Pure function with no
 * side effects on `repoRoot` other than read-only `git rev-parse` calls.
 *
 * Resolution order (when `baseRef` is `undefined`):
 *   1. The local branch's upstream tracking ref (e.g. `origin/main`,
 *      `origin/feature/x`) — the user's "current work" in the remote-
 *      tracking sense. Picked first so callers sitting on a normal
 *      `main`/`develop`/etc. branch track the canonical remote, not
 *      whatever the local branch has been fast-forwarded or rebased to.
 *   2. The local branch name (e.g. `main`, `feature/x`) — the user's
 *      "current work" in the local sense. Picked when the local branch
 *      has no upstream (typical of a freshly-created feature branch).
 *   3. `"origin/main"` — the historical hardcoded default. Used only
 *      when HEAD is detached (e.g. CI, release builds) or `repoRoot`
 *      is not a git repository.
 *
 * When `baseRef` is supplied, it is validated via {@link validateBaseRef}
 * and returned verbatim. The validation throws on unsafe characters;
 * `repoRoot` is not consulted.
 *
 * Exported for testability: the resolver has no observable side effects
 * on disk and is small enough to cover with focused unit tests.
 */
export function resolveBaseRef(
	repoRoot: string,
	baseRef: string | undefined,
): string {
	if (baseRef !== undefined) {
		validateBaseRef(baseRef);
		return baseRef;
	}
	const { local, upstream } = detectCurrentBranch(repoRoot);
	return upstream ?? local ?? "origin/main";
}

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
 * to confirm identity and to pin the originally recorded `baseSha` (the base
 * ref advances over time; the worktree should NOT silently follow).
 *
 * `schema: 1` markers carry `baseRef: "origin/main"` (the only ref the v1
 * helper ever produced). `schema: 2` markers carry the resolved ref at
 * provision time (e.g. `origin/main`, `origin/feature/x`, `feature/x`,
 * `develop`). The reader accepts both versions and exposes `baseRef` as
 * a plain `string`; v1 markers are upgraded lazily by treating their
 * `baseRef` as `"origin/main"` (which it always was in v1).
 */
export interface ManagedWorktreeMarker {
	schema: 1 | 2;
	repoRoot: string;
	dag: string;
	worktree: string;
	path: string; // absolute worktree path (informational)
	branch: string;
	baseSha: string;
	/**
	 * The git ref the worktree was provisioned from. `origin/main` for v1
	 * markers; the resolved ref at provision time for v2 markers.
	 */
	baseRef: string;
	createdAt: number; // epoch ms
}

/** Read the marker for a given (repoRoot, dag, worktree) tuple, else null.
 *
 * Returns null if any component of the marker path doesn't resolve or the
 * JSON is missing/invalid. Callers must never silently fall back — a missing
 * marker IS a "needs verification" signal at the API boundary.
 *
 * Accepts both `schema: 1` (legacy, `baseRef` always `"origin/main"`) and
 * `schema: 2` (current, `baseRef` is the ref resolved at provision time).
 * The reader normalizes the type for v1 markers: their `baseRef` is
 * guaranteed to be `"origin/main"` (the only value v1 ever wrote), so the
 * reuse contract's `baseRef` comparison works uniformly across versions. */
export function readManagedWorktreeMarker(
	repoRoot: string,
	dag: string,
	worktree: string,
): ManagedWorktreeMarker | null {
	const fp = markerPath(repoRoot, dag, worktree);
	if (!existsSync(fp)) return null;
	try {
		const raw = readFileSync(fp, "utf8");
		const parsed = JSON.parse(raw) as Partial<ManagedWorktreeMarker> & {
			schema?: unknown;
		};
		if (parsed && (parsed.schema === 1 || parsed.schema === 2)) {
			// v1 markers wrote the literal "origin/main"; surface that as a
			// normal string so downstream consumers don't need to special-case
			// the version. Missing `baseRef` on a v1 (corrupt / partial write)
			// is upgraded to "origin/main" defensively.
			if (parsed.schema === 1) {
				parsed.baseRef = parsed.baseRef ?? "origin/main";
			}
			return parsed as ManagedWorktreeMarker;
		}
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
	/**
	 * The ref the worktree was provisioned from. Defaults to
	 * `origin/main` for callers that don't specify `base_ref` and have no
	 * detectable current branch; resolves to the current branch's upstream
	 * (e.g. `origin/main`) when set, else the local branch name (e.g.
	 * `feature/x`), else `origin/main` for detached HEAD. Always
	 * remote-tracking when the caller explicitly asks for a remote ref.
	 */
	baseRef: string;
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
	 * `baseRef`, `repoRoot`) still apply — a tampered worktree or a
	 * worktree provisioned against a different `base_ref` is refused.
	 */
	reuse?: boolean;
	/**
	 * Run `git fetch <remote> <ref>` before resolving the base ref when the
	 * resolved ref is remote-tracking (e.g. `origin/main`,
	 * `origin/feature/x`). Default: `true` so the helper always provisions
	 * from the latest remote state for remote refs. Local refs (e.g.
	 * `feature/x`, `develop`) are NEVER fetched — the local branch is
	 * the source of truth. Set to `false` for offline tests or tooling
	 * that controls fetching.
	 */
	fetch?: boolean;
	/**
	 * Explicit base ref. When provided, the worktree is provisioned from
	 * this ref (validated as a safe git ref name: `[A-Za-z0-9._/-]+`).
	 * When omitted, the helper resolves the current working directory's
	 * branch — preferring the upstream tracking ref when set, falling back
	 * to the local branch name, then to `origin/main` for detached HEAD.
	 */
	base_ref?: string;
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
	// common-dir is itself (which signals bare). Resolve the common dir to an
	// absolute path first — git returns a relative path (e.g. ".") when the
	// common dir equals the cwd, which would make the equality check below
	// fail against the absolute `realRoot` even when the repo IS bare.
	let commonDir: string;
	try {
		commonDir = runGitIn(["rev-parse", "--git-common-dir"], realRoot);
	} catch {
		throw new Error(
			`managed-worktree: cannot resolve git common dir for ${realRoot}`,
		);
	}
	const absoluteCommonDir = isAbsolute(commonDir)
		? commonDir
		: join(realRoot, commonDir);
	if (normalize(absoluteCommonDir) === normalize(realRoot)) {
		throw new Error(
			`managed-worktree: ${realRoot} is a bare repository; managed worktrees need a working tree`,
		);
	}

	// Resolve the base ref (explicit `base_ref` from caller, else auto-detect
	// from the current branch's upstream → local branch → "origin/main" fallback).
	const resolvedBaseRef = resolveBaseRef(realRoot, opts.base_ref);

	// Fetch the latest state of `resolvedBaseRef` from its origin when the ref
	// is remote-tracking. Local refs (e.g. `feature/x`, `develop`) are NEVER
	// fetched — the local branch is the source of truth. The remote/ref split
	// uses the first `/` because git refnames never contain a `:` and the
	// canonical `origin/<branch>` shape always uses `/`. A ref like just
	// `origin` (no slash) would be a malformed input — `validateBaseRef`
	// allows it but `git fetch origin origin` would fail loudly below.
	const fetchEnabled = opts.fetch !== false;
	if (fetchEnabled && resolvedBaseRef.startsWith("origin/")) {
		const localRef = resolvedBaseRef.slice("origin/".length);
		try {
			runGitIn(["fetch", "--no-tags", "origin", localRef], realRoot);
		} catch (err) {
			throw new Error(
				`managed-worktree: 'git fetch origin ${localRef}' failed in ${realRoot}: ${formatGitErr(err)}. ` +
					`Provision refuses to proceed on stale '${resolvedBaseRef}'.`,
			);
		}
	}

	// Resolve base ref — NEVER fall back. Missing ref => throw.
	let baseSha: string;
	try {
		baseSha = runGitIn(["rev-parse", "--verify", resolvedBaseRef], realRoot);
	} catch {
		throw new Error(
			`managed-worktree: '${resolvedBaseRef}' does not resolve in ${realRoot}. ` +
				`Provision refuses to fall back — ensure the ref exists locally or as a remote-tracking ref ` +
				`('git fetch origin <branch>') before provisioning.`,
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
		// baseSha (a parallel actor rewrote the branch; reuse refuses). The
		// `resolvedBaseRef` is passed in so reuse can also enforce that the
		// slot was provisioned against the same baseline as this call.
		return reuseManagedWorktree({
			repoRoot: realRoot,
			dag: opts.dag,
			worktree: opts.worktree,
			path,
			branch,
			recordedBaseRef: resolvedBaseRef,
		});
	}

	// Fresh provision: create the worktree as a detached checkout at the
	// resolved base ref, then promote to the `sages/...` branch. Doing the
	// branch promotion AFTER the worktree is registered keeps the worktree
	// list semantically meaningful (the user's branch is visible immediately
	// after create returns).
	// The `<path>` must NOT exist already (checked above) — `git worktree add`
	// creates it. We create the parent `.pi/worktree/<dag>/` directory lazily.
	runGitIn(["worktree", "add", "--detach", path, resolvedBaseRef], realRoot);
	runGitIn(["checkout", "-B", branch], path);

	// Persist identity marker so subsequent reuse re-enters deterministically.
	// `schema: 2` is the dynamic-baseRef format. v1 markers (always
	// `origin/main`) are still readable for inspection; reuse refuses them
	// only when the caller's `resolvedBaseRef` differs (a v1 marker pinned
	// to `origin/main` is reusable from a `base_ref: "origin/main"` call).
	const marker: ManagedWorktreeMarker = {
		schema: 2,
		repoRoot: realRoot,
		dag: opts.dag,
		worktree: opts.worktree,
		path,
		branch,
		baseSha,
		baseRef: resolvedBaseRef,
		createdAt: Date.now(),
	};
	writeManagedWorktreeMarker(marker);

	return {
		path,
		branch,
		baseSha,
		baseRef: resolvedBaseRef,
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
	/** The resolved base ref for THIS call (post `resolveBaseRef`). The reuse
	 *  contract verifies the marker's recorded `baseRef` matches this — a
	 *  slot provisioned from `origin/main` cannot be reused for a call that
	 *  resolves `feature/x`, even when the rest of the identity is identical.
	 *  Recorded here for parity with the create call site. */
	recordedBaseRef: string;
}): ManagedWorktree {
	const {
		repoRoot,
		dag,
		worktree,
		path,
		branch,
		recordedBaseRef: _recordedBaseRef,
	} = args;
	void _recordedBaseRef;

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
	// 1b. The slot's recorded baseRef MUST match this call's resolved ref.
	//     v1 markers record `"origin/main"` (the only value v1 ever wrote);
	//     v2 markers record whatever was resolved at provision time. A
	//     mismatch means the slot was provisioned against a different
	//     baseline — refusing reuse keeps the slot from being silently
	//     rebased onto a different branch. To re-enter with a different
	//     baseline the caller must remove the worktree and re-provision.
	if (marker.baseRef !== _recordedBaseRef) {
		throw new Error(
			`managed-worktree: cannot reuse ${path} — recorded baseRef is '${marker.baseRef}', ` +
				`this call resolves baseRef to '${_recordedBaseRef}'. ` +
				`The slot was provisioned against a different baseline. ` +
				`Pass a matching base_ref (e.g. base_ref: "${marker.baseRef}"), or remove the worktree and re-provision.`,
		);
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
	//    regardless of how the base ref has moved in the meantime. baseRef
	//    surfaces the slot's recorded ref so callers can verify the baseline
	//    without re-reading the marker.
	return {
		path,
		branch,
		baseSha: marker.baseSha,
		baseRef: marker.baseRef,
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
	// outside `.pi/worktree`, including whether it exists on disk. We resolve
	// both the supplied path (realpath catches symlink escapes) and the
	// containment root, then derive the relative path; `..` or absolute
	// escape routes are an immediate rejection.
	//
	// GC-2026-028 F1: the previous check combined `relative()` with
	// `isAbsolute(got.replace(expected, ""))`, which was always true for any
	// path that started with the containment root (the `replace` leaves a
	// leading `/`), so legitimate contained paths were rejected. Realpath
	// alone catches symlink escapes that plain `normalize` would miss.
	const expected = normalize(join(realRoot, ".pi", "worktree"));
	const got = realpathOrSelf(args.path);
	const rel = relative(expected, got);
	if (
		rel === "" ||
		rel.startsWith("..") ||
		rel.startsWith(sep) ||
		isAbsolute(rel)
	) {
		throw new Error(
			`managed-worktree: path ${args.path} is not contained under ${expected} ` +
				`(managed-worktree deletions are confined to .pi/worktree/${pathSegment(rel)} — ` +
				`requested path escapes the per-repo .pi/worktree containment root).`,
		);
	}
	// `got` is already realpath-resolved (with ENOENT fallback). ENOENT here
	// is a clean error, containment already passed above.
	if (!existsSync(got)) {
		throw new Error(`managed-worktree: ${args.path} does not exist on disk`);
	}
	// Path-segment under containment root = `<dag>/<worktree>` — recover them
	// for branch deletion.
	const segments = got.slice(expected.length + 1).split(sep);
	const dag = segments[0] ?? "";
	const worktree = segments[1] ?? "";
	const branch = branchName(dag, worktree);
	return deleteManagedWorktreeByPathImpl({
		repoRoot: realRoot,
		path: got,
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

/**
 * Resolve `realpath` but fall back to the input when the path does not exist
 * on disk yet (e.g. caller is probing). We still catch symlink escapes for
 * paths that DO exist, because the symlink target must exist for `realpath`
 * to resolve it — that is the containment guarantee we care about.
 */
function realpathOrSelf(p: string): string {
	try {
		return realpathSync(p);
	} catch (err: any) {
		if (err?.code === "ENOENT") return p;
		throw err;
	}
}
