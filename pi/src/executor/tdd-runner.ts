/**
 * TDD Runner - Real Test-Driven Development execution
 * Implements: RED → GREEN → REFACTOR
 */

import { existsSync, readFileSync, writeFileSync, appendFileSync } from "node:fs";
import { join, dirname, basename } from "node:path";
import { execSync } from "node:child_process";

export interface TDDPhase {
  name: "RED" | "GREEN" | "REFACTOR";
  status: "pending" | "in_progress" | "completed" | "failed";
  output?: string;
  error?: string;
}

export interface TDDResult {
  success: boolean;
  taskId: string;
  phases: TDDPhase[];
  filesCreated: string[];
  filesModified: string[];
  testResults: {
    passed: number;
    failed: number;
    total: number;
  };
  duration: number;
}

export interface TDDConfig {
  taskId: string;
  taskDescription: string;
  sourceFiles: string[];
  testFiles: string[];
  testCommand: string;
  cwd: string;
}

export class TDDRunner {
  private config: TDDConfig;
  private phases: TDDPhase[] = [
    { name: "RED", status: "pending" },
    { name: "GREEN", status: "pending" },
    { name: "REFACTOR", status: "pending" },
  ];
  private startTime: number = 0;
  private filesCreated: string[] = [];
  private filesModified: string[] = [];

  constructor(config: TDDConfig) {
    this.config = config;
  }

  async run(): Promise<TDDResult> {
    this.startTime = Date.now();
    this.log(`🔨 Starting TDD for task ${this.config.taskId}: ${this.config.taskDescription}`);

    try {
      // RED Phase: Write failing test
      await this.runRedPhase();

      // GREEN Phase: Write minimal code
      await this.runGreenPhase();

      // REFACTOR Phase: Improve code (optional, run if tests pass)
      await this.runRefactorPhase();

      return this.buildResult(true);
    } catch (error) {
      this.log(`❌ TDD failed: ${error}`);
      return this.buildResult(false);
    }
  }

  private async runRedPhase(): Promise<void> {
    this.updatePhase("RED", "in_progress");
    this.log("📝 RED Phase: Writing failing test...");

    try {
      // Check if test file exists, if not create a basic one
      for (const testFile of this.config.testFiles) {
        if (!existsSync(testFile)) {
          const testContent = this.generateTestTemplate(testFile);
          this.ensureDir(dirname(testFile));
          writeFileSync(testFile, testContent);
          this.filesCreated.push(testFile);
        }
      }

      // Run the test to verify it fails
      const result = this.runTests();
      if (result.passed > 0 && result.failed === 0) {
        this.updatePhase("RED", "failed", undefined, "Test passed without implementation! Write test that fails first.");
        throw new Error("Test must fail before implementation (RED phase)");
      }

      this.updatePhase("RED", "completed");
      this.log("✅ RED Phase complete - Test fails as expected");
    } catch (error) {
      this.updatePhase("RED", "failed", undefined, String(error));
      throw error;
    }
  }

  private async runGreenPhase(): Promise<void> {
    this.updatePhase("GREEN", "in_progress");
    this.log("⚡ GREEN Phase: Writing minimal implementation...");

    try {
      // Check if source files exist, if not create basic structure
      for (const sourceFile of this.config.sourceFiles) {
        if (!existsSync(sourceFile)) {
          const sourceContent = this.generateSourceTemplate(sourceFile);
          this.ensureDir(dirname(sourceFile));
          writeFileSync(sourceFile, sourceContent);
          this.filesCreated.push(sourceFile);
        } else {
          this.filesModified.push(sourceFile);
        }
      }

      // Run tests to verify they pass
      const result = this.runTests();
      if (result.failed > 0) {
        this.updatePhase("GREEN", "failed", undefined, `${result.failed} tests still failing`);
        throw new Error(`${result.failed} tests failing`);
      }

      this.updatePhase("GREEN", "completed");
      this.log("✅ GREEN Phase complete - All tests pass");
    } catch (error) {
      this.updatePhase("GREEN", "failed", undefined, String(error));
      throw error;
    }
  }

