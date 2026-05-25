/**
 * Task Runner - Unified TDD + Subagent execution
 * 
 * Part of: src/tools/luban/
 * Purpose: Execute single task with TDD cycle, supporting both direct and subagent modes
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, dirname, basename } from "node:path";
import { execSync } from "node:child_process";
import type { TDDConfig, TaskResult, TDDPhaseResult } from "./types.js";

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
    return {
      taskId: config.taskId,
      success: false,
      duration: Date.now() - startTime,
      phases: [{
        name: "RED",
        status: "failed",
        error: error instanceof Error ? error.message : String(error),
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
 * RED Phase: Write failing test
 */
async function runRedPhase(config: TDDConfig): Promise<TDDPhaseResult> {
  const phase: TDDPhaseResult = { name: "RED", status: "pending" };
  
  try {
    phase.status = "in_progress";
    
    // Create test file if it doesn't exist
    for (const testFile of config.testFiles) {
      if (!existsSync(testFile)) {
        const testContent = generateTestTemplate(testFile);
        ensureDir(dirname(testFile));
        writeFileSync(testFile, testContent);
      }
    }
    
    // Run test to verify it fails
    const result = runTests(config);
    if (result.failed === 0 && result.passed > 0) {
      phase.status = "failed";
      phase.error = "Test passed without implementation! Write test that fails first.";
      return phase;
    }
    
    phase.status = "completed";
    return phase;
  } catch (error) {
    phase.status = "failed";
    phase.error = String(error);
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
      if (!existsSync(sourceFile)) {
        const sourceContent = generateSourceTemplate(sourceFile);
        ensureDir(dirname(sourceFile));
        writeFileSync(sourceFile, sourceContent);
      }
    }
    
    // Run tests to verify they pass
    const result = runTests(config);
    if (result.failed > 0) {
      phase.status = "failed";
      phase.error = `${result.failed} tests still failing`;
      return phase;
    }
    
    phase.status = "completed";
    return phase;
  } catch (error) {
    phase.status = "failed";
    phase.error = String(error);
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
      phase.error = "Refactoring broke tests";
      return phase;
    }
    
    phase.status = "completed";
    return phase;
  } catch (error) {
    // REFACTOR failures are warnings, not blockers
    phase.status = "failed";
    phase.error = String(error);
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
  const fileName = basename(testFile, ".test.ts");
  
  return `/**
 * Test file for ${fileName}
 * RED phase: This test should FAIL
 */

import { describe, it, expect } from "bun:test";

describe("${fileName}", () => {
  it("should be implemented", () => {
    // TODO: Write actual test
    expect(true).toBe(false); // RED: Must fail
  });
});
`;
}

/**
 * Generate source file template
 */
function generateSourceTemplate(sourceFile: string): string {
  const fileName = basename(sourceFile, ".ts");
  
  return `/**
 * ${fileName}
 * GREEN phase: Minimal implementation to pass tests
 */

export function ${fileName.toLowerCase().replace(/[^a-z]/g, "_")}() {
  // TODO: Implement
  return {};
}
`;
}

/**
 * Ensure directory exists
 */
function ensureDir(dir: string): void {
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
}
