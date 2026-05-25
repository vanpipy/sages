/**
 * Tests for TDDRunner
 */

import { describe, it, expect, beforeEach } from "bun:test";
import { existsSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { TDDRunner, type TDDConfig } from "../../src/executor/tdd-runner.js";

describe("TDDRunner", () => {
  const testDir = "/tmp/tdd-test-" + Date.now();

  beforeEach(() => {
    if (!existsSync(testDir)) {
      mkdirSync(testDir, { recursive: true });
    }
  });

  describe("TDD Phases", () => {
    it("should complete RED phase with failing test", async () => {
      const config: TDDConfig = {
        taskId: "T1",
        taskDescription: "Test RED phase",
        sourceFiles: [join(testDir, "src", "red.ts")],
        testFiles: [join(testDir, "test", "red.test.ts")],
        testCommand: "echo 'Tests failed: 1'",
        cwd: testDir,
      };

      const runner = new TDDRunner(config);
      const result = await runner.run();

      // RED phase should complete (even if test fails as expected)
      expect(result.phases.length).toBe(3);
      expect(result.phases[0].name).toBe("RED");
    });

    it("should return proper TDD result structure", async () => {
      const config: TDDConfig = {
        taskId: "T2",
        taskDescription: "Test result structure",
        sourceFiles: [join(testDir, "src", "result.ts")],
        testFiles: [join(testDir, "test", "result.test.ts")],
        testCommand: "echo 'Tests passed'",
        cwd: testDir,
      };

      mkdirSync(join(testDir, "src"), { recursive: true });
      mkdirSync(join(testDir, "test"), { recursive: true });
      writeFileSync(join(testDir, "test", "result.test.ts"), "describe('test', () => { it('passes', () => {}); });");
      writeFileSync(join(testDir, "src", "result.ts"), "export const result = 1;");

      const runner = new TDDRunner(config);
      const result = await runner.run();

      expect(result.success).toBeDefined();
      expect(result.taskId).toBeDefined();
      expect(result.phases).toBeDefined();
      expect(result.testResults).toBeDefined();
      expect(result.duration).toBeDefined();
    });

    it("should have RED, GREEN, REFACTOR phases", async () => {
      const config: TDDConfig = {
        taskId: "T3",
        taskDescription: "Test phases exist",
        sourceFiles: [join(testDir, "src", "phases.ts")],
        testFiles: [join(testDir, "test", "phases.test.ts")],
        testCommand: "echo 'All tests passed'",
        cwd: testDir,
      };

      mkdirSync(join(testDir, "src"), { recursive: true });
      mkdirSync(join(testDir, "test"), { recursive: true });
      writeFileSync(join(testDir, "test", "phases.test.ts"), "describe('test', () => { it('passes', () => {}); });");
      writeFileSync(join(testDir, "src", "phases.ts"), "export const phases = 1;");

      const runner = new TDDRunner(config);
      const result = await runner.run();

      expect(result.phases.map(p => p.name)).toEqual(["RED", "GREEN", "REFACTOR"]);
    });
  });
});
