/**
 * Tests for task-runner
 * TDD RED Phase: Tests should FAIL until task-runner is implemented
 */

import { describe, it, expect } from "bun:test";
import { runTask, runTDDCycle } from "@/tools/luban/task-runner.js";
import type { TDDConfig, TaskResult } from "@/tools/luban/types.js";

describe("runTask", () => {
  it("should exist and be a function", () => {
    expect(typeof runTask).toBe("function");
  });
});

describe("runTDDCycle", () => {
  it("should exist and be a function", () => {
    expect(typeof runTDDCycle).toBe("function");
  });
});

describe("Scenarios → TDD Red phase integration", () => {
  it("generates a test file with one it() per scenario", () => {
    const { generateTestFromScenarios } = require("@/tools/luban/task-runner.js") as any;
    const scenarios = [
      { name: "valid login", given: "user exists", when: "user submits correct creds", then: "user is logged in" },
      { name: "invalid login", given: "user exists", when: "user submits wrong creds", then: "error is shown" },
    ];
    const content = generateTestFromScenarios("auth", scenarios);
    expect(content).toContain("it(\"valid login\"");
    expect(content).toContain("it(\"invalid login\"");
  });

  it("includes Given/When/Then as comments in each test block", () => {
    const { generateTestFromScenarios } = require("@/tools/luban/task-runner.js") as any;
    const scenarios = [
      { name: "test1", given: "precondition", when: "action", then: "result" },
    ];
    const content = generateTestFromScenarios("module", scenarios);
    expect(content).toContain("// Given: precondition");
    expect(content).toContain("// When: action");
    expect(content).toContain("// Then: result");
  });

  it("includes But clause when present", () => {
    const { generateTestFromScenarios } = require("@/tools/luban/task-runner.js") as any;
    const scenarios = [
      { name: "edge", given: "G", when: "W", then: "T", but: "B" },
    ];
    const content = generateTestFromScenarios("module", scenarios);
    expect(content).toContain("// But: B");
  });

  it("falls back to generic template when no scenarios provided", () => {
    const { generateTestFromScenarios } = require("@/tools/luban/task-runner.js") as any;
    const content = generateTestFromScenarios("module", []);
    expect(content).toContain("should be implemented");
    // The generic template has no scenario-specific it() blocks
    expect(content).not.toContain("// Given:");
  });
});

describe("validateScope (denyFiles guard)", () => {
  it("should exist and be a function", () => {
    const { validateScope } = require("@/tools/luban/task-runner.js") as any;
    expect(typeof validateScope).toBe("function");
  });

  it("returns ok when no files are denied", () => {
    const { validateScope } = require("@/tools/luban/task-runner.js") as any;
    const result = validateScope({
      sourceFiles: ["src/auth.ts"],
      testFiles: ["src/auth.test.ts"],
      denyFiles: [],
    });
    expect(result.ok).toBe(true);
    expect(result.violations).toEqual([]);
  });

  it("detects a sourceFile in denyFiles", () => {
    const { validateScope } = require("@/tools/luban/task-runner.js") as any;
    const result = validateScope({
      sourceFiles: ["src/auth.ts", "src/utils.ts"],
      testFiles: ["src/auth.test.ts"],
      denyFiles: ["src/auth.ts"],
    });
    expect(result.ok).toBe(false);
    expect(result.violations).toContain("src/auth.ts");
  });

  it("detects a testFile in denyFiles", () => {
    const { validateScope } = require("@/tools/luban/task-runner.js") as any;
    const result = validateScope({
      sourceFiles: ["src/auth.ts"],
      testFiles: ["src/auth.test.ts"],
      denyFiles: ["src/auth.test.ts"],
    });
    expect(result.ok).toBe(false);
    expect(result.violations).toContain("src/auth.test.ts");
  });

  it("reports multiple violations at once", () => {
    const { validateScope } = require("@/tools/luban/task-runner.js") as any;
    const result = validateScope({
      sourceFiles: ["src/a.ts", "src/b.ts"],
      testFiles: ["src/c.test.ts"],
      denyFiles: ["src/a.ts", "src/b.ts", "src/c.test.ts"],
    });
    expect(result.ok).toBe(false);
    expect(result.violations.length).toBe(3);
  });

  it("uses exact match, not substring (auth.ts vs auth.test.ts)", () => {
    const { validateScope } = require("@/tools/luban/task-runner.js") as any;
    const result = validateScope({
      sourceFiles: ["src/auth.test.ts"],
      testFiles: [],
      denyFiles: ["src/auth.ts"],
    });
    expect(result.ok).toBe(true);
  });

  it("includes a human-readable message in the result", () => {
    const { validateScope } = require("@/tools/luban/task-runner.js") as any;
    const result = validateScope({
      sourceFiles: ["src/auth.ts"],
      testFiles: [],
      denyFiles: ["src/auth.ts"],
    });
    expect(result.message).toContain("src/auth.ts");
    expect(result.message.toLowerCase()).toMatch(/scope|denied|out.of.scope/);
  });
});