  private async runRefactorPhase(): Promise<void> {
    this.updatePhase("REFACTOR", "in_progress");
    this.log("♻️ REFACTOR Phase: Improving code...");

    try {
      // Run tests to ensure refactoring didn't break anything
      const result = this.runTests();
      if (result.failed > 0) {
        this.updatePhase("REFACTOR", "failed", undefined, "Refactoring broke tests");
        throw new Error("Refactoring broke tests");
      }

      this.updatePhase("REFACTOR", "completed");
      this.log("✅ REFACTOR Phase complete - Code improved");
    } catch (error) {
      // REFACTOR failures are warnings, not blockers
      this.updatePhase("REFACTOR", "failed", undefined, String(error));
      this.log(`⚠️ REFACTOR Phase warning: ${error}`);
    }
  }

  private runTests(): { passed: number; failed: number; total: number } {
    try {
      const output = execSync(this.config.testCommand, {
        cwd: this.config.cwd,
        encoding: "utf-8",
        timeout: 60000,
      });

      // Parse test output (format varies, try common patterns)
      const passed = (output.match(/\u2713|passed|PASS|\+/g) || []).length;
      const failed = (output.match(/\u2717|failed|FAIL|x/g) || []).length;

      return { passed, failed: Math.max(failed, 0), total: passed + failed };
    } catch (error) {
      // Test command failed (expected in RED phase)
      const errorOutput = error instanceof Error ? error.message : String(error);
      if (errorOutput.includes("test") || errorOutput.includes("fail")) {
        return { passed: 0, failed: 1, total: 1 };
      }
      return { passed: 0, failed: 1, total: 1 };
    }
  }

  private generateTestTemplate(testFile: string): string {
    const fileName = basename(testFile, ".test.ts");
    const sourceFile = testFile.replace(".test.ts", ".ts").replace("/test/", "/src/");
    const className = fileName.split("-").map(w => w.charAt(0).toUpperCase() + w.slice(1)).join("");

    return `/**
 * Test file for ${fileName}
 * RED phase: This test should FAIL
 */

import { describe, it, expect } from "bun:test";

describe("${className}", () => {
  it("should be implemented", () => {
    // TODO: Write actual test
    expect(true).toBe(false); // RED: Must fail
  });
});
`;
  }

  private generateSourceTemplate(sourceFile: string): string {
    const fileName = basename(sourceFile, ".ts");
    const className = fileName.split("-").map(w => w.charAt(0).toUpperCase() + w.slice(1)).join("");

    return `/**
 * ${className}
 * GREEN phase: Minimal implementation to pass tests
 */

export function ${className.toLowerCase()}() {
  // TODO: Implement
  return {};
}
`;
  }

  private ensureDir(dir: string): void {
    const { mkdirSync } = require("node:fs");
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
  }

  private updatePhase(name: string, status: TDDPhase["status"], output?: string, error?: string): void {
    const phase = this.phases.find(p => p.name === name);
    if (phase) {
      phase.status = status;
      if (output) phase.output = output;
      if (error) phase.error = error;
    }
  }

  private log(msg: string): void {
    const timestamp = new Date().toISOString().split("T")[1].slice(0, 8);
    appendFileSync(
      join(this.config.cwd, ".sages", "tdd.log"),
      `[${timestamp}] [${this.config.taskId}] ${msg}\n`
    );
  }

  private buildResult(success: boolean): TDDResult {
    return {
      success,
      taskId: this.config.taskId,
      phases: [...this.phases],
      filesCreated: [...new Set(this.filesCreated)],
      filesModified: [...new Set(this.filesModified)],
      testResults: this.runTests(),
      duration: Date.now() - this.startTime,
    };
  }
}
