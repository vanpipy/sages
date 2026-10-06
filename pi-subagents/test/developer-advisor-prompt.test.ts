/**
 * developer-advisor-prompt.test.ts — Invariants for DeveloperAdvisor.
 *
 * GC-2026-advisor-pairs: DeveloperAdvisor is the implement-phase advisor
 * (paired with Developer per the user's paired-programming design). It
 * reads the primary Developer's task report + commit log + test output
 * and writes an `implement-advisor-{task_id}.md` file with one of two
 * verdicts: VALIDATED (primary did the work right) or CONTESTED
 * (primary missed something / made a wrong call).
 *
 * Hard prohibitions mirror merger-advisor.ts: never edit production
 * code, never run TDD on behalf of primary, never spawn Agent.
 */

import { describe, expect, it } from "vitest";
import { DEVELOPER_ADVISOR_PROMPT } from "../src/agent-prompts/developer-advisor.js";

describe("developer-advisor-prompt: invariants (GC-2026-advisor-pairs)", () => {
  it("exports a non-empty string", () => {
    expect(typeof DEVELOPER_ADVISOR_PROMPT).toBe("string");
    expect(DEVELOPER_ADVISOR_PROMPT.length).toBeGreaterThan(500);
  });

  it("identifies itself as the implement-phase advisor (paired with Developer)", () => {
    expect(DEVELOPER_ADVISOR_PROMPT.toLowerCase()).toContain("advisor");
    expect(DEVELOPER_ADVISOR_PROMPT).toMatch(/implement/i);
  });

  it("names implement-advisor-{task_id}.md as the single output target", () => {
    expect(DEVELOPER_ADVISOR_PROMPT).toContain("implement-advisor-");
  });

  it("explicitly forbids editing production code (read-only on worktree)", () => {
    const lower = DEVELOPER_ADVISOR_PROMPT.toLowerCase();
    expect(lower).toMatch(/do not.*edit|never.*edit/);
    expect(lower).toContain("read-only");
  });

  it("explicitly forbids spawning another Agent (cascade handles dispatch)", () => {
    expect(DEVELOPER_ADVISOR_PROMPT.toLowerCase()).toMatch(/do not.*spawn|never.*agent call/);
  });

  it("uses VALIDATED or CONTESTED verdict (not 4-state Reviewer verdict)", () => {
    expect(DEVELOPER_ADVISOR_PROMPT).toMatch(/VALIDATED|CONTESTED/);
    // Should NOT use Reviewer's CLEAN/NEEDS_WORK vocabulary
    expect(DEVELOPER_ADVISOR_PROMPT).not.toMatch(/verdict:\s*CLEAN\s*\|\s*NEEDS_WORK/);
  });

  it("references the primary Developer's task-{task_id}-report.md (read, not write)", () => {
    expect(DEVELOPER_ADVISOR_PROMPT).toContain("task-");
    expect(DEVELOPER_ADVISOR_PROMPT).toContain("report");
  });

  it("does NOT carry TDD / Implement phase language (advisor verifies, doesn't reimplement)", () => {
    const lower = DEVELOPER_ADVISOR_PROMPT.toLowerCase();
    // Advisor is read-only on the worktree, doesn't run TDD cycle
    expect(lower).toMatch(/do not.*red.?green|refactor|advisor.*read.?only|verify.*not.*reimplement/);
  });
});
