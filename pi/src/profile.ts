/**
 * Profile / bundle composition — GC-2026-049.
 *
 * A profile is a named bundle that captures the Sages soft-mode policy
 * (GC-2026-031) plus its dispatch + gate posture in a single YAML file.
 *
 * Built-in profiles live in `<pkg>/profiles/<id>.yaml` (module-relative
 * to this file, so resolution works from any cwd). A user override at
 * `~/.pi/profile.yaml` takes precedence. If neither is present, the
 * `standard` profile is loaded — from YAML when available, otherwise
 * from the in-code `STANDARD_PROFILE` constant.
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
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import * as yaml from "js-yaml";
import { SOFT_MODE_REMINDER, SOFT_MODE_SYSTEM_PROMPT_SUFFIX } from "./soft-mode.js";

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

const BUILTIN_DEFAULT = "standard";

/**
 * Package root: from `pi/src/profile.ts` this is `pi/` in the repo
 * checkout and `<pkg>/` in the installed package at
 * `~/.pi/packages/sages`. Module-relative, so built-in resource
 * resolution works from ANY cwd.
 */
const PACKAGE_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

let cached: Profile | undefined;
let warnedBuiltinMissing = false;

/**
 * In-code `standard` profile — the fallback used when no built-in
 * YAML can be found (missing/partial install). The extension must
 * never crash at module load for a missing policy file. The string
 * fields are imported from soft-mode.ts's backward-compat shims
 * (byte-identical to standard.yaml) rather than re-typed.
 */
export const STANDARD_PROFILE: Profile = {
  id: "standard",
  description: "Default profile; full subagent roster + current-workspace isolation.",
  subagents: ["Explore", "Plan", "developer", "auditor", "merger", "git-expert"],
  isolation_default: "current-workspace",
  dag_threshold: 2,
  gate_suite: ["typecheck", "test", "verify:catalog"],
  soft_mode_reminder: SOFT_MODE_REMINDER,
  soft_mode_system_prompt_suffix: SOFT_MODE_SYSTEM_PROMPT_SUFFIX,
};

/**
 * Resolve the directory holding the built-in profile YAMLs.
 *
 * Resolution order (first existing candidate wins):
 *   1. `join(PACKAGE_ROOT, "profiles")` — module-relative; correct in
 *      the repo checkout (`pi/profiles`) and the installed package
 *      (`~/.pi/packages/sages/profiles`) from any cwd.
 *   2. `pi/profiles` — legacy cwd-relative, from the repo root.
 *   3. `profiles` — legacy cwd-relative, from `pi/`.
 *
 * When none exists (missing/partial install) candidates[0] is
 * returned so callers get a stable, reportable path.
 */
export function builtinProfileDir(): string {
  const candidates = [
    join(PACKAGE_ROOT, "profiles"),
    resolve("pi/profiles"),
    resolve("profiles"),
  ];
  return candidates.find((candidate) => existsSync(candidate)) ?? candidates[0];
}

/**
 * Load the active profile.
 *
 * Resolution order (when no `overridePath` is given):
 *   1. `~/.pi/profile.yaml` — user override.
 *   2. `<pkg>/profiles/standard.yaml` (module-relative) — built-in
 *      default. Falls back to the cwd-relative candidates
 *      (`pi/profiles` from the repo root, `profiles` from `pi/`)
 *      for compatibility.
 *   3. `STANDARD_PROFILE` — in-code fallback when no built-in YAML
 *      can be found (missing/partial install); warns once instead of
 *      throwing so the extension never crashes at module load.
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

  const builtinPath = join(builtinProfileDir(), `${BUILTIN_DEFAULT}.yaml`);
  if (!existsSync(builtinPath)) {
    // Missing/partial install: degrade to the in-code default rather
    // than crashing the extension at module load.
    if (!warnedBuiltinMissing) {
      warnedBuiltinMissing = true;
      console.warn(
        `[sages] built-in profile not found at ${builtinPath}; using in-code STANDARD_PROFILE fallback.`,
      );
    }
    return STANDARD_PROFILE;
  }

  cached = loadFromPath(builtinPath);
  return cached;
}

/**
 * Look up a specific built-in profile by id (e.g. `"light"`,
 * `"audit-strict"`). Bypasses the cache. Used by tests and by
 * downstream consumers that want to enumerate the bundled profiles.
 */
export function loadBuiltInProfile(id: string): Profile {
  return loadFromPath(join(builtinProfileDir(), `${id}.yaml`));
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