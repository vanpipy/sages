/**
 * Task Runner - TDD phase execution (RED / GREEN / REFACTOR)
 *
 * Part of: src/tools/luban/
 *
 * Design (post-simplify-actions):
 *   - runTask executes ONE phase of a task. It does NOT write template stubs
 *     or invoke an LLM directly. The LLM (in main context) does the actual
 *     semantic work via serena / codebase-memory / graphify, then re-calls
 *     luban_execute_task with an observation to validate.
 *   - Per-task state is managed by TaskStateManager (in tools/index.ts).
 *
 * SECURITY: testCommand is passed unsanitized to `execSync()`.
 * Indirect RCE chain: user request → qiaochui_decompose → execution.yaml
 * testCommand → execSync. Treat the executor environment as trusted; if running
 * LuBan against untrusted requests, sandbox at the process level.
 */

import { execSync } from "node:child_process";
import type { TDDConfig, TaskResult, TDDPhaseResult } from "./types.js";

// ============================================================================
// TDD Fallback Guide - Help the agent when exceptions occur
// ============================================================================

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
    return `${error}\n\n${this.getPhaseGuidance(phase, error)}`;
  },
};

// ============================================================================
// runTests — exit-code based, no more character counting
// ============================================================================

/**
 * Run a test command. The runner treats exit code 0 as "passed" and any
 * non-zero exit as "failed". Output is captured for diagnostics.
 *
 * The output parse tries to extract bun test's "(N) pass / (M) fail" format
 * for richer reporting, but falls back to a binary passed/failed if the
 * format isn't recognized.
 */
export interface RunTestsResult {
  passed: number;
  failed: number;
  total: number;
  exitCode: number;
  output: string;
}

export function runTests(config: { testCommand: string; cwd: string }): RunTestsResult {
  try {
    const output = execSync(config.testCommand, {
      cwd: config.cwd,
      encoding: "utf-8",
      timeout: 60000,
      stdio: ["ignore", "pipe", "pipe"],
    });

    const { passed, failed } = parseBunOutput(output);
    return { passed, failed, total: passed + failed, exitCode: 0, output };
  } catch (err) {
    const anyErr = err as { stdout?: Buffer | string; stderr?: Buffer | string; status?: number };
    const stdout = anyErr.stdout ? anyErr.stdout.toString() : "";
    const stderr = anyErr.stderr ? anyErr.stderr.toString() : "";
    const { passed, failed } = parseBunOutput(stdout + stderr);
    const exitCode = anyErr.status ?? 1;
    return {
      passed,
      failed: Math.max(failed, 1),
      total: passed + Math.max(failed, 1),
      exitCode,
      output: stdout + stderr,
    };
  }
}

function parseBunOutput(output: string): { passed: number; failed: number } {
  // bun test outputs like "(2) [123.45ms] ✓ test name\n\n 1 pass\n 2 fail"
  // We look for the trailing pass/fail summary line.
  const passedMatch = output.match(/(\d+)\s+pass/);
  const failedMatch = output.match(/(\d+)\s+fail/);
  return {
    passed: passedMatch ? parseInt(passedMatch[1], 10) : 0,
    failed: failedMatch ? parseInt(failedMatch[1], 10) : 0,
  };
}

// ============================================================================
// runTask — single-phase validation, no template stubs
// ============================================================================

/**
 * Run a single TDD phase for a task. The function does NOT write any files
 * (template stubs are gone — the LLM writes real code via semantic tools).
 *
 * It validates:
 *   - The phase's expected outcome (RED: test fails, GREEN: test passes, REFACTOR: test passes)
 *
 * Returns a TaskResult describing what happened.
 */
