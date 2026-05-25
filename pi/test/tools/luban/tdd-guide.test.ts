/**
 * Tests for TDD_GUIDE
 * TDD RED Phase: Tests should FAIL until TDD_GUIDE is implemented
 */

import { describe, it, expect } from "bun:test";
import { TDD_GUIDE } from "@/tools/luban/task-runner.js";

describe("TDD_GUIDE", () => {
  describe("getPhaseGuidance", () => {
    it("should exist and be a function", () => {
      expect(typeof TDD_GUIDE.getPhaseGuidance).toBe("function");
    });

    it("should return RED guidance for RED phase", () => {
      const guidance = TDD_GUIDE.getPhaseGuidance("RED");
      expect(guidance).toContain("RED Phase Guidance");
      expect(guidance).toContain("Write a failing test FIRST");
    });

    it("should return GREEN guidance for GREEN phase", () => {
      const guidance = TDD_GUIDE.getPhaseGuidance("GREEN");
      expect(guidance).toContain("GREEN Phase Guidance");
      expect(guidance).toContain("Write MINIMAL implementation");
    });

    it("should return REFACTOR guidance for REFACTOR phase", () => {
      const guidance = TDD_GUIDE.getPhaseGuidance("REFACTOR");
      expect(guidance).toContain("REFACTOR Phase Guidance");
      expect(guidance).toContain("Improve code structure");
    });

    it("should return general guidance for unknown phase", () => {
      const guidance = TDD_GUIDE.getPhaseGuidance("UNKNOWN");
      expect(guidance).toContain("TDD Fallback Guidance");
    });
  });

  describe("getGeneralGuidance", () => {
    it("should exist and be a function", () => {
      expect(typeof TDD_GUIDE.getGeneralGuidance).toBe("function");
    });

    it("should include error message if provided", () => {
      const error = "Test failed: expected 5 but got 3";
      const guidance = TDD_GUIDE.getGeneralGuidance(error);
      expect(guidance).toContain(error);
    });

    it("should mention RED → GREEN → REFACTOR cycle", () => {
      const guidance = TDD_GUIDE.getGeneralGuidance();
      expect(guidance).toContain("RED");
      expect(guidance).toContain("GREEN");
      expect(guidance).toContain("REFACTOR");
    });
  });

  describe("formatError", () => {
    it("should exist and be a function", () => {
      expect(typeof TDD_GUIDE.formatError).toBe("function");
    });

    it("should include error and guidance", () => {
      const error = "Test failed";
      const formatted = TDD_GUIDE.formatError("RED", error);
      expect(formatted).toContain(error);
      expect(formatted).toContain("RED Phase Guidance");
    });
  });
});
