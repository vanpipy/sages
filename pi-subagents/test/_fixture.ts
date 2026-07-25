/**
 * Shared test fixture for managed-worktree tests.
 *
 * Builds an isolated git workspace for each test:
 *
 *   <tmp>/<id>/remote.git          bare "origin" (local, no network)
 *   <tmp>/<id>/repo.git            working tree, origin/main = N initial commits
 *
 * Every `git` invocation in tests goes through `runGit` so the test code
 * fails loud if the substrate is unhealthy.
 */

import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface RepoFixture {
  id: string;
  root: string;          // <tmp>/<id>/repo.git
  remote: string;        // <tmp>/<id>/remote.git
  originMainSha: string; // sha of origin/main when fixture was built
  dispose: () => void;
}

export const GIT_TIMEOUT_MS = 15_000;

/**
 * Run a `git` command, capturing stdout. Returns the trimmed string.
 *
 * Bun's `execFileSync` differs from Node's: on success it returns the stdout
 * Buffer directly rather than a `SpawnSyncReturns` object. This helper
 * normalizes both shapes so tests run identically under Bun and Node.
 */
export function runGit(
  args: string[],
  opts: { cwd: string; input?: Buffer | string; env?: NodeJS.ProcessEnv } = { cwd: process.cwd() },
): string {
  let raw: Buffer;
  try {
    const out = execFileSync("git", args, {
      cwd: opts.cwd,
      stdio: ["ignore", "pipe", "pipe"],
      input: opts.input,
      timeout: GIT_TIMEOUT_MS,
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0", ...(opts.env ?? {}) },
    });
    // Normalize Bun (raw Buffer) vs Node (SpawnSyncReturns<Buffer>).
    raw =
      out instanceof Buffer
        ? out
        : ((out as { stdout?: Buffer | string }).stdout instanceof Buffer
            ? (out as { stdout: Buffer }).stdout
            : Buffer.from((out as { stdout?: string }).stdout ?? ""));
  } catch (err: any) {
    const stderr = err?.stderr ? err.stderr.toString().trim() : "";
    const stdout = err?.stdout ? err.stdout.toString().trim() : "";
    throw new Error(
      `git ${args.join(" ")} (cwd=${opts.cwd}) failed: ${stderr || stdout || err?.message}`,
    );
  }
  return raw.toString();
}

/**
 * Build a fresh fixture: a local bare remote + a working clone, both rooted
 * at <tmp>/<testId>/. The working repo's `origin/main` is advanced by exactly
 * one commit (the initial commit on the remote's main branch).
 */
export function makeRepoFixture(testId: string): RepoFixture {
  const baseDir = mkdtempSync(join(tmpdir(), `pi-wt-${testId}-`));
  const remote = join(baseDir, "remote.git");
  const root = join(baseDir, "repo.git");

  // 1. Bare "origin" — pass the path as an absolute argument so git creates
  //    the directory; cwd is the freshly mkdtemp'd parent dir, which always
  //    exists (passing the non-existent target itself as cwd makes posix_spawn
  //    fail on some platforms before git ever runs).
  runGit(["init", "--bare", "--initial-branch=main", remote], { cwd: baseDir });

  // 2. Seed remote with a single commit on main so origin/main exists.
  //    The seed repo is throwaway — only its ref lands on `remote`.
  const seed = join(baseDir, "seed");
  runGit(["init", "--initial-branch=main", seed], { cwd: baseDir });
  runGit(["config", "user.name", "Test Seed"], { cwd: seed });
  runGit(["config", "user.email", "seed@test.invalid"], { cwd: seed });
  runGit(["config", "commit.gpgsign", "false"], { cwd: seed });
  runGit(["remote", "add", "origin", remote], { cwd: seed });
  runGit(["config", "user.name", "Test Seed"], { cwd: seed });
  runGit(["config", "user.email", "seed@test.invalid"], { cwd: seed });
  // Use a placeholder content file; baseSha will be recorded so tests can detect identity.
  runGit(["commit", "--allow-empty", "-m", "seed: initial commit on main"], {
    cwd: seed,
  });
  runGit(["push", "origin", "main"], { cwd: seed });
  const originMainSha = runGit(["rev-parse", "HEAD"], { cwd: seed }).trim();

  // 3. Working repo cloned from the bare remote.
  runGit(["clone", remote, root], { cwd: baseDir });
  runGit(["config", "user.name", "Test Wt"], { cwd: root });
  runGit(["config", "user.email", "wt@test.invalid"], { cwd: root });
  runGit(["config", "commit.gpgsign", "false"], { cwd: root });
  // Set local main to track origin/main (clone does this already, but be explicit).
  runGit(["branch", "--set-upstream-to=origin/main", "main"], { cwd: root });

  return {
    id: testId,
    root,
    remote,
    originMainSha,
    dispose: () => {
      try {
        rmSync(baseDir, { recursive: true, force: true });
      } catch {
        // best effort — tmp cleanup
      }
    },
  };
}

/** Append an empty commit on origin/main and return the new sha. */
export function advanceOriginMain(fixture: RepoFixture, message = "advance"): string {
  const base = join(fixture.root, "..");
  const seed = join(base, `seed-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  runGit(["init", "--initial-branch=main", seed], { cwd: base });
  runGit(["remote", "add", "origin", fixture.remote], { cwd: seed });
  runGit(["fetch", "origin", "main"], { cwd: seed });
  runGit(["config", "user.name", "Test Seed"], { cwd: seed });
  runGit(["config", "user.email", "seed@test.invalid"], { cwd: seed });
  runGit(["config", "commit.gpgsign", "false"], { cwd: seed });
  runGit(["reset", "--hard", "origin/main"], { cwd: seed });
  runGit(["commit", "--allow-empty", "-m", message], { cwd: seed });
  runGit(["push", "origin", "main"], { cwd: seed });
  // Make the test repo aware of the new origin/main.
  runGit(["fetch", "origin", "main"], { cwd: fixture.root });
  return runGit(["rev-parse", "origin/main"], { cwd: seed }).trim();
}