export async function runTask(config: TDDConfig): Promise<TaskResult> {
  const startTime = Date.now();
  try {
    const result = runTests({ testCommand: config.testCommand, cwd: config.cwd });

    let status: TDDPhaseResult["status"] = "completed";
    let error: string | undefined;
    let output = result.output;

    // The phase name is implicit in the call — caller sets context. We treat
    // a single runTask invocation as one phase verification. The caller
    // (luban_execute_task tool) wraps this with the appropriate contract.
    if (result.exitCode !== 0) {
      status = "failed";
      error = `Tests failed: ${result.failed} failed, ${result.passed} passed`;
    }

    return {
      taskId: config.taskId,
      success: status === "completed",
      duration: Date.now() - startTime,
      phases: [
        {
          name: "RED", // placeholder; tool layer interprets
          status,
          output,
          error,
        },
      ],
    };
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    return {
      taskId: config.taskId,
      success: false,
      duration: Date.now() - startTime,
      phases: [
        {
          name: "RED",
          status: "failed",
          error: TDD_GUIDE.formatError("RED", errorMessage),
        },
      ],
    };
  }
}

/**
 * Run TDD cycle (kept for backward compat). Note: this no longer does the
 * full RED→GREEN→REFACTOR sequence internally — each phase is now driven
 * by the tool layer's observe cycle. This function is a thin wrapper.
 */
export async function runTDDCycle(_config: TDDConfig): Promise<TDDPhaseResult[]> {
  return [];
}

// ============================================================================
// Test template generation (kept for backward compat with existing tests)
// ============================================================================

/**
 * Extract filename from path
 */
function getFileName(filePath: string): string {
  const parts = filePath.split("/");
  const fileName = parts[parts.length - 1];
  return fileName.replace(/\.(test\.)?(ts|js)$/, "");
}

/**
 * Escape a scenario name for use in it()
 */
function escapeForIt(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

export interface ScenarioSpec {
  name: string;
  given: string;
  when: string;
  then: string;
  but?: string;
}

/**
 * Generate a test file from V-cases (Given/When/Then scenarios).
 * Kept for tool-layer use: when the LLM is in RED phase and asks for
 * test scaffolding, this produces the test file template.
 */
export function generateTestFromScenarios(
  testFileOrModule: string,
  scenarios: ScenarioSpec[],
): string {
  const fileName = getFileName(testFileOrModule);

  if (!scenarios || scenarios.length === 0) {
    return `/**
 * Test file for ${fileName}
 * RED phase: this test should fail until implementation exists.
 */
import { describe, it, expect } from "bun:test";

describe("${fileName}", () => {
  it("should be implemented", () => {
    expect(true).toBe(false); // RED placeholder
  });
});
`;
  }

  const testBlocks = scenarios.map((s, i) => {
    const but = s.but ? `\n    // But: ${s.but}` : "";
    return `  it("${escapeForIt(s.name)}", () => {
    // Given: ${s.given}
    // When: ${s.when}
    // Then: ${s.then}${but}
    expect(true).toBe(false); // RED placeholder
  });`;
  }).join("\n\n");

  return `/**
 * Test file for ${fileName}
 * RED phase: each scenario should fail until implementation exists.
 *
 * Generated from draft.md ## Scenarios section.
 * Agent must replace the placeholder assertions with real ones
 * that verify the Given/When/Then contract.
 */
import { describe, it, expect } from "bun:test";

describe("${fileName}", () => {
${testBlocks}
});
`;
}

// ============================================================================
// Scope Guard
// ============================================================================

export interface ScopeConfig {
  sourceFiles: string[];
  testFiles: string[];
  denyFiles: string[];
}

export interface ScopeResult {
  ok: boolean;
  violations: string[];
  message: string;
}

/**
 * Validate that no source/test file is in the denyFiles list.
 * Returns {ok, violations, message} — message is human-readable.
 * Pure function: no I/O, no side effects. Easy to test.
 */
export function validateScope(config: ScopeConfig): ScopeResult {
  const deny = config.denyFiles || [];
  if (deny.length === 0) {
    return { ok: true, violations: [], message: "" };
  }

  const denySet = new Set(deny);
  const violations: string[] = [];

  for (const f of config.sourceFiles) {
    if (denySet.has(f)) violations.push(f);
  }
  for (const f of config.testFiles) {
    if (denySet.has(f)) violations.push(f);
  }

  if (violations.length === 0) {
    return { ok: true, violations: [], message: "" };
  }

  return {
    ok: false,
    violations,
    message: `Scope guard: the following files are marked as "Out of Scope" in draft.md and must not be touched:\n${violations.map((v) => `  - ${v}`).join("\n")}\n\nEither remove them from denyFiles, or pick a different file for this task.`,
  };
}