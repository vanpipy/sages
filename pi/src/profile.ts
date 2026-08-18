/**
 * Profile / bundle composition — GC-2026-049.
 *
 * A profile is a named bundle that captures the Sages soft-mode policy
 * (GC-2026-031) plus its dispatch + gate posture in a single YAML file.
 *
 * Built-in profiles live in `pi/profiles/<id>.yaml`. A user override at
 * `~/.pi/profile.yaml` takes precedence. If neither is present, the
 * `standard` profile is loaded.
 *
 * The main-agent extension reads the profile once at module load via
 * `loadProfile()` and uses its fields:
 *   - `soft_mode_reminder` — fired once per session on the first write-intent bash call
 *   - `soft_mode_system_prompt_suffix` — appended to every system prompt
 *   - `subagents` — whitelist for downstream dispatchers
 *   - `isolation_default` — default isolation mode for subagents
 *   - `dag_threshold` — todo-item count at which to recommend DAG workflow
 *   - `gate_suite` — which verifications to require
 */

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import * as yaml from "js-yaml";

export type IsolationDefault = "none" | "current-workspace" | "worktree";

export interface Profile {
  id: string;
  description: string;
  subagents: string[];
  isolation_default: IsolationDefault;
  dag_threshold: number;
  gate_suite: string[];
  soft_mode_reminder: string;
  soft_mode_system_prompt_suffix: string;
}

const VALID_ISOLATION: IsolationDefault[] = ["none", "current-workspace", "worktree"];
const REQUIRED_FIELDS = [
  "id",
  "description",
  "subagents",
  "isolation_default",
  "dag_threshold",
  "gate_suite",
  "soft_mode_reminder",
  "soft_mode_system_prompt_suffix",
] as const;

const BUILTIN_PROFILE_DIR = "pi/profiles";
const BUILTIN_DEFAULT = "standard";

let cached: Profile | undefined;

/**
 * Load the active profile.
 *
 * Resolution order (when no `overridePath` is given):
 *   1. `~/.pi/profile.yaml` — user override.
 *   2. `pi/profiles/standard.yaml` — built-in default.
 *
 * When `overridePath` is supplied, the file at that path is read
 * directly. The cache is bypassed for explicit overrides so tests
 * don't poison the canonical cache.
 *
 * The canonical lookup caches its result; the cache can be cleared
 * via `clearProfileCache()` (test-only).
 */
export function loadProfile(overridePath?: string): Profile {
  if (overridePath) {
    return loadFromPath(overridePath);
  }

  if (cached) return cached;

  const homeProfile = join(homedir(), ".pi", "profile.yaml");
  if (existsSync(homeProfile)) {
    cached = loadFromPath(homeProfile);
    return cached;
  }

  cached = loadFromPath(join(BUILTIN_PROFILE_DIR, `${BUILTIN_DEFAULT}.yaml`));
  return cached;
}

/**
 * Look up a specific built-in profile by id (e.g. `"light"`,
 * `"audit-strict"`). Bypasses the cache. Used by tests and by
 * downstream consumers that want to enumerate the bundled profiles.
 */
export function loadBuiltInProfile(id: string): Profile {
  return loadFromPath(join(BUILTIN_PROFILE_DIR, `${id}.yaml`));
}

/**
 * Read and validate a profile YAML at `path`. The path is resolved
 * against cwd AND the repository root, mirroring the
 * `subagent-registry.ts` fallback pattern, so tests and scripts can
 * run from either location without surprise failures.
 */
function loadFromPath(path: string): Profile {
  const resolved = resolveProfilePath(path);
  const raw = readFileSync(resolved, "utf-8");
  const parsed = yaml.load(raw) as Profile;
  validate(parsed);
  return parsed;
}

function resolveProfilePath(path: string): string {
  // Absolute paths and home-relative paths are returned as-is.
  if (path.startsWith("/") || path.startsWith("~")) {
    return path;
  }

  const fromCwd = resolve(path);
  if (existsSync(fromCwd)) return fromCwd;

  // Try the repository root as well (cwd is `pi/` when running from a
  // package script; the daemon typically runs from the repo root).
  const fromRepo = resolve(resolve(".."), path);
  if (existsSync(fromRepo)) return fromRepo;

  return fromCwd;
}

function validate(p: Profile): void {
  for (const k of REQUIRED_FIELDS) {
    if (!(k in (p as unknown as object))) {
      throw new Error(`profile missing required field: ${k}`);
    }
  }
  if (!Array.isArray(p.subagents) || p.subagents.length === 0) {
    throw new Error("profile.subagents must be a non-empty array");
  }
  if (!VALID_ISOLATION.includes(p.isolation_default)) {
    throw new Error(`profile.isolation_default invalid: ${p.isolation_default}`);
  }
  if (typeof p.dag_threshold !== "number" || !Number.isInteger(p.dag_threshold) || p.dag_threshold < 0) {
    throw new Error("profile.dag_threshold must be a non-negative integer");
  }
  if (!Array.isArray(p.gate_suite)) {
    throw new Error("profile.gate_suite must be an array");
  }
}

/**
 * Clear the profile cache. Test-only; production code should never call this.
 */
export function clearProfileCache(): void {
  cached = undefined;
}