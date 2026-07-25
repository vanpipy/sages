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
import { existsSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, normalize, relative, sep } from "node:path";

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
export function createWorktree(cwd: string, agentId: string): WorktreeInfo | undefined {
  // Verify we're in a git repo with at least one commit (HEAD must exist)
  let baseSha: string;
  let subdir: string;
  try {
    execFileSync("git", ["rev-parse", "--is-inside-work-tree"], { cwd, stdio: "pipe", timeout: 5000 });
    baseSha = execFileSync("git", ["rev-parse", "HEAD"], { cwd, stdio: "pipe", timeout: 5000 })
      .toString()
      .trim();
    // Where cwd sits inside the repo ("" at the root): the agent must work at
    // the same subdirectory inside the copy, or a monorepo-package cwd would
    // silently widen to the whole repo. realpath both sides — git emits
    // resolved paths while cwd may arrive through a symlink (macOS /tmp).
    const topLevel = execFileSync("git", ["rev-parse", "--show-toplevel"], { cwd, stdio: "pipe", timeout: 5000 })
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
    return { path: worktreePath, branch, baseSha, workPath: subdir ? join(worktreePath, subdir) : worktreePath };
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
    }).toString().trim();

    if (status) {
      // Changes exist — stage, commit, and create a branch
      execFileSync("git", ["add", "-A"], { cwd: worktree.path, stdio: "pipe", timeout: 10000 });
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
      }).toString().trim();

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
    try { removeWorktree(cwd, worktree.path); } catch { /* ignore */ }
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
      execFileSync("git", ["worktree", "prune"], { cwd, stdio: "pipe", timeout: 5000 });
    } catch { /* ignore */ }
  }
}

/**
 * Prune any orphaned worktrees (crash recovery).
 */
export function pruneWorktrees(cwd: string): void {
  try {
    execFileSync("git", ["worktree", "prune"], { cwd, stdio: "pipe", timeout: 5000 });
  } catch { /* ignore */ }
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

/** Marker file written at the worktree root for identity pinning + reuse detection. */
export const MANAGED_WORKTREE_MARKER = ".pi-worktree.json";

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
  path: string;
  branch: string;
  baseSha: string;
  baseRef: "origin/main";
  createdAt: number; // epoch ms
}

/** Read the marker if present, else null. */
export function readManagedWorktreeMarker(path: string): ManagedWorktreeMarker | null {
  const fp = join(path, MANAGED_WORKTREE_MARKER);
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
  const fp = join(marker.path, MANAGED_WORKTREE_MARKER);
  writeFileSync(fp, JSON.stringify(marker, null, 2), "utf8");
}

/** Validate the `(dag, worktree)` tuple. Throws on any structural problem. */
export function validateIdentity(dag: string, worktree: string): void {
  for (const [name, value] of [
    ["dag", dag],
    ["worktree", worktree],
  ] as const) {
    if (typeof value !== "string") {
      throw new Error(`managed-worktree: ${name} must be a string (got ${typeof value})`);
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
export function worktreePath(repoRoot: string, dag: string, worktree: string): string {
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
    throw new Error(`managed-worktree: cannot resolve git common dir for ${realRoot}`);
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
  /** The freshly-resolved origin/main sha. Used ONLY for the "stale identity" check:
   * if the persisted marker says the branch was provisioned at a different
   * base, throw — the persisted state and the current ref disagree. */
  recordedBaseSha: string;
}): ManagedWorktree {
  const { repoRoot, dag, worktree, path, branch, recordedBaseSha } = args;

  // 1. Read the persisted marker. Mismatch on any of (repoRoot, dag,
  //    worktree, branch) is a refusal — a different managed worktree owns
  //    this slot.
  const marker = readManagedWorktreeMarker(path);
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
  // 2. Branch advance check. The branch must still point at the persisted
  //    baseSha — if it's been rewritten (force-push or `push src:dst`) refuse.
  const currentSha = runGitIn(["rev-parse", "HEAD"], path);
  // The branch's tip may equal `marker.baseSha` (untouched) OR have moved
  // FORWARD via a legitimate fast-forward. Force-push (rewriting history)
  // is detected by checking ancestor: HEAD must be a descendant of
  // marker.baseSha, otherwise the branch was rewritten.
  let ancestorOk = false;
  try {
    runGitIn(["merge-base", "--is-ancestor", marker.baseSha, currentSha], path, true, false /* don't throw */);
    ancestorOk = true;
  } catch {
    ancestorOk = false;
  }
  if (!ancestorOk) {
    throw new Error(
      `managed-worktree: cannot reuse ${path} — branch tip ${currentSha} is not a descendant of ` +
        `recorded baseSha ${marker.baseSha}. The branch has been rewritten; reject reuse and ` +
        `audit before deciding to keep or restart.`,
    );
  }
  // 3. The branch may be a strict descendant (developer did work). That's
  //    NOT a refusal condition in the orchestrator's serial-DAG model —
  //    the developer commits are exactly why we re-enter. baseSha stays
  //    pinned to its original value so the inspection API can compute
  //    "commits ahead of baseSha" reproducibly.
  // 4. Sanity: also refuse if the recorded baseSha disagrees with the
  //    caller's freshly-resolved origin/main AND the worktree is at the
  //    marker.baseSha tip (no work yet). That signals a parallel provision
  //    tried to use a different base — abort for caller audit.
  if (currentSha === marker.baseSha && marker.baseSha !== recordedBaseSha) {
    throw new Error(
      `managed-worktree: cannot reuse ${path} — worktree is untouched (HEAD = ${currentSha}) but persisted ` +
        `baseSha (${marker.baseSha}) disagrees with origin/main (${recordedBaseSha}). ` +
        `A parallel provision rewrote the base. Audit and reconcile before reusing.`,
    );
  }

  return {
    path,
    branch,
    baseSha: marker.baseSha, // unchanged from first provision
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
export function inspectManagedWorktree(wt: ManagedWorktree): ManagedWorktreeInspection {
  if (!existsSync(wt.path)) {
    throw new Error(`managed-worktree: cannot inspect ${wt.path} — path no longer exists`);
  }
  // Capture everything before any git call so a buggy future change can't sneak
  // mutation into the inspector.
  const porcelain = runGitIn(["status", "--porcelain"], wt.path, true /* allowEmpty */);
  const currentSha = runGitIn(["rev-parse", "HEAD"], wt.path);
  let commitsAhead = 0;
  try {
    const count = runGitIn(["rev-list", "--count", `${wt.baseSha}..HEAD`], wt.path, true);
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
  return {
    path,
    branch,
    removed: true,
    reason: inspection.hasChanges && opts.force ? "changes-discarded" : "no-changes",
  };
}

// ----- internal git runners -----

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

const GIT_TIMEOUT_MS_DEFAULT = 15_000;

function formatGitInvocationError(args: string[], cwd: string, err: unknown): Error {
  const anyErr = err as { stderr?: Buffer | string; stdout?: Buffer | string; message?: string };
  const stderr = anyErr?.stderr ? anyErr.stderr.toString().trim() : "";
  const stdout = anyErr?.stdout ? anyErr.stdout.toString().trim() : "";
  const detail = stderr || stdout || anyErr?.message || String(err);
  return new Error(`git ${args.join(" ")} (cwd=${cwd}) failed: ${detail}`);
}

function formatGitErr(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
