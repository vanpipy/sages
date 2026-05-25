/**
 * Task Runner - Unified TDD + Subagent execution
 * 
 * Part of: src/tools/luban/
 * Purpose: Execute single task with TDD cycle, supporting both direct and subagent modes
 */

import { execSync } from "node:child_process";
import { FileService } from "@/services/file-service.js";
import type { TDDConfig, TaskResult, TDDPhaseResult } from "./types.js";

// FileService instance for workspace operations
const fileService = new FileService(process.cwd(), ".sages/workspace");

/**
 * TDD Fallback Guide - Help the agent when exceptions occur
 */
export const TDD_GUIDE = {
  /**
   * Get guidance message for a specific phase failure
   */
  getPhaseGuidance(phase: string, error?: string): string {
    const guides: Record<string, string> = {
      RED: `
📋 RED Phase Guidance:
1. Write a failing test FIRST before any implementation
2. The test should describe the expected behavior
3. Run the test - it MUST fail
4. Only then write minimal implementation

Example:
  // RED: Write this first
  test("should add numbers", () => {
    expect(add(2, 3)).toBe(5); // Fails until implemented
  });
`,
      GREEN: `
📋 GREEN Phase Guidance:
1. Write MINIMAL implementation to pass the test
2. Don't optimize yet - just make it work
3. The goal is to get to REFACTOR as quickly as possible

Example:
  // GREEN: Minimal code
  function add(a, b) {
    return a + b;
  }
`,
      REFACTOR: `
📋 REFACTOR Phase Guidance:
1. Improve code structure WITHOUT changing behavior
2. Keep tests passing throughout
3. Apply SOLID, DRY, YAGNI principles
4. Remove dead code and simplify

Focus areas:
  - Extract reusable functions
  - Rename variables for clarity
  - Simplify complex conditionals
  - Reduce duplication
`,
    };
    return guides[phase] || this.getGeneralGuidance(error);
  },

  /**
   * Get general guidance for unexpected errors
   */
  getGeneralGuidance(error?: string): string {
    return `
📋 TDD Fallback Guidance:

An unexpected error occurred: ${error || "Unknown error"}

Follow these steps:

1. 🔴 RED PHASE - Write a failing test
   - Identify what should happen
   - Write test that describes expected behavior
   - Verify it fails

2. 🟢 GREEN PHASE - Make it work
   - Write minimal code to pass the test
   - Don't optimize yet

3. 🔵 REFACTOR - Make it better
   - Improve code structure
   - Keep tests passing

💡 Remember:
- TDD is iterative: RED → GREEN → REFACTOR → RED → ...
- If stuck, return to RED and write another test
- Small steps: one test, one implementation at a time
`;
  },

  /**
   * Format error with guidance
   */
  formatError(phase: string, error: string): string {
    return `${error}

${this.getPhaseGuidance(phase, error)}`;
  },
};

/**
 * Run a single task with TDD cycle
 * 
 * @param config - TDD configuration
 * @returns TaskResult with success status and phase details
 */
