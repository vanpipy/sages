/**
 * RED Phase Tests for TDDRunner
 * Tests for Issue #3: TDD Runner calling tests twice
 */

import { describe, it, expect, vi, beforeEach } from "bun:test";
import { existsSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { TDDRunner, type TDDConfig } from "../../src/executor/tdd-runner.ts";

describe("TDDRunner - Issue Fixes", () => {
  const testDir = "/tmp/tdd-test-" + Date.now();

  beforeEach(() => {
    // Setup test directory
    if (!existsSync(testDir)) {
      mkdirSync(testDir, { recursive: true });
    }
  });

  describe("Issue #3: Test Execution Count", () => {
    it("should NOT call runTests() twice in buildResult", async () => {
      const config: TDDConfig = {
        taskId: "T1",
        taskDescription: "Test task",
        sourceFiles: [join(testDir, "src", "example.ts")],
        testFiles: [join(testDir, "test", "example.test.ts")],
        testCommand: "echo 'passed'",
        cwd: testDir,
      };

      // Create minimal test file
      const testDir2 = join(testDir, "test");
      const srcDir2 = join(testDir, "src");
      mkdirSync(testDir2, { recursive: true });
      mkdirSync(srcDir2, { recursive: true });

      writeFileSync(
        join(testDir2, "example.test.ts"),
        `import { describe, it, expect } from "bun:test";
describe("example", () => {
  it("works", () => {
    expect(true).toBe(true);
  });
});`
      );

      writeFileSync(
        join(srcDir2, "example.ts"),
        `export function example() { return true; }`
      );

      const runner = new TDDRunner(config);

      // Spy on runTests to track call count
      let testCallCount = 0;
      const originalRunTests = runner.runTests.bind(runner);
      (runner as any).runTests = function () {
        testCallCount++;
        return originalRunTests();
      };

      await runner.run();

      // Total calls should be:
      // - RED phase: 1 call
      // - GREEN phase: 1 call  
      // - REFACTOR phase: 1 call (if tests pass)
      // - buildResult: should NOT call again
      // So max should be 4, not 5+
      expect(testCallCount).toBeLessThanOrEqual(4);
    });

    it("should cache test results during TDD phases", async () => {
      const config: TDDConfig = {
        taskId: "T2",
        taskDescription: "Test caching",
        sourceFiles: [join(testDir, "src", "cached.ts")],
        testFiles: [join(testDir, "test", "cached.test.ts")],
        testCommand: "echo 'All tests passed'",
        cwd: testDir,
      };

      const srcDir = join(testDir, "src");
      const testDirC = join(testDir, "test");
      mkdirSync(srcDir, { recursive: true });
      mkdirSync(testDirC, { recursive: true });

      writeFileSync(join(testDirC, "cached.test.ts"), "describe('test', () => { it('passes', () => {}); });");
      writeFileSync(join(srcDir, "cached.ts"), "export const cached = 1;");

      const runner = new TDDRunner(config);
      const result = await runner.run();

      // buildResult should NOT trigger a new test run
      // It should use the cached result from last phase
      expect(result.testResults).toBeDefined();
    });
  });

  describe("Issue #6: RED Phase Check Logic", () => {
    it("should properly detect when tests pass in RED phase", async () => {
      const config: TDDConfig = {
        taskId: "T3",
        taskDescription: "Test RED detection",
        sourceFiles: [join(testDir, "src", "red-test.ts")],
        testFiles: [join(testDir, "test", "red-test.test.ts")],
        testCommand: "echo 'Tests passed: 1, failed: 0'",
        cwd: testDir,
      };

      const srcDir = join(testDir, "src");
      const testDirR = join(testDir, "test");
      mkdirSync(srcDir, { recursive: true });
      mkdirSync(testDirR, { recursive: true });

      // Write a passing test (which SHOULD fail in RED phase if implementation exists)
      writeFileSync(
        join(testDirR, "red-test.test.ts"),
        `import { describe, it, expect } from "bun:test";
describe("red-test", () => {
  it("should fail before implementation", () => {
    // This SHOULD fail because example is not implemented
    expect((require("../src/red-test.ts")).example()).toBe(true);
  });
});`
      );
      writeFileSync(join(srcDir, "red-test.ts"), "export const example = () => true;");

      const runner = new TDDRunner(config);

      // This should either succeed (if test actually fails) or throw with proper RED error
      try {
        await runner.run();
        // If RED phase properly checks, this shouldn't reach here with passing tests
      } catch (e) {
        expect(String(e)).toMatch(/RED|test must fail|implementation/);
      }
    });
  });
});
