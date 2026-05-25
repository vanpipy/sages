/**
 * Unit tests for AuditSessionManager
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, mkdirSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  AuditSessionManager,
  PHASE_ORDER,
  PHASE_CATEGORY_MAP,
  REQUIRED_FILES_PER_PHASE,
  calculateScoresFromFindings,
  calculateVerdict,
  getVerdictAction,
} from "../../../src/tools/gaoyao/session.ts";

describe("AuditSessionManager", () => {
  const testDir = join(tmpdir(), `gaoyao-test-${Date.now()}`);
  let manager: AuditSessionManager;

  beforeEach(() => {
    mkdirSync(testDir, { recursive: true });
    manager = new AuditSessionManager(testDir);
  });

  afterEach(() => {
    if (existsSync(testDir)) {
      rmSync(testDir, { recursive: true, force: true });
    }
  });

  describe("create()", () => {
    it("should create a new session with default values", () => {
      const session = manager.create("full");

      expect(session.id).toMatch(/^gaoyao-\d+$/);
      expect(session.phase).toBe("INIT");
      expect(session.reviewMode).toBe("full");
      expect(session.filesEnumerated).toEqual([]);
      expect(session.filesRead).toEqual([]);
      expect(session.findings).toEqual([]);
      expect(session.completedPhases).toEqual([]);
    });

    it("should create session with plan name", () => {
      const session = manager.create("full", "my-plan");

      expect(session.planName).toBe("my-plan");
    });

    it("should create session with quick mode", () => {
      const session = manager.create("quick");

      expect(session.reviewMode).toBe("quick");
    });
  });

  describe("load()", () => {
    it("should return null when no session exists", () => {
      const session = manager.load();

      expect(session).toBeNull();
    });

    it("should load existing session", () => {
      const created = manager.create("full");
      const loaded = manager.load();

      expect(loaded).not.toBeNull();
      expect(loaded!.id).toBe(created.id);
      expect(loaded!.phase).toBe(created.phase);
    });
  });

  describe("setPhase()", () => {
    it("should update session phase", () => {
      manager.create("full");
      manager.setPhase("ENUMERATE");

      const session = manager.load();
      expect(session!.phase).toBe("ENUMERATE");
    });
  });

  describe("recordFileRead()", () => {
    it("should record a file read", () => {
      manager.create("full");
      manager.recordFileRead("/path/to/file.ts", 100);

      const session = manager.load();
      expect(session!.filesRead).toHaveLength(1);
      expect(session!.filesRead[0].path).toBe("/path/to/file.ts");
      expect(session!.filesRead[0].lines).toBe(100);
    });

    it("should not duplicate file reads", () => {
      manager.create("full");
      manager.recordFileRead("/path/to/file.ts", 100);
      manager.recordFileRead("/path/to/file.ts", 200);

      const session = manager.load();
      expect(session!.filesRead).toHaveLength(1);
      expect(session!.filesRead[0].lines).toBe(100);
    });
  });

  describe("isFileRead()", () => {
    it("should return true for read files", () => {
      manager.create("full");
      manager.recordFileRead("/path/to/file.ts", 100);

      expect(manager.isFileRead("/path/to/file.ts")).toBe(true);
    });

    it("should return false for unread files", () => {
      manager.create("full");

      expect(manager.isFileRead("/path/to/file.ts")).toBe(false);
    });
  });

  describe("completePhase()", () => {
    it("should record phase completion", () => {
      manager.create("full");
      manager.setPhase("ENUMERATE");
      
      const completion = manager.completePhase("ENUMERATE", "Test notes");

      expect(completion.phase).toBe("ENUMERATE");
      expect(completion.notes).toBe("Test notes");

      const session = manager.load();
      expect(session!.completedPhases).toHaveLength(1);
    });
  });

  describe("canAdvancePhase()", () => {
    it("should fail when no session exists", () => {
      const result = manager.canAdvancePhase();

      expect(result.canAdvance).toBe(false);
      expect(result.reason).toContain("No active session");
    });

    it("should fail when not enough files read for ENUMERATE", () => {
      manager.create("full");
      manager.setPhase("ENUMERATE");
      // Only read 3 files, but ENUMERATE requires 5

      const result = manager.canAdvancePhase();

      expect(result.canAdvance).toBe(false);
      expect(result.reason).toContain("requires reading at least 5 files");
    });

    it("should fail when no findings recorded for INK", () => {
      manager.create("full");
      manager.setPhase("INK");
      // Read enough files
      for (let i = 0; i < 5; i++) {
        manager.recordFileRead(`/path/file${i}.ts`, 100);
      }

      const result = manager.canAdvancePhase();

      expect(result.canAdvance).toBe(false);
      expect(result.reason).toContain("requires at least one finding");
    });

    it("should allow advance when requirements met", () => {
      manager.create("full");
      manager.setPhase("INK");
      // Read enough files
      for (let i = 0; i < 5; i++) {
        manager.recordFileRead(`/path/file${i}.ts`, 100);
      }
      // Add a finding
      manager.addFinding({
        category: "ink",
        severity: "minor",
        issue: "Minor style issue",
        recommendation: "Fix it",
        phase: "INK",
        recordedAt: new Date().toISOString(),
      });

      const result = manager.canAdvancePhase();

      expect(result.canAdvance).toBe(true);
    });

    it("should allow advance from ENUMERATE without findings", () => {
      manager.create("full");
      manager.setPhase("ENUMERATE");
      // Read enough files
      for (let i = 0; i < 5; i++) {
        manager.recordFileRead(`/path/file${i}.ts`, 100);
      }

      const result = manager.canAdvancePhase();

      expect(result.canAdvance).toBe(true);
    });
  });

  describe("delete()", () => {
    it("should delete session", () => {
      manager.create("full");
      manager.delete();

      const session = manager.load();
      expect(session).toBeNull();
    });
  });
});

describe("Score Calculation", () => {
  describe("calculateScoresFromFindings()", () => {
    it("should return 100 for no findings", () => {
      const results = calculateScoresFromFindings([]);

      expect(results.ink.score).toBe(100);
      expect(results.ink.passed).toBe(true);
      expect(results.nose.score).toBe(100);
      expect(results.death.score).toBe(100);
    });

    it("should apply penalties correctly", () => {
      const findings = [
        {
          category: "ink" as const,
          severity: "critical" as const,
          issue: "Critical style issue",
          recommendation: "Fix",
          phase: "INK" as const,
          recordedAt: new Date().toISOString(),
        },
        {
          category: "ink" as const,
          severity: "major" as const,
          issue: "Major style issue",
          recommendation: "Fix",
          phase: "INK" as const,
          recordedAt: new Date().toISOString(),
        },
        {
          category: "castration" as const,
          severity: "minor" as const,
          issue: "Minor security issue",
          recommendation: "Fix",
          phase: "CASTRATION" as const,
          recordedAt: new Date().toISOString(),
        },
      ];

      const results = calculateScoresFromFindings(findings);

      // ink: 100 - 30 (critical) - 15 (major) = 55
      expect(results.ink.score).toBe(55);
      expect(results.ink.passed).toBe(false);

      // castration: 100 - 5 (minor) = 95
      expect(results.castration.score).toBe(95);
      expect(results.castration.passed).toBe(true);
    });

    it("should not go below 0", () => {
      const findings = Array(10).fill(null).map((_, i) => ({
        category: "ink" as const,
        severity: "critical" as const,
        issue: `Critical issue ${i}`,
        recommendation: "Fix",
        phase: "INK" as const,
        recordedAt: new Date().toISOString(),
      }));

      const results = calculateScoresFromFindings(findings);

      expect(results.ink.score).toBe(0);
      expect(results.ink.passed).toBe(false);
    });
  });

  describe("calculateVerdict()", () => {
    it("should return REJECTED for death audit failure", () => {
      const fiveAudits = {
        ink: { passed: true, score: 100, findings: [] },
        nose: { passed: true, score: 100, findings: [] },
        foot: { passed: true, score: 100, findings: [] },
        castration: { passed: true, score: 100, findings: [] },
        death: { passed: false, score: 40, findings: [] },
      };

      const { verdict, score } = calculateVerdict(fiveAudits);

      expect(verdict).toBe("REJECTED");
      expect(score).toBeLessThan(50);
    });

    it("should return NEEDS_CHANGES for security failure", () => {
      const fiveAudits = {
        ink: { passed: true, score: 100, findings: [] },
        nose: { passed: true, score: 100, findings: [] },
        foot: { passed: true, score: 100, findings: [] },
        castration: { passed: false, score: 60, findings: [] },
        death: { passed: true, score: 100, findings: [] },
      };

      const { verdict, score } = calculateVerdict(fiveAudits);

      expect(verdict).toBe("NEEDS_CHANGES");
      expect(score).toBe(60);
    });

    it("should return PASS for score >= 70", () => {
      const fiveAudits = {
        ink: { passed: true, score: 80, findings: [] },
        nose: { passed: true, score: 80, findings: [] },
        foot: { passed: true, score: 80, findings: [] },
        castration: { passed: true, score: 80, findings: [] },
        death: { passed: true, score: 80, findings: [] },
      };

      const { verdict, score } = calculateVerdict(fiveAudits);

      expect(verdict).toBe("PASS");
      expect(score).toBe(80);
    });

    it("should return NEEDS_CHANGES for score 50-69", () => {
      const fiveAudits = {
        ink: { passed: false, score: 60, findings: [] },
        nose: { passed: true, score: 80, findings: [] },
        foot: { passed: true, score: 80, findings: [] },
        castration: { passed: true, score: 80, findings: [] },
        death: { passed: true, score: 80, findings: [] },
      };

      const { verdict, score } = calculateVerdict(fiveAudits);

      expect(verdict).toBe("PASS");
      expect(score).toBe(75); // Average of ink (60) + nose (80) + foot (80) + castration (80) = 75
    });
  });

  describe("getVerdictAction()", () => {
    it("should return correct action for PASS", () => {
      expect(getVerdictAction("PASS")).toContain("Archive workflow");
    });

    it("should return correct action for NEEDS_CHANGES", () => {
      expect(getVerdictAction("NEEDS_CHANGES")).toContain("Return to LuBan");
    });

    it("should return correct action for REJECTED", () => {
      expect(getVerdictAction("REJECTED")).toContain("Return to Fuxi");
    });
  });
});

describe("Phase Constants", () => {
  it("should have correct phase order", () => {
    expect(PHASE_ORDER).toEqual([
      "INIT",
      "ENUMERATE",
      "INK",
      "NOSE",
      "FOOT",
      "CASTRATION",
      "DEATH",
      "FINAL"
    ]);
  });

  it("should have correct category mapping", () => {
    expect(PHASE_CATEGORY_MAP["INK"]).toBe("ink");
    expect(PHASE_CATEGORY_MAP["NOSE"]).toBe("nose");
    expect(PHASE_CATEGORY_MAP["FOOT"]).toBe("foot");
    expect(PHASE_CATEGORY_MAP["CASTRATION"]).toBe("castration");
    expect(PHASE_CATEGORY_MAP["DEATH"]).toBe("death");
    expect(PHASE_CATEGORY_MAP["INIT"]).toBeNull();
    expect(PHASE_CATEGORY_MAP["ENUMERATE"]).toBeNull();
  });

  it("should have required files per phase", () => {
    expect(REQUIRED_FILES_PER_PHASE["INIT"]).toBe(0);
    expect(REQUIRED_FILES_PER_PHASE["ENUMERATE"]).toBe(5);
    expect(REQUIRED_FILES_PER_PHASE["INK"]).toBe(3);
    expect(REQUIRED_FILES_PER_PHASE["FINAL"]).toBe(0);
  });
});
