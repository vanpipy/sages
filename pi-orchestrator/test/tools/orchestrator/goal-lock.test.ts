/**
 * goal-lock tests — GC-2026-057
 *
 * Covers:
 *  - computeGoalHash: deterministic, includes key fields, ignores hash
 *  - checkGoalLock: matches when intact, detects modifications
 *  - lockGoal: adds _lock_hash field
 *  - Edge cases: missing hash, mode="off"
 */

import { describe, it, expect } from "bun:test";
import {
  computeGoalHash,
  checkGoalLock,
  lockGoal,
  type GoalContractLike,
} from "@/goal-lock.js";

const BASE_GOAL: GoalContractLike = {
  id: "GC-2026-TEST",
  title: "Test goal",
  rationale: "For testing",
  success_criteria: [
    {
      id: "SC1",
      criterion: "Typecheck passes",
      verification_cmd: "bun run typecheck",
      severity: "blocker" as const,
    },
  ],
  anti_goals: ["do not break existing tests"],
  scope: { include: ["src/"], exclude: ["dist/"] },
  constraints: { must_use_existing_patterns: true },
  done_definition: "All SCs pass",
};

describe("goal-lock: computeGoalHash (GC-2026-057)", () => {
  it("H-01: hash is deterministic for the same input", () => {
    expect(computeGoalHash(BASE_GOAL)).toBe(computeGoalHash(BASE_GOAL));
  });

  it("H-02: hash is 64 hex chars (SHA-256)", () => {
    const h = computeGoalHash(BASE_GOAL);
    expect(h).toMatch(/^[a-f0-9]{64}$/);
  });

  it("H-03: key order doesn't matter (sorted canonicalization)", () => {
    const reordered: GoalContractLike = {
      title: BASE_GOAL.title,
      id: BASE_GOAL.id,
      success_criteria: BASE_GOAL.success_criteria,
      anti_goals: BASE_GOAL.anti_goals,
      rationale: BASE_GOAL.rationale,
      scope: BASE_GOAL.scope,
      constraints: BASE_GOAL.constraints,
      done_definition: BASE_GOAL.done_definition,
    };
    expect(computeGoalHash(BASE_GOAL)).toBe(computeGoalHash(reordered));
  });

  it("H-04: changing a success_criterion's verification_cmd changes hash", () => {
    const a = { ...BASE_GOAL };
    const b = {
      ...BASE_GOAL,
      success_criteria: [
        { ...BASE_GOAL.success_criteria[0], verification_cmd: "echo placeholder" },
      ],
    };
    expect(computeGoalHash(a)).not.toBe(computeGoalHash(b));
  });

  it("H-05: changing the title changes the hash", () => {
    const a = { ...BASE_GOAL };
    const b = { ...BASE_GOAL, title: "Different title" };
    expect(computeGoalHash(a)).not.toBe(computeGoalHash(b));
  });

  it("H-06: adding a new SC changes the hash (anti-cheat detects dropped SCs)", () => {
    const a = { ...BASE_GOAL };
    const b = {
      ...BASE_GOAL,
      success_criteria: [
        ...BASE_GOAL.success_criteria,
        {
          id: "SC2",
          criterion: "Another criterion",
          verification_cmd: "bun test",
        },
      ],
    };
    expect(computeGoalHash(a)).not.toBe(computeGoalHash(b));
  });

  it("H-07: removing a SC changes the hash", () => {
    const a = { ...BASE_GOAL };
    const b = { ...BASE_GOAL, success_criteria: [] };
    expect(computeGoalHash(a)).not.toBe(computeGoalHash(b));
  });

  it("H-08: changing anti_goals changes the hash", () => {
    const a = { ...BASE_GOAL };
    const b = { ...BASE_GOAL, anti_goals: ["different"] };
    expect(computeGoalHash(a)).not.toBe(computeGoalHash(b));
  });

  it("H-09: changing scope changes the hash", () => {
    const a = { ...BASE_GOAL };
    const b = { ...BASE_GOAL, scope: { include: [], exclude: [] } };
    expect(computeGoalHash(a)).not.toBe(computeGoalHash(b));
  });

  it("H-10: whitespace in title doesn't change hash (YAML vs JSON)", () => {
    const a = { ...BASE_GOAL, title: "Test goal" };
    const b = { ...BASE_GOAL, title: "  Test goal  " };
    // Canonicalization does NOT strip whitespace inside string values —
    // it preserves them. This is intentional: the LLM should not be
    // able to defeat the lock by adding invisible whitespace.
    expect(computeGoalHash(a)).not.toBe(computeGoalHash(b));
  });
});

