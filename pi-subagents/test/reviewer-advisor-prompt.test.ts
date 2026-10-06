/**
 * reviewer-advisor-prompt.test.ts — Invariants for ReviewerAdvisor.
 *
 * GC-2026-advisor-pairs: ReviewerAdvisor is the audit-phase advisor
 * (paired with Reviewer). It reads the primary Reviewer's verdict file
 * + evidence trail and writes a `review-advisor-{task_id}.md` with one
 * of: VALIDATED (Reviewer's verdict is well-evidenced) or CONTESTED
 * (the Reviewer missed a finding or mis-classified the verdict).
 *
 * Distinct from Reviewer: doesn't re-run typecheck/lint/tests, doesn't
 * read source code, only audits the Reviewer's evidence trail and
 * verdict output.
 */

import { describe, expect, it } from "vitest";
import { REVIEWER_ADVISOR_PROMPT } from "../src/agent-prompts/reviewer-advisor.js";

describe("reviewer-advisor-prompt: invariants (GC-2026-advisor-pairs)", () => {
  it("exports a non-empty string", () => {
    expect(typeof REVIEWER_ADVISOR_PROMPT).toBe("string");
    expect(REVIEWER_ADVISOR_PROMPT.length).toBeGreaterThan(500);
  });

  it("identifies itself as the audit-phase advisor (paired with Reviewer)", () => {
    expect(REVIEWER_ADVISOR_PROMPT.toLowerCase()).toContain("advisor");
    expect(REVIEWER_ADVISOR_PROMPT).toMatch(/audit|review/i);
  });

  it("names review-advisor-{task_id}.md as the single output target", () => {
    expect(REVIEWER_ADVISOR_PROMPT).toContain("review-advisor-");
  });

  it("explicitly forbids re-running typecheck/lint/test (Reviewer did this)", () => {
    const lower = REVIEWER_ADVISOR_PROMPT.toLowerCase();
    expect(lower).toMatch(/do not.*re.?run|never.*re.?run/);
  });

  it("uses VALIDATED or CONTESTED verdict (audits the Reviewer's verdict)", () => {
    expect(REVIEWER_ADVISOR_PROMPT).toMatch(/VALIDATED|CONTESTED/);
  });

  it("reads the primary Reviewer's evidence trail at last-review-{goal_id}.md", () => {
    // GC-2026-merger-advisor-split replaced the phantom review-{goal_id}-{iteration}.md
    // with last-review-{goal_id}.md. ReviewerAdvisor should read the real file.
    expect(REVIEWER_ADVISOR_PROMPT).toContain("last-review-");
    // The phantom path is allowed as a meta-mention (explaining it was replaced)
    // but the prompt must not direct the agent to use it as an active read path.
    // Heuristic: a meta-mention occurs in a "historical" / "was replaced" context;
    // an active path would say "read <file>". We assert by line content: the
    // prompt should NOT contain the string `Read \`review-{goal_id}-{iteration}\``.
    expect(REVIEWER_ADVISOR_PROMPT).not.toMatch(/read\s+\`?review-\{goal_id\}-\{iteration\}/i);
  });

  it("references the 4-state Reviewer verdict set (NOT 2-state)", () => {
    expect(REVIEWER_ADVISOR_PROMPT).toMatch(/NEEDS_WORK/);
    expect(REVIEWER_ADVISOR_PROMPT).toMatch(/NEEDS_REDESIGN/);
    expect(REVIEWER_ADVISOR_PROMPT).toMatch(/NEEDS_CLARIFICATION/);
    expect(REVIEWER_ADVISOR_PROMPT).toMatch(/CLEAN/);
  });
});
