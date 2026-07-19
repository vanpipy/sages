/**
 * Tests for task-runner — TDD phase validators used by luban_execute_task
 *
 * Contract under test (live helpers after simplify-actions):
 *   - runTests:        shell out to a test command and parse pass/fail counts
 *   - validateScope:   enforce the deny_files scope guard
 *   - TDD_GUIDE:       phase-specific error-message helper
 *
 * runTask, runTDDCycle, generateTestFromScenarios were removed when
 * luban_run_batch was deleted — batch-style phase running is no longer
 * performed at the tool runtime; the observe cycle inside luban_execute_task
 * drives the LLM phase by phase.
 */

import { describe, it, expect } from "bun:test";
import { runTests, validateScope, TDD_GUIDE } from "@/tools/luban/task-runner.js";

// ---------------------------------------------------------------------------
// TDD_GUIDE — phase-specific error-message helper
// ---------------------------------------------------------------------------

describe("TDD_GUIDE", () => {
  describe("getPhaseGuidance", () => {
    it("should be a function", () => {
      expect(typeof TDD_GUIDE.getPhaseGuidance).toBe("function");
    });

    it("returns RED guidance for RED phase", () => {
      const msg = TDD_GUIDE.getPhaseGuidance("RED");
      expect(msg.toLowerCase()).toContain("red");
      expect(msg).toMatch(/fail|test/i);
    });

    it("returns GREEN guidance for GREEN phase", () => {
      const msg = TDD_GUIDE.getPhaseGuidance("GREEN");
      expect(msg.toLowerCase()).toContain("green");
      expect(msg).toMatch(/minimal|implement/i);
    });

    it("returns REFACTOR guidance for REFACTOR phase", () => {
      const msg = TDD_GUIDE.getPhaseGuidance("REFACTOR");
      expect(msg.toLowerCase()).toContain("refactor");
      expect(msg).toMatch(/behavior|structure/i);
    });

    it("returns general guidance for unknown phase", () => {
      const msg = TDD_GUIDE.getPhaseGuidance("UNKNOWN");
      expect(msg).toBeTruthy();
    });
  });

  describe("getGeneralGuidance", () => {
    it("should be a function", () => {
      expect(typeof TDD_GUIDE.getGeneralGuidance).toBe("function");
    });

    it("includes error message if provided", () => {
      const msg = TDD_GUIDE.getGeneralGuidance("boom");
      expect(msg).toContain("boom");
    });

    it("mentions RED → GREEN → REFACTOR cycle", () => {
      const msg = TDD_GUIDE.getGeneralGuidance();
      expect(msg).toContain("RED");
      expect(msg).toContain("GREEN");
      expect(msg).toContain("REFACTOR");
    });
  });

  describe("formatError", () => {
    it("should be a function", () => {
      expect(typeof TDD_GUIDE.formatError).toBe("function");
    });

    it("includes error and guidance", () => {
      const msg = TDD_GUIDE.formatError("RED", "test failed");
      expect(msg).toContain("test failed");
      expect(msg.toLowerCase()).toContain("red");
    });
  });
});

// ---------------------------------------------------------------------------
// runTests — shell out to the test command
// ---------------------------------------------------------------------------

describe("runTests", () => {
  it("returns non-zero exit code when the test command fails", () => {
    const result = runTests({ testCommand: "false", cwd: "/tmp" });
    expect(result.exitCode).not.toBe(0);
    expect(result.failed).toBeGreaterThanOrEqual(0);
  });

  it("returns zero exit code when the test command succeeds", () => {
    const result = runTests({ testCommand: "true", cwd: "/tmp" });
    expect(result.exitCode).toBe(0);
    expect(result.passed).toBe(0);
    expect(result.failed).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// validateScope — enforce deny_files
// ---------------------------------------------------------------------------

describe("validateScope (deny_files guard)", () => {
  it("returns valid=true when no files are denied", () => {
    const result = validateScope({
      files: ["src/auth.ts"],
      deny_files: [],
    });
    expect(result.valid).toBe(true);
    expect(result.violation).toBeUndefined();
  });

  it("returns valid=true when deny_files is undefined", () => {
    const result = validateScope({
      files: ["src/auth.ts"],
    });
    expect(result.valid).toBe(true);
  });

  it("detects an exact-match violation", () => {
    const result = validateScope({
      files: ["src/auth.ts", "src/utils.ts"],
      deny_files: ["src/auth.ts"],
    });
    expect(result.valid).toBe(false);
    expect(result.violation?.file).toBe("src/auth.ts");
    expect(result.violation?.matched_deny).toBe("src/auth.ts");
  });

  it("matches relative path (subdirectory paths)", () => {
    const result = validateScope({
      files: ["packages/core/src/index.ts"],
      deny_files: ["src/index.ts"],
    });
    expect(result.valid).toBe(false);
  });

  it("uses exact match, not substring (auth.ts vs auth.test.ts)", () => {
    const result = validateScope({
      files: ["src/auth.test.ts"],
      deny_files: ["src/auth.ts"],
    });
    expect(result.valid).toBe(true);
  });

  it("returns first violation found", () => {
    const result = validateScope({
      files: ["src/a.ts", "src/b.ts"],
      deny_files: ["src/b.ts", "src/a.ts"],
    });
    expect(result.valid).toBe(false);
    expect(result.violation).toBeDefined();
  });
});