/**
 * canonicalize.ts — shared canonical-JSON serializer.
 *
 * Single source of truth for the canonical-JSON algorithm used by both
 * `goal-lock.ts` (computeGoalHash's SHA-256 substrate) and
 * `chain-key.ts` (chainKey() grouping for stuck-call detection).
 *
 * Algorithm (GC-2026-091 mandate):
 *   - Recursively traverse the value.
 *   - `undefined` at any level is skipped: returns `""` at top level,
 *     and absent keys in objects / empty slots in arrays.
 *   - Object keys are sorted at every level (deterministic).
 *   - Array element order is preserved (positional semantics — `[1,2]`
 *     and `[2,1]` are distinct).
 *
 * Why this is the correct behavior:
 *   - The goal-lock hash must be stable across YAML save/load round-trips.
 *     YAML.load strips undefined keys, so a goal with `extra: undefined`
 *     must produce the same canonical form as one without that key at
 *     all. Skipping undefined recursively is the only way to guarantee
 *     this. (GC-2026-091 postmortem: the pre-fix top-level-skip-only
 *     version caused hash drift when nested fields were undefined.)
 *   - The chain-key for stuck-call detection must also be stable across
 *     tool call re-emissions — if a sub-agent re-emits a call with an
 *     extra `undefined` arg field, the chain-key should still match.
 *     Without recursive skipping, JSON.stringify(undefined) returns
 *     the literal `undefined` (not a string), which JSON.stringify
 *     of an array containing it produces... actually, JSON.stringify
 *     drops undefined from arrays entirely, giving a different length.
 *     The unified canonicalize handles this explicitly so both inputs
 *     produce the same form.
 *
 * Pre-refactor (before this module existed):
 *   - `goal-lock.ts:canonicalize` had the correct behavior but was
 *     private (not exported).
 *   - `chain-key.ts:canonicalJSON` was duplicated but missed the
 *     undefined-skipping — a latent bug if any tool call's input
 *     contained an `undefined` value.
 *
 * Post-refactor:
 *   - Both call sites import `canonicalize` from this module.
 *   - `chain-key.ts` gains the correct undefined-skipping behavior for
 *     free.
 */

export function canonicalize(value: unknown): string {
  // GC-2026-091: undefined must be skipped recursively, not just at the
  // top level. Returning "" at the top level (used by goal-lock's
  // hash subset) propagates correctly through nested positions:
  //   - inside an array element: produces an empty slot (e.g., [1,,3])
  //   - inside an object value: skipped via Object.keys().filter below
  // The recursive case `v === undefined ? undefined : v` in the array
  // map is redundant with the early return but kept for clarity.
  if (value === undefined) return "";
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return (
      "[" +
      value.map((v) => canonicalize(v === undefined ? undefined : v)).join(",") +
      "]"
    );
  }
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj)
    .filter((k) => obj[k] !== undefined)
    .sort();
  return (
    "{" +
    keys.map((k) => JSON.stringify(k) + ":" + canonicalize(obj[k])).join(",") +
    "}"
  );
}