export async function runTask(config: TDDConfig): Promise<TaskResult> {
  const startTime = Date.now();
  
  try {
    // Run TDD cycle
    const phases = await runTDDCycle(config);
    
    // Check if all phases passed
    const success = phases.every(p => p.status === "completed");
    
    return {
      taskId: config.taskId,
      success,
      duration: Date.now() - startTime,
      phases,
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    return {
      taskId: config.taskId,
      success: false,
      duration: Date.now() - startTime,
      phases: [{
        name: "RED",
        status: "failed",
        error: TDD_GUIDE.formatError("RED", errorMessage),
      }],
    };
  }
}

/**
 * Run TDD cycle: RED → GREEN → REFACTOR
 * 
 * @param config - TDD configuration
 * @returns Array of phase results
 */
export async function runTDDCycle(config: TDDConfig): Promise<TDDPhaseResult[]> {
  const phases: TDDPhaseResult[] = [];
  
  // RED Phase
  phases.push(await runRedPhase(config));
  if (phases[0].status === "failed") return phases;
  
  // GREEN Phase
  phases.push(await runGreenPhase(config));
  if (phases[1].status === "failed") return phases;
  
  // REFACTOR Phase
  phases.push(await runRefactorPhase(config));
  
  return phases;
}

/**
 * Extract filename from path
 */
function getFileName(filePath: string): string {
  const parts = filePath.split("/");
  const fileName = parts[parts.length - 1];
  return fileName.replace(/\.(test\.)?(ts|js)$/, "");
}

/**
 * Get directory from path
 */
function getDir(filePath: string): string {
  const parts = filePath.split("/");
  parts.pop();
  return parts.join("/") || ".";
}

/**
 * RED Phase: Write failing test
 */
async function runRedPhase(config: TDDConfig): Promise<TDDPhaseResult> {
  const phase: TDDPhaseResult = { name: "RED", status: "pending" };
  
  try {
    phase.status = "in_progress";
    
    // Create test file if it doesn't exist
    for (const testFile of config.testFiles) {
      if (!fileService.exists(testFile)) {
        const testContent = generateTestTemplate(testFile);
        const dir = getDir(testFile);
        if (dir && dir !== ".") {
          fileService.ensureWorkspace();
        }
        fileService.write(testFile, testContent);
      }
    }
    
    // Run test to verify it fails
    const result = runTests(config);
    if (result.failed === 0 && result.passed > 0) {
      phase.status = "failed";
      phase.error = TDD_GUIDE.formatError("RED", "Test passed without implementation! Write test that fails first.");
      return phase;
    }
    
    phase.status = "completed";
    return phase;
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    phase.status = "failed";
    phase.error = TDD_GUIDE.formatError("RED", errorMessage);
    return phase;
  }
}

/**
 * GREEN Phase: Write minimal implementation
 */
async function runGreenPhase(config: TDDConfig): Promise<TDDPhaseResult> {
  const phase: TDDPhaseResult = { name: "GREEN", status: "pending" };
  
  try {
    phase.status = "in_progress";
    
    // Create source file if it doesn't exist
    for (const sourceFile of config.sourceFiles) {
      if (!fileService.exists(sourceFile)) {
        const sourceContent = generateSourceTemplate(sourceFile);
        fileService.write(sourceFile, sourceContent);
      }
    }
    
    // Run tests to verify they pass
    const result = runTests(config);
    if (result.failed > 0) {
      phase.status = "failed";
      phase.error = TDD_GUIDE.formatError("GREEN", `${result.failed} tests still failing`);
      return phase;
    }
    
    phase.status = "completed";
    return phase;
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    phase.status = "failed";
    phase.error = TDD_GUIDE.formatError("GREEN", errorMessage);
    return phase;
  }
}

/**
 * REFACTOR Phase: Improve code
 */
async function runRefactorPhase(config: TDDConfig): Promise<TDDPhaseResult> {
  const phase: TDDPhaseResult = { name: "REFACTOR", status: "pending" };
  
  try {
    phase.status = "in_progress";
    
    // Run tests to ensure refactoring didn't break anything
    const result = runTests(config);
    if (result.failed > 0) {
      phase.status = "failed";
      phase.error = TDD_GUIDE.formatError("REFACTOR", "Refactoring broke tests");
      return phase;
    }
    
    phase.status = "completed";
    return phase;
  } catch (error) {
    // REFACTOR failures are warnings, not blockers
    const errorMessage = error instanceof Error ? error.message : String(error);
    phase.status = "failed";
    phase.error = TDD_GUIDE.formatError("REFACTOR", errorMessage);
    return phase;
  }
}

/**
 * Run test command and parse results
 */
function runTests(config: TDDConfig): { passed: number; failed: number; total: number } {
  try {
    const output = execSync(config.testCommand, {
      cwd: config.cwd,
      encoding: "utf-8",
      timeout: 60000,
    });
    
    const passed = (output.match(/\u2713|passed|PASS|\+/g) || []).length;
    const failed = (output.match(/\u2717|failed|FAIL|x/g) || []).length;
    
    return { passed, failed: Math.max(failed, 0), total: passed + failed };
  } catch (error) {
    // Test command failed
    return { passed: 0, failed: 1, total: 1 };
  }
}

/**
 * Generate test file template
 */
function generateTestTemplate(testFile: string): string {
  const fileName = getFileName(testFile);
  
  return `/**
 * Test file for ${fileName}
 * RED phase: This test should FAIL
 */

import { describe, it, expect } from "bun:test";

describe("${fileName}", () => {
  it("should be implemented", () => {
    expect(true).toBe(false); // RED: Must fail
  });
});
`;
}

/**
 * Generate source file template
 */
function generateSourceTemplate(sourceFile: string): string {
  const fileName = getFileName(sourceFile);
  
  return `/**
 * ${fileName}
 * GREEN phase: Minimal implementation to pass tests
 */

export function ${fileName.toLowerCase().replace(/[^a-z]/g, "_")}() {
  return {};
}
`;
}
