/**
 * verdict-parser.test.ts — Unit tests for `parseReviewerVerdict`.
 *
 * The Reviewer agent emits a fenced ```yaml block at the end of its final
 * message. Path A scans for the LAST ```yaml block and parses a flat
 * structure (verdict / findings / scope_check / anti_goal_check). Path B
 * reuses the same parser to stamp metadata.verdict onto the Review task
 * when it completes, so the downstream Fix agent can read it.
 *
 * GC-2026-prompt-parser-contract-cleanup additions covered below:
 *   - File-fallback path (verdictFilePath in opts)
 *   - Strict scope_check / anti_goal_check enforcement
 *   - CLEAN + non-empty findings is malformed → NEEDS_WORK
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

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

  // GC-2026-prompt-parser-contract-cleanup additions
  describe("GC-2026-prompt-parser-contract-cleanup: strict dimension checks", () => {
    test("scope_check: fail triggers NEEDS_WORK regardless of verdict", () => {
      const message = [
        "```yaml",
        "verdict: CLEAN",
        "findings: []",
        "scope_check: fail",
        "anti_goal_check: pass",
        "```",
      ].join("\n");

      const result = parseReviewerVerdict(message);
      expect(result.verdict).toBe("NEEDS_WORK");
      expect(result.scope_check).toBe("fail");
    });

    test("anti_goal_check: fail triggers NEEDS_WORK regardless of verdict", () => {
      const message = [
        "```yaml",
        "verdict: CLEAN",
        "findings: []",
        "scope_check: pass",
        "anti_goal_check: fail",
        "```",
      ].join("\n");

      const result = parseReviewerVerdict(message);
      expect(result.verdict).toBe("NEEDS_WORK");
      expect(result.anti_goal_check).toBe("fail");
    });

    test("scope_check: absent without skip-reason → NEEDS_WORK", () => {
      const message = [
        "```yaml",
        "verdict: CLEAN",
        "findings: []",
        "scope_check: absent",
        "anti_goal_check: pass",
        "```",
      ].join("\n");

      const result = parseReviewerVerdict(message);
      expect(result.verdict).toBe("NEEDS_WORK");
    });

    test("scope_check: absent WITH skip-reason → satisfies dim", () => {
      const message = [
        "```yaml",
        "verdict: CLEAN",
        "findings: []",
        "scope_check: absent",
        "scope_check_skipped: diff is empty, no files changed, scope trivially passes",
        "anti_goal_check: pass",
        "```",
      ].join("\n");

      const result = parseReviewerVerdict(message);
      expect(result.verdict).toBe("CLEAN");
      expect(result.scope_check).toBe("absent");
      expect(result.scope_check_skipped).toMatch(/scope trivially passes/);
    });

    test("anti_goal_check: absent without skip-reason → NEEDS_WORK", () => {
      const message = [
        "```yaml",
        "verdict: CLEAN",
        "findings: []",
        "scope_check: pass",
        "anti_goal_check: absent",
        "```",
      ].join("\n");

      const result = parseReviewerVerdict(message);
      expect(result.verdict).toBe("NEEDS_WORK");
    });

    test("CLEAN with non-empty findings is malformed → NEEDS_WORK", () => {
      const message = [
        "```yaml",
        "verdict: CLEAN",
        "findings:",
        "  - severity: minor",
        "    issue: typo in comment",
        "scope_check: pass",
        "anti_goal_check: pass",
        "```",
      ].join("\n");

      const result = parseReviewerVerdict(message);
      expect(result.verdict).toBe("NEEDS_WORK");
      expect(result.findings).toHaveLength(1);
    });
  });

  describe("GC-2026-prompt-parser-contract-cleanup: file-fallback path", () => {
    let tmpDir: string;

    test.beforeAll?.(() => undefined as never);
    // Use a manual setup per test to avoid beforeAll/afterAll boilerplate.
    function setupTmp(): { verdictFilePath: string; cleanup: () => void } {
      tmpDir = mkdtempSync(join(tmpdir(), "verdict-parser-"));
      const verdictFilePath = join(tmpDir, "verdict-t1.md");
      return {
        verdictFilePath,
        cleanup: () => rmSync(tmpDir, { recursive: true, force: true }),
      };
    }

    test("no fence + verdictFilePath with CLEAN YAML → reads file and returns CLEAN", () => {
      const { verdictFilePath, cleanup } = setupTmp();
      try {
        writeFileSync(
          verdictFilePath,
          [
            "verdict: CLEAN",
            "findings: []",
            "scope_check: pass",
            "anti_goal_check: pass",
          ].join("\n"),
        );
        const result = parseReviewerVerdict(undefined, { verdictFilePath });
        expect(result.verdict).toBe("CLEAN");
        expect(result.findings).toEqual([]);
      } finally {
        cleanup();
      }
    });

    test("no fence + verdictFilePath with malformed YAML → NEEDS_WORK", () => {
      const { verdictFilePath, cleanup } = setupTmp();
      try {
        writeFileSync(verdictFilePath, "::: not yaml :::");
        const result = parseReviewerVerdict(undefined, { verdictFilePath });
        expect(result.verdict).toBe("NEEDS_WORK");
      } finally {
        cleanup();
      }
    });

    test("no fence + verdictFilePath missing → NEEDS_WORK", () => {
      const { verdictFilePath, cleanup } = setupTmp();
      try {
        // Don't write the file.
        const result = parseReviewerVerdict(undefined, { verdictFilePath });
        expect(result.verdict).toBe("NEEDS_WORK");
      } finally {
        cleanup();
      }
    });

    test("fence in message + verdictFilePath set → message fence wins", () => {
      const { verdictFilePath, cleanup } = setupTmp();
      try {
        // File says NEEDS_WORK, but the message has a CLEAN fence — message wins.
        writeFileSync(
          verdictFilePath,
          ["verdict: NEEDS_WORK", "findings: []"].join("\n"),
        );
        const message = [
          "```yaml",
          "verdict: CLEAN",
          "findings: []",
          "scope_check: pass",
          "anti_goal_check: pass",
          "```",
        ].join("\n");
        const result = parseReviewerVerdict(message, { verdictFilePath });
        expect(result.verdict).toBe("CLEAN");
      } finally {
        cleanup();
      }
    });
  });
});
