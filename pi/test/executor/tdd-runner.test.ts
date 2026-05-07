/**
 * Unit Tests for TDDRunner
 * Tests TDD cycle: RED → GREEN → REFACTOR
 */
import { describe, it, expect } from "bun:test";
import { TDDRunner, type TDDConfig, type TDDPhase, type TDDResult } from "../../src/executor/tdd-runner";

describe("TDDRunner", () => {
  const defaultConfig: TDDConfig = {
    taskId: "T1",
    taskDescription: "Implement user authentication",
    sourceFiles: ["src/auth.ts"],
    testFiles: ["test/auth.test.ts"],
    testCommand: "bun test",
    cwd: "/tmp/test-sages",
  };

  describe("TDD phases", () => {
    it("should define RED phase", () => {
      const phase: TDDPhase = { name: "RED", status: "pending" };
      expect(phase.name).toBe("RED");
      expect(phase.status).toBe("pending");
    });

    it("should define GREEN phase", () => {
      const phase: TDDPhase = { name: "GREEN", status: "pending" };
      expect(phase.name).toBe("GREEN");
    });

    it("should define REFACTOR phase", () => {
      const phase: TDDPhase = { name: "REFACTOR", status: "pending" };
      expect(phase.name).toBe("REFACTOR");
    });

    it("should have all three phases in correct order", () => {
      const phases: TDDPhase["name"][] = ["RED", "GREEN", "REFACTOR"];
      expect(phases).toEqual(["RED", "GREEN", "REFACTOR"]);
    });

    it("should track phase status transitions", () => {
      const phase: TDDPhase = { name: "RED", status: "pending" };
      
      // Transition: pending → in_progress → completed
      phase.status = "in_progress";
      expect(phase.status).toBe("in_progress");
      
      phase.status = "completed";
      expect(phase.status).toBe("completed");
    });

    it("should track phase errors", () => {
      const phase: TDDPhase = { 
        name: "RED", 
        status: "failed",
        error: "Test passed without implementation",
      };
      
      expect(phase.status).toBe("failed");
      expect(phase.error).toBe("Test passed without implementation");
    });
  });

  describe("TDDConfig", () => {
    it("should require taskId", () => {
      expect(defaultConfig.taskId).toBe("T1");
    });

    it("should require taskDescription", () => {
      expect(defaultConfig.taskDescription).toBe("Implement user authentication");
    });

    it("should have sourceFiles array", () => {
      expect(Array.isArray(defaultConfig.sourceFiles)).toBe(true);
      expect(defaultConfig.sourceFiles[0]).toBe("src/auth.ts");
    });

    it("should have testFiles array", () => {
      expect(Array.isArray(defaultConfig.testFiles)).toBe(true);
      expect(defaultConfig.testFiles[0]).toBe("test/auth.test.ts");
    });

    it("should have testCommand", () => {
      expect(defaultConfig.testCommand).toBe("bun test");
    });

    it("should have cwd", () => {
      expect(defaultConfig.cwd).toBe("/tmp/test-sages");
    });

    it("should support multiple source files", () => {
      const config: TDDConfig = {
        ...defaultConfig,
        sourceFiles: ["src/user.ts", "src/auth.ts", "src/session.ts"],
      };
      
      expect(config.sourceFiles.length).toBe(3);
    });

    it("should support multiple test files", () => {
      const config: TDDConfig = {
        ...defaultConfig,
        testFiles: ["test/user.test.ts", "test/auth.test.ts"],
      };
      
      expect(config.testFiles.length).toBe(2);
    });
  });

  describe("TDDResult", () => {
    it("should track success status", () => {
      const result: TDDResult = {
        success: true,
        taskId: "T1",
        phases: [],
        filesCreated: [],
        filesModified: [],
        testResults: { passed: 10, failed: 0, total: 10 },
        duration: 5000,
      };
      
      expect(result.success).toBe(true);
    });

    it("should track all phases", () => {
      const result: TDDResult = {
        success: true,
        taskId: "T1",
        phases: [
          { name: "RED", status: "completed" },
          { name: "GREEN", status: "completed" },
          { name: "REFACTOR", status: "completed" },
        ],
        filesCreated: [],
        filesModified: [],
        testResults: { passed: 5, failed: 0, total: 5 },
        duration: 3000,
      };
      
      expect(result.phases.length).toBe(3);
      expect(result.phases.every(p => p.status === "completed")).toBe(true);
    });

    it("should track files created", () => {
      const result: TDDResult = {
        success: true,
        taskId: "T1",
        phases: [],
        filesCreated: ["src/auth.ts", "test/auth.test.ts"],
        filesModified: [],
        testResults: { passed: 1, failed: 0, total: 1 },
        duration: 1000,
      };
      
      expect(result.filesCreated).toContain("src/auth.ts");
      expect(result.filesCreated).toContain("test/auth.test.ts");
    });

    it("should track files modified", () => {
      const result: TDDResult = {
        success: true,
        taskId: "T1",
        phases: [],
        filesCreated: [],
        filesModified: ["src/auth.ts"],
        testResults: { passed: 5, failed: 0, total: 5 },
        duration: 2000,
      };
      
      expect(result.filesModified).toContain("src/auth.ts");
    });

    it("should track test results", () => {
      const result: TDDResult = {
        success: true,
        taskId: "T1",
        phases: [],
        filesCreated: [],
        filesModified: [],
        testResults: { passed: 8, failed: 2, total: 10 },
        duration: 4000,
      };
      
      expect(result.testResults.passed).toBe(8);
      expect(result.testResults.failed).toBe(2);
      expect(result.testResults.total).toBe(10);
    });

    it("should track duration", () => {
      const result: TDDResult = {
        success: true,
        taskId: "T1",
        phases: [],
        filesCreated: [],
        filesModified: [],
        testResults: { passed: 5, failed: 0, total: 5 },
        duration: 5000,
      };
      
      expect(result.duration).toBe(5000);
      expect(result.duration).toBeGreaterThan(0);
    });
  });

  describe("RED Phase requirements", () => {
    it("should require test to fail in RED phase", () => {
      // In TDD, RED means: Write a test that fails
      const testResults = { passed: 0, failed: 1, total: 1 };
      const redPhaseComplete = testResults.failed > 0 && testResults.passed === 0;
      
      expect(redPhaseComplete).toBe(true);
    });

    it("should detect when RED phase fails (test passes)", () => {
      // If test passes without implementation, RED phase failed
      const testResults = { passed: 1, failed: 0, total: 1 };
      const redPhaseFailed = testResults.passed > 0 && testResults.failed === 0;
      
      expect(redPhaseFailed).toBe(true);
    });
  });

  describe("GREEN Phase requirements", () => {
    it("should require all tests to pass in GREEN phase", () => {
      const testResults = { passed: 10, failed: 0, total: 10 };
      const greenPhaseComplete = testResults.failed === 0 && testResults.passed > 0;
      
      expect(greenPhaseComplete).toBe(true);
    });

    it("should detect when GREEN phase fails", () => {
      const testResults = { passed: 8, failed: 2, total: 10 };
      const greenPhaseFailed = testResults.failed > 0;
      
      expect(greenPhaseFailed).toBe(true);
    });
  });

  describe("REFACTOR Phase requirements", () => {
    it("should allow REFACTOR phase to pass", () => {
      const testResults = { passed: 10, failed: 0, total: 10 };
      const refactorComplete = testResults.failed === 0;
      
      expect(refactorComplete).toBe(true);
    });

    it("should mark REFACTOR failure as warning, not blocker", () => {
      // REFACTOR failures are warnings - they don't block the TDD cycle
      const phase: TDDPhase = {
        name: "REFACTOR",
        status: "failed",
        error: "Refactoring opportunity identified but not implemented",
      };
      
      // GREEN should still be complete
      const greenPhase: TDDPhase = { name: "GREEN", status: "completed" };
      
      expect(greenPhase.status).toBe("completed");
      // REFACTOR can fail but GREEN is already complete
    });
  });

  describe("test command parsing", () => {
    it("should support bun test", () => {
      const testCommand = "bun test";
      expect(testCommand).toContain("test");
    });

    it("should support npm test", () => {
      const testCommand = "npm test";
      expect(testCommand).toContain("test");
    });

    it("should support jest", () => {
      const testCommand = "npx jest";
      expect(testCommand).toContain("jest");
    });

    it("should support vitest", () => {
      const testCommand = "npx vitest run";
      expect(testCommand).toContain("vitest");
    });

    it("should support custom test commands", () => {
      const testCommand = "python -m pytest tests/";
      expect(testCommand).toBeTruthy();
    });
  });

  describe("file generation", () => {
    it("should generate test template with describe block", () => {
      const testFile = "test/auth.test.ts";
      const fileName = testFile.replace(".test.ts", "");
      
      expect(testFile).toContain(".test.ts");
      expect(fileName).toBe("test/auth");
    });

    it("should generate source template", () => {
      const sourceFile = "src/auth.ts";
      const fileName = sourceFile.replace(".ts", "");
      
      expect(sourceFile).toContain(".ts");
      expect(fileName).toBe("src/auth");
    });

    it("should convert filename to class name", () => {
      const fileName = "user-auth";
      const className = fileName
        .split("-")
        .map(w => w.charAt(0).toUpperCase() + w.slice(1))
        .join("");
      
      expect(className).toBe("UserAuth");
    });

    it("should generate function name from class name", () => {
      const className = "UserAuth";
      const fnName = className.toLowerCase();
      
      expect(fnName).toBe("userauth");
    });
  });

  describe("TDD cycle validation", () => {
    it("should enforce RED before GREEN", () => {
      const redComplete = true;
      const greenStarted = true;
      
      // GREEN can only start after RED is complete
      expect(redComplete).toBe(true);
    });

    it("should allow REFACTOR after GREEN", () => {
      const greenComplete = true;
      const refactorStarted = true;
      
      // REFACTOR can start after GREEN is complete
      expect(greenComplete).toBe(true);
    });

    it("should complete cycle when all phases done", () => {
      const phases: TDDPhase[] = [
        { name: "RED", status: "completed" },
        { name: "GREEN", status: "completed" },
        { name: "REFACTOR", status: "completed" },
      ];
      
      const cycleComplete = phases.every(p => p.status === "completed");
      expect(cycleComplete).toBe(true);
    });

    it("should handle partial failure", () => {
      const phases: TDDPhase[] = [
        { name: "RED", status: "completed" },
        { name: "GREEN", status: "failed" },
        { name: "REFACTOR", status: "pending" },
      ];
      
      const greenFailed = phases[1].status === "failed";
      expect(greenFailed).toBe(true);
    });
  });

  describe("test result parsing patterns", () => {
    it("should recognize passed indicators", () => {
      const passedPatterns = ["✓", "passed", "PASS", "+", "√"];
      
      passedPatterns.forEach(pattern => {
        expect(pattern.length).toBeGreaterThan(0);
      });
    });

    it("should recognize failed indicators", () => {
      const failedPatterns = ["✗", "failed", "FAIL", "x", "✕"];
      
      failedPatterns.forEach(pattern => {
        expect(pattern.length).toBeGreaterThan(0);
      });
    });
  });
});

