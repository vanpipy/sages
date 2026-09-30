/**
 * goal-lock.ts — GC-2026-057
 *
 * Anti-cheat: detect when the LLM silently modifies a goal.yaml
 * (scope drift, anti_goal relaxation, title / done_definition
 * softening). After GC-2026-orchestrator-simplify the orchestrator no
 * longer owns `success_criteria` — the Reviewer agent reads the goal
 * intent directly. The lock continues to cover the intent-relevant
 * fields that gate the workflow contract.
 *
 * Mechanism: at goal creation time, compute SHA-256 of the canonical
 * goal content. Store the hash in the goal.yaml itself (`_lock_hash`
 * field). On every read (loadGoalContract, used by future Reviewer
 * tasks), recompute the hash and compare:
 *
 *   - match: goal is intact, return the parsed object
 *   - mismatch: emit a "goal_modified" warning, return null
 *
 * The hash covers the intent-relevant fields (id, title, rationale,
 * scope, anti_goals, done_definition) — NOT the hash itself or
 * metadata fields. This makes the hash field semantically meaningful
 * ("hash of the goal content excluding the hash field").
 *
 * Anti-goal of this GC: the lock is INFORMATIONAL, not enforcement.
 * The LLM could ignore the lock and proceed; the goal-modified
 * signal is captured in the audit chain.
 */

import { createHash } from "node:crypto";

/**
 * Canonical form for hashing: JSON-stringify with sorted keys at every
 * level, no whitespace. This guarantees the hash is independent of
 * object key order and YAML formatting quirks.
 *
 * GC-2026-091: undefined values are skipped recursively (not just at
 * the top level). Otherwise, a goal that has SC fields with
 * `expected_output: undefined` produces a different canonical form
 * than the round-tripped YAML (which strips undefined keys), causing
 * the hash to drift across YAML save/load cycles. Stripping undefined
 * keeps the hash stable as long as the *value content* is the same.
 */
function canonicalize(value: unknown): string {
  if (value === undefined) return "";
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return "[" + value.map((v) => canonicalize(v === undefined ? undefined : v)).join(",") + "]";
  }
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).filter((k) => obj[k] !== undefined).sort();
  return (
    "{" +
    keys.map((k) => JSON.stringify(k) + ":" + canonicalize(obj[k])).join(",") +
    "}"
  );
}

export interface GoalContractLike {
  id: string;
  title: string;
  rationale?: string;
  anti_goals: string[];
  scope: { include: string[]; exclude: string[] };
  constraints: Record<string, unknown>;
  done_definition: string;
}

/**
 * Fields included in the lock hash. The hash field itself is excluded.
 *
 * GC-2026-orchestrator-simplify: `success_criteria` and `dag_id` are
 * no longer GoalContract fields, so they no longer participate in
 * the lock. The remaining fields capture the intent contract that
 * the Reviewer agent reads to evaluate Implementer's output.
 */
const HASHED_FIELDS = [
  "id",
  "title",
  "rationale",
  "anti_goals",
  "scope",
  "constraints",
  "done_definition",
] as const;

export function computeGoalHash(goal: GoalContractLike): string {
  const subset: Record<string, unknown> = {};
  for (const k of HASHED_FIELDS) {
    const v = (goal as unknown as Record<string, unknown>)[k];
    if (v !== undefined) subset[k] = v;
  }
  return createHash("sha256").update(canonicalize(subset)).digest("hex");
}

export interface LockCheckResult {
  /** True when the stored hash matches the recomputed hash. */
  intact: boolean;
  /** The recomputed hash (always present). */
  computed: string;
  /** The stored hash, when one was found. */
  stored: string | null;
  /** Why the check failed (when intact=false). */
  reason?: string;
}

export type LockEnforcementMode = "audit" | "hard-fail" | "off";

export interface LockOptions {
  mode: LockEnforcementMode;
}

/**
 * Check the lock status of a parsed goal object.
 *
 * Modes:
 *   - "audit" (default): log a warning if modified; return {intact: false}
 *   - "hard-fail": log an error if modified; return {intact: false}
 *   - "off": skip the check entirely; always return {intact: true}
 */
export function checkGoalLock(
  goal: GoalContractLike & { _lock_hash?: string },
  options: LockOptions = { mode: "audit" },
): LockCheckResult {
  if (options.mode === "off") {
    return { intact: true, computed: "", stored: null };
  }

  const computed = computeGoalHash(goal);
  const stored = goal._lock_hash ?? null;

  if (!stored) {
    return {
      intact: false,
      computed,
      stored: null,
      reason: "no stored _lock_hash (goal never locked)",
    };
  }

  if (stored !== computed) {
    return {
      intact: false,
      computed,
      stored,
      reason: "stored hash does not match recomputed hash (goal was modified after locking)",
    };
  }

  return { intact: true, computed, stored };
}

/**
 * Convenience: add the lock hash to a goal object before writing.
 * Use this from goalContractToYaml or as a one-shot before write.
 */
export function lockGoal<T extends GoalContractLike>(goal: T): T & { _lock_hash: string } {
  const hash = computeGoalHash(goal);
  return { ...goal, _lock_hash: hash };
}
