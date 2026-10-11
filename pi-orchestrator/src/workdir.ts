/**
 * workdir.ts — Resolves the orchestrator's runtime workdir.
 *
 * The orchestrator's persistent state (goal contracts, audit-state,
 * subagent task reports, brainstorm design docs) lives under one root
 * directory computed from two environment variables:
 *
 *   - `$TMPDIR`               base temp directory (falls back to `os.tmpdir()`)
 *   - `$ORCHESTRATOR_WORKDIR` subdirectory name (falls back to `"pi-orchestrator"`)
 *
 * Resolved path = `$TMPDIR/$ORCHESTRATOR_WORKDIR` (resolved to an absolute
 * path, with the directory `mkdirSync({recursive: true})`-ed on first access).
 *
 * Migrated from a per-project `<cwd>/.pi/orchestrator/` location so the
 * orchestrator's state is sandboxed under the system temp dir — it no
 * longer pollutes the user's project tree, and a single per-session
 * env-var override (`ORCHESTRATOR_WORKDIR=sessions/<id>`) cleanly
 * isolates concurrent runs without touching the user's cwd.
 *
 * The path is cached after first resolution; tests that need a fresh
 * value can call `resetOrchestratorWorkdirCache()`.
 */

import { mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

/** Name of the env var holding the orchestrator workdir's leaf segment. */
export const ORCHESTRATOR_WORKDIR_VAR = "ORCHESTRATOR_WORKDIR";

/** Name of the env var holding the base temp directory. */
export const TMPDIR_VAR = "TMPDIR";

/** Default leaf segment when `$ORCHESTRATOR_WORKDIR` is unset or empty. */
export const DEFAULT_ORCHESTRATOR_WORKDIR_NAME = "pi-orchestrator";

let cached: string | undefined;

/**
 * Returns the absolute path to the orchestrator's runtime workdir,
 * creating the directory if it doesn't already exist. Cached after
 * first call; tests should call `resetOrchestratorWorkdirCache()`
 * between cases that change the env vars.
 */
export function resolveOrchestratorWorkdir(): string {
  if (cached !== undefined) return cached;

  const tmp = process.env[TMPDIR_VAR]?.trim() || tmpdir();
  const name = process.env[ORCHESTRATOR_WORKDIR_VAR]?.trim() || DEFAULT_ORCHESTRATOR_WORKDIR_NAME;
  const full = resolve(join(tmp, name));

  try {
    mkdirSync(full, { recursive: true, mode: 0o700 });
  } catch {
    // mkdir with recursive + an existing dir is a no-op; race with a
    // concurrent creator is acceptable (worst case: both succeed).
  }

  cached = full;
  return full;
}

/**
 * Clear the cached workdir path. Tests use this when they mutate
 * `$ORCHESTRATOR_WORKDIR` / `$TMPDIR` between cases.
 */
export function resetOrchestratorWorkdirCache(): void {
  cached = undefined;
}