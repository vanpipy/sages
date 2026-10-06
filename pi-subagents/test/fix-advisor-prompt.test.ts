/**
 * fix-advisor-prompt.test.ts — Invariants for FixAdvisor.
 *
 * GC-2026-advisor-pairs: FixAdvisor is the verify-phase advisor (paired
 * with Fix). It reads the primary Fix's commit log + the original
 * Reviewer's findings[] and writes a `fix-advisor-{task_id}.md` with
 * one of: VERIFIED (each finding has a matching fix commit) or
 * INCOMPLETE (a finding was not addressed / a deferral is invalid).
 *
 * Distinct from Fix: doesn't re-run tests, doesn't apply more changes,
 * only audits the commit chain against the findings list.
 */

import { describe, expect, it } from "vitest";
import { FIX_ADVISOR_PROMPT } from "../src/agent-prompts/fix-advisor.js";

describe("fix-advisor-prompt: invariants (GC-2026-advisor-pairs)", () => {
  it("exports a non-empty string", () => {
    expect(typeof FIX_ADVISOR_PROMPT).toBe("string");
    expect(FIX_ADVISOR_PROMPT.length).toBeGreaterThan(500);
  });

  it("identifies itself as the verify-phase advisor (paired with Fix)", () => {
    expect(FIX_ADVISOR_PROMPT.toLowerCase()).toContain("advisor");
    expect(FIX_ADVISOR_PROMPT).toMatch(/verify|fix/i);
  });

  it("names fix-advisor-{task_id}.md as the single output target", () => {
    expect(FIX_ADVISOR_PROMPT).toContain("fix-advisor-");
  });

  it("explicitly forbids re-running tests (Fix did this)", () => {
    const lower = FIX_ADVISOR_PROMPT.toLowerCase();
    expect(lower).toMatch(/do not.*re.?run|never.*re.?run/);
  });

  it("uses VERIFIED or INCOMPLETE verdict (audits the Fix's commit chain)", () => {
    expect(FIX_ADVISOR_PROMPT).toMatch(/VERIFIED|INCOMPLETE/);
  });

  it("checks each finding has a matching fix commit (or valid deferral)", () => {
    expect(FIX_ADVISOR_PROMPT.toLowerCase()).toContain("finding");
    expect(FIX_ADVISOR_PROMPT).toMatch(/fix\(.+\):|commit/);
  });

  it("does NOT carry Implement / TDD language (advisor verifies, doesn't re-fix)", () => {
    const lower = FIX_ADVISOR_PROMPT.toLowerCase();
    expect(lower).toMatch(/do not.*implement|verify.*not.*refix|advisor.*read.?only/);
  });
});