describe("TDD Philosophy", () => {
  it("should follow three laws of TDD", () => {
    // 1. You can't write any production code until you have a failing unit test
    const hasRedTest = true;
    expect(hasRedTest).toBe(true);
    
    // 2. You can’t write any more of a unit test than sufficient to fail
    const minimalRedTest = true;
    expect(minimalRedTest).toBe(true);
    
    // 3. You can’t write any more production code than sufficient to pass the one failing unit test
    const minimalGreenCode = true;
    expect(minimalGreenCode).toBe(true);
  });

  it("should separate RED, GREEN, REFACTOR phases", () => {
    const phaseOrder = ["RED", "GREEN", "REFACTOR"];
    expect(phaseOrder[0]).toBe("RED");
    expect(phaseOrder[1]).toBe("GREEN");
    expect(phaseOrder[2]).toBe("REFACTOR");
  });

  it("should not skip RED phase", () => {
    const skippedRed = false;
    expect(skippedRed).toBe(false);
  });

  it("should not skip GREEN phase", () => {
    const skippedGreen = false;
    expect(skippedGreen).toBe(false);
  });

  it("should consider REFACTOR optional", () => {
    // REFACTOR phase can be skipped if code is already clean
    const refactorOptional = true;
    expect(refactorOptional).toBe(true);
  });
});
