/**
 * Round 7: goal lock — detects tampering
 *
 * Lock a goal, simulate the LLM modifying it, verify checkGoalLock
 * returns intact=false with a reason mentioning modification.
 */

import { describe, it, expect } from "bun:test";
import {
  computeGoalHash,
  checkGoalLock,
  lockGoal,
} from "@/tools/orchestrator/goal-lock.js";

const BASE_GOAL = {
  id: "GC-2026-LOCK-TEST",
  title: "Original title",
  rationale: "Original",
  success_criteria: [
    {
      id: "SC1",
      criterion: "Real criterion",
      verification_cmd: "bun test ./src",
      severity: "blocker" as const,
    },
  ],
  anti_goals: ["original anti-goal"],
  scope: { include: ["src/"], exclude: ["dist/"] },
  constraints: { must_use_existing_patterns: true },
  done_definition: "Original done",
};

describe("Round 7: goal lock — detects tampering", () => {
  it("locked goal matches its hash on check", () => {
    const locked = lockGoal(BASE_GOAL);
    const r = checkGoalLock(locked, { mode: "audit" });
    expect(r.intact).toBe(true);
  });

  it("modifying SC verification_cmd breaks the lock", () => {
    const locked = lockGoal(BASE_GOAL);
    const tampered = {
      ...locked,
      success_criteria: [
        { ...locked.success_criteria[0], verification_cmd: "echo yes" },
      ],
    };
    const r = checkGoalLock(tampered, { mode: "audit" });
    expect(r.intact).toBe(false);
    expect(r.reason).toContain("modified");
  });

  it("dropping an SC breaks the lock (anti-cheat)", () => {
    const locked = lockGoal(BASE_GOAL);
    const tampered = { ...locked, success_criteria: [] };
    const r = checkGoalLock(tampered, { mode: "audit" });
    expect(r.intact).toBe(false);
  });

  it("relaxing the title breaks the lock", () => {
    const locked = lockGoal(BASE_GOAL);
    const tampered = { ...locked, title: "Relaxed title" };
    const r = checkGoalLock(tampered, { mode: "audit" });
    expect(r.intact).toBe(false);
  });

  it("changing anti_goals breaks the lock", () => {
    const locked = lockGoal(BASE_GOAL);
    const tampered = { ...locked, anti_goals: [] };
    const r = checkGoalLock(tampered, { mode: "audit" });
    expect(r.intact).toBe(false);
  });

  it("missing _lock_hash is reported as never-locked", () => {
    const r = checkGoalLock(BASE_GOAL, { mode: "audit" });
    expect(r.intact).toBe(false);
    expect(r.reason).toContain("never locked");
  });

  it("hash is deterministic — same input produces same hash", () => {
    const h1 = computeGoalHash(BASE_GOAL);
    const h2 = computeGoalHash({ ...BASE_GOAL });
    expect(h1).toBe(h2);
    expect(h1).toMatch(/^[a-f0-9]{64}$/);
  });
});