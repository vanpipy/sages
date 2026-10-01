/**
 * verdict-parser.test.ts — Unit tests for `parseReviewerVerdict`.
 *
 * The Reviewer agent emits a fenced ```yaml block at the end of its final
 * message. Path A scans for the LAST ```yaml block and parses a flat
 * structure (verdict / findings / scope_check / anti_goal_check). Path B
 * reuses the same parser to stamp metadata.verdict onto the Review task
 * when it completes, so the downstream Fix agent can read it.
 */

import { describe, expect, test } from "vitest";
import { parseReviewerVerdict } from "../src/verdict-parser.js";

describe("parseReviewerVerdict", () => {
  test("message with valid CLEAN fence returns { verdict: CLEAN, findings: [] }", () => {
    const message = [
      "All 5 dimensions look good.",
      "```yaml",
      "verdict: CLEAN",
      "findings: []",
      "scope_check: pass",
      "anti_goal_check: pass",
      "```",
    ].join("\n");

    const result = parseReviewerVerdict(message);
    expect(result.verdict).toBe("CLEAN");
    expect(result.findings).toEqual([]);
    expect(result.scope_check).toBe("pass");
    expect(result.anti_goal_check).toBe("pass");
  });

  test("message with NEEDS_WORK + findings returns findings array", () => {
    const message = [
      "Found issues:",
      "```yaml",
      "verdict: NEEDS_WORK",
      "findings:",
      "  - severity: major",
      "    issue: missing test for retry path",
      "    location: src/auth/retry.ts:42",
      "    recommendation: add a unit test that simulates transient failure",
      "  - severity: minor",
      "    issue: typecheck error in fix.ts",
      "    location: src/fix.ts:10",
      "scope_check: pass",
      "anti_goal_check: pass",
      "```",
    ].join("\n");

    const result = parseReviewerVerdict(message);
    expect(result.verdict).toBe("NEEDS_WORK");
    expect(result.findings).toHaveLength(2);
    expect(result.findings?.[0]).toMatchObject({
      severity: "major",
      issue: "missing test for retry path",
      location: "src/auth/retry.ts:42",
      recommendation: "add a unit test that simulates transient failure",
    });
    expect(result.findings?.[1].severity).toBe("minor");
  });

  test("message without a fence returns { verdict: NEEDS_WORK, findings: [] } (safe default)", () => {
    const result = parseReviewerVerdict("Just plain text, no fence.");
    expect(result.verdict).toBe("NEEDS_WORK");
    expect(result.findings).toEqual([]);
  });

  test("message with malformed YAML in fence returns { verdict: NEEDS_WORK, findings: [] }", () => {
    const message = [
      "Garbage:",
      "```yaml",
      "this is: not : valid: yaml: at all",
      "::: ::: :::",
      "```",
    ].join("\n");

    const result = parseReviewerVerdict(message);
    expect(result.verdict).toBe("NEEDS_WORK");
    expect(result.findings).toEqual([]);
  });

  test("empty / undefined message returns { verdict: NEEDS_WORK, findings: [] }", () => {
    expect(parseReviewerVerdict(undefined).verdict).toBe("NEEDS_WORK");
    expect(parseReviewerVerdict("").verdict).toBe("NEEDS_WORK");
  });

  test("picks the LAST yaml fence when there are multiple", () => {
    const message = [
      "First fence (snippet):",
      "```yaml",
      "verdict: CLEAN",
      "```",
      "",
      "Then the real verdict at the end:",
      "```yaml",
      "verdict: NEEDS_WORK",
      "findings:",
      "  - severity: critical",
      "    issue: data corruption",
      "```",
    ].join("\n");

    const result = parseReviewerVerdict(message);
    expect(result.verdict).toBe("NEEDS_WORK");
    expect(result.findings).toHaveLength(1);
    expect(result.findings?.[0].severity).toBe("critical");
  });
});