describe("goal-lock: lockGoal (GC-2026-057)", () => {
  it("L-01: adds _lock_hash field to goal", () => {
    const locked = lockGoal(BASE_GOAL);
    expect(locked._lock_hash).toMatch(/^[a-f0-9]{64}$/);
    expect(locked._lock_hash).toBe(computeGoalHash(BASE_GOAL));
  });

  it("L-02: locked goal is a NEW object (immutable)", () => {
    const locked = lockGoal(BASE_GOAL);
    expect(locked).not.toBe(BASE_GOAL);
    expect((BASE_GOAL as { _lock_hash?: string })._lock_hash).toBeUndefined();
  });

  it("L-03: locking a goal with an existing _lock_hash recomputes", () => {
    const tampered = { ...BASE_GOAL, _lock_hash: "wrong-hash", title: "Tampered" };
    const relocked = lockGoal(tampered);
    expect(relocked._lock_hash).toBe(computeGoalHash(tampered));
  });
});

describe("goal-lock: checkGoalLock (GC-2026-057)", () => {
  it("C-01: matching hash → intact=true", () => {
    const locked = lockGoal(BASE_GOAL);
    const r = checkGoalLock(locked, { mode: "audit" });
    expect(r.intact).toBe(true);
    expect(r.computed).toBe(locked._lock_hash);
    expect(r.stored).toBe(locked._lock_hash);
    expect(r.reason).toBeUndefined();
  });

  it("C-02: modified goal → intact=false, reason set", () => {
    const locked = lockGoal(BASE_GOAL);
    // Simulate the LLM modifying the goal after locking.
    const tampered = {
      ...locked,
      success_criteria: [
        { ...locked.success_criteria[0], verification_cmd: "echo yes" },
      ],
    };
    const r = checkGoalLock(tampered, { mode: "audit" });
    expect(r.intact).toBe(false);
    expect(r.computed).not.toBe(locked._lock_hash);
    expect(r.stored).toBe(locked._lock_hash);
    expect(r.reason).toContain("modified");
  });

  it("C-03: dropped SC → intact=false (anti-cheat catches it)", () => {
    const locked = lockGoal(BASE_GOAL);
    const tampered = { ...locked, success_criteria: [] };
    const r = checkGoalLock(tampered, { mode: "audit" });
    expect(r.intact).toBe(false);
    expect(r.reason).toContain("modified");
  });

  it("C-04: relaxed title → intact=false", () => {
    const locked = lockGoal(BASE_GOAL);
    const tampered = { ...locked, title: "Relaxed title" };
    const r = checkGoalLock(tampered, { mode: "audit" });
    expect(r.intact).toBe(false);
  });

  it("C-05: missing _lock_hash → intact=false, reason=no-stored-hash", () => {
    const r = checkGoalLock(BASE_GOAL, { mode: "audit" });
    expect(r.intact).toBe(false);
    expect(r.reason).toContain("never locked");
    expect(r.stored).toBeNull();
  });

  it("C-06: mode='off' → always intact, no check", () => {
    const tampered = { ...BASE_GOAL, title: "Tampered" };
    const r = checkGoalLock(tampered, { mode: "off" });
    expect(r.intact).toBe(true);
  });

  it("C-07: mode='hard-fail' returns same result as 'audit' (decision is caller's)", () => {
    const locked = lockGoal(BASE_GOAL);
    const tampered = { ...locked, title: "Tampered" };
    const audit = checkGoalLock(tampered, { mode: "audit" });
    const hardFail = checkGoalLock(tampered, { mode: "hard-fail" });
    expect(audit.intact).toBe(hardFail.intact);
    expect(audit.reason).toBe(hardFail.reason);
  });
});

describe("goal-lock: end-to-end anti-cheat (GC-2026-057)", () => {
  it("E-01: full lock → modify → check → detect", () => {
    // 1. LLM creates a strict goal
    const original: GoalContractLike = {
      ...BASE_GOAL,
      success_criteria: [
        {
          id: "SC1",
          criterion: "All tests pass with no skips",
          verification_cmd: "bun test --no-skip",
          severity: "blocker" as const,
        },
        {
          id: "SC2",
          criterion: "Typecheck passes",
          verification_cmd: "bun run typecheck",
          severity: "blocker" as const,
        },
      ],
    };

    // 2. Lock the goal
    const locked = lockGoal(original);

    // 3. LLM "cheats" by dropping SC2 and relaxing SC1
    const cheated = {
      ...locked,
      success_criteria: [
        {
          id: "SC1",
          criterion: "Some tests pass",
          verification_cmd: "echo ok",
          severity: "minor" as const,
        },
      ],
    };

    // 4. Check detects cheating
    const r = checkGoalLock(cheated, { mode: "audit" });
    expect(r.intact).toBe(false);
    expect(r.reason).toContain("modified");
  });
});