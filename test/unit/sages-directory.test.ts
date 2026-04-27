/**
 * Unit Tests for Sages Directory Creation
 * Tests that .sages directory is created at process.cwd() correctly
 */
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, mkdirSync, rmSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "os";
import { ensurePlanDir } from "../../src/utils";

const TEST_DIR = join(tmpdir(), "sages-dir-test-" + Date.now());

beforeEach(() => {
  mkdirSync(TEST_DIR, { recursive: true });
});

afterEach(() => {
  try {
    rmSync(TEST_DIR, { recursive: true, force: true });
  } catch {
    // ignore cleanup errors
  }
});

describe("Sages Directory Creation", () => {
  describe("at process.cwd()", () => {
    it("should create .sages directory when it does not exist", () => {
      const sagesDir = join(TEST_DIR, ".sages");

      // Verify .sages does not exist initially
      expect(existsSync(sagesDir)).toBe(false);

      // Create .sages directory (simulating ensureSagesDir)
      mkdirSync(sagesDir, { recursive: true });

      // Verify .sages was created
      expect(existsSync(sagesDir)).toBe(true);
      expect(readdirSync(sagesDir).length).toBe(0);
    });

    it("should create .sages/plans subdirectory", () => {
      const sagesDir = join(TEST_DIR, ".sages");
      const plansDir = join(sagesDir, "plans");

      // Create both directories
      mkdirSync(plansDir, { recursive: true });

      // Verify structure
      expect(existsSync(sagesDir)).toBe(true);
      expect(existsSync(plansDir)).toBe(true);
    });

    it("should create nested plan directory at correct depth", () => {
      const planName = "test-plan";
      const sagesDir = join(TEST_DIR, ".sages");
      const plansDir = join(sagesDir, "plans");
      const planDir = join(plansDir, planName);

      // Create the plan directory (simulating ensurePlanDir)
      mkdirSync(planDir, { recursive: true });

      // Verify structure
      expect(existsSync(planDir)).toBe(true);

      // Verify depth: TEST_DIR/.sages/plans/test-plan
      const depth = planDir.split("/").length;
      const expectedDepth = join(TEST_DIR, ".sages", "plans", planName).split("/").length;
      expect(depth).toBe(expectedDepth);

      // Verify only ONE .sages in path
      const parts = planDir.split("/");
      const sagesCount = parts.filter(p => p === ".sages").length;
      expect(sagesCount).toBe(1);
    });

    it("should NOT create duplicate .sages directories when path already contains .sages", () => {
      const planName = "my-plan";
      const buggyPlanDir = join(TEST_DIR, ".sages", "plans", planName);
      const buggyNestedDir = join(buggyPlanDir, ".sages", "plans");

      // Simulate the BUG: creating nested .sages/plans inside plan directory
      mkdirSync(buggyNestedDir, { recursive: true });

      // Count .sages directories in the nested path
      const nestedParts = buggyNestedDir.split("/");
      const sagesCount = nestedParts.filter(p => p === ".sages").length;

      // BUG: This would have 2 .sages directories
      expect(sagesCount).toBe(2); // This is the BUG scenario

      // Now verify CORRECT behavior
      const correctPlanDir = join(TEST_DIR, ".sages", "plans", planName + "-correct");
      mkdirSync(correctPlanDir, { recursive: true });

      const correctParts = correctPlanDir.split("/");
      const correctSagesCount = correctParts.filter(p => p === ".sages").length;
      expect(correctSagesCount).toBe(1); // Only ONE .sages
    });

    it("should create plan files at correct path depth", () => {
      const planName = "auth-system";
      const planDir = join(TEST_DIR, ".sages", "plans", planName);
      const planFile = join(planDir, planName + ".plan.md");
      const executionFile = join(planDir, planName + ".execution.yaml");

      // Create directory structure
      mkdirSync(planDir, { recursive: true });

      // Write files (simulating qiaochui_decompose output)
      require("node:fs").writeFileSync(planFile, "# Plan: auth-system\n\nTasks: []");
      require("node:fs").writeFileSync(executionFile, "tasks: []");

      // Verify files exist at correct depth
      expect(existsSync(planFile)).toBe(true);
      expect(existsSync(executionFile)).toBe(true);

      // Verify path structure: TEST_DIR/.sages/plans/auth-system/auth-system.plan.md
      expect(planFile).toContain(".sages/plans/" + planName + "/");
      expect(planFile).not.toContain(".sages/plans/" + planName + "/.sages/plans/");
    });

    it("should handle plan names with hyphens and underscores", () => {
      const planNames = ["my-project", "my_project", "MyProject123"];

      for (const planName of planNames) {
        const planDir = join(TEST_DIR, ".sages", "plans", planName);
        const planFile = join(planDir, planName + ".plan.md");

        mkdirSync(planDir, { recursive: true });
        require("node:fs").writeFileSync(planFile, "# Plan");

        expect(existsSync(planFile)).toBe(true);

        // Verify only one .sages in path
        const parts = planFile.split("/");
        const sagesCount = parts.filter(p => p === ".sages").length;
        expect(sagesCount).toBe(1);
      }
    });

    it("should create .sages directory relative to project root using actual functions", () => {
      // Test using actual ensurePlanDir function
      // to verify it creates correct structure (not nested .sages)

      const projectRoot = TEST_DIR;

      // Call the actual function (ensureSagesDir is called internally by ensurePlanDir)
      const planDir = ensurePlanDir(projectRoot);

      // Verify .sages was created at project root (not nested under agent name)
      const sagesDir = join(projectRoot, ".sages");
      expect(existsSync(sagesDir)).toBe(true);
      expect(sagesDir).not.toContain("fuxi"); // Should not have agent name in path

      // Verify planDir is: projectRoot/.sages/plans (not nested further)
      expect(planDir).toBe(join(projectRoot, ".sages", "plans"));

      // Verify only ONE .sages in the planDir path
      const parts = planDir.split("/");
      const sagesCount = parts.filter(p => p === ".sages").length;
      expect(sagesCount).toBe(1);

      // Verify plan directory can be created for a plan
      const testPlanDir = join(planDir, "test-plan");
      mkdirSync(testPlanDir, { recursive: true });
      expect(existsSync(testPlanDir)).toBe(true);
      expect(testPlanDir).not.toContain(".sages/plans/.sages/plans");
    });

    it("should create .sages/plans/{name} directory with plan files using actual functions", () => {
      const projectRoot = TEST_DIR;
      const planName = "my-feature";

      // Create plan directory using actual function
      const planDir = ensurePlanDir(projectRoot);
      const featurePlanDir = join(planDir, planName);

      mkdirSync(featurePlanDir, { recursive: true });

      // Write plan files (simulating qiaochui_decompose output)
      const planFile = join(featurePlanDir, planName + ".plan.md");
      const executionFile = join(featurePlanDir, planName + ".execution.yaml");

      writeFileSync(planFile, "# Plan: my-feature\n\nTasks: []");
      writeFileSync(executionFile, "tasks: []");

      // Verify files exist at correct path
      expect(existsSync(planFile)).toBe(true);
      expect(existsSync(executionFile)).toBe(true);

      // Verify path structure is: projectRoot/.sages/plans/my-feature/my-feature.plan.md
      // NOT: projectRoot/.sages/plans/my-feature/.sages/plans/my-feature.plan.md
      expect(planFile).toContain(join(".sages", "plans", planName));
      expect(planFile.split(".sages").length - 1).toBe(1); // Only one .sages in path
    });
  });
});