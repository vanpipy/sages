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
