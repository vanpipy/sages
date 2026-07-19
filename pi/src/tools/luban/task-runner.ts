/**
 * Task Runner - TDD phase validators for luban_execute_task
 *
 * Part of: src/tools/luban/
 *
 * Provides the helpers used by luban_execute_task's observe cycle:
 *   - runTests:           shell out to a test command and parse pass/fail counts
 *   - validateScope:      enforce the deny_files scope guard
 *   - TDD_GUIDE:          phase-specific error-message helper
 *
 * The actual implementation work is done by the LLM via semantic tools
 * (sages_* / codebase-memory / graphify). This module only validates the
 * test outcomes the LLM observes.
 *
 * Removed (post simplify-actions):
 *   - runTask, runTDDCycle: the batch-style phase runners; replaced by the
 *     observe cycle inside luban_execute_task itself.
 *   - generateTestFromScenarios: template scaffolding generator. The LLM
 *     writes tests via sages_write_file, so this is dead.
 *   - ScenarioSpec: only consumed by generateTestFromScenarios.
 *
 * SECURITY: testCommand is passed unsanitized to `execSync()`.
 * Indirect RCE chain: user request → qiaochui_decompose → execution.yaml
 * testCommand → execSync. Treat the executor environment as trusted; if running
 * LuBan against untrusted requests, sandbox at the process level.
 */

import { execSync } from "node:child_process";

// ============================================================================
// TDD Fallback Guide - Help the agent when exceptions occur
// ============================================================================

export const TDD_GUIDE = {
  /**
   * Get guidance message for a specific phase failure
   */
  getPhaseGuidance(phase: string, error?: string): string {
    const phaseName = phase.toUpperCase();
    const baseGuides: Record<string, string> = {
      RED: [
        "RED Phase Guidance:",
        "- Write a failing test FIRST",
        "- The test must exercise the missing behavior",
        "- Do NOT proceed to GREEN until `bun test` reports failures",
      ].join("\n"),
      GREEN: [
        "GREEN Phase Guidance:",
        "- Write MINIMAL implementation that makes the test pass",
        "- Do NOT refactor or add extra features yet",
        "- Resist the urge to over-engineer",
      ].join("\n"),
      REFACTOR: [
        "REFACTOR Phase Guidance:",
        "- Improve code structure WITHOUT changing behavior",
        "- Tests must STILL pass after each refactor",
        "- Remove duplication, improve naming, simplify logic",
      ].join("\n"),
    };

    const guide = baseGuides[phaseName] ||
      [
        "TDD Fallback Guidance:",
        "- RED: write a failing test first",
        "- GREEN: write the minimal code to make it pass",
        "- REFACTOR: improve without changing behavior",
      ].join("\n");

    return error ? `${error}\n\n${guide}` : guide;
  },

  /**
   * General TDD guidance (when no specific phase applies)
   */
  getGeneralGuidance(error?: string): string {
    const tddCycle = [
      "TDD cycle: RED → GREEN → REFACTOR.",
      "- RED: write a failing test that captures the requirement",
      "- GREEN: write the minimal code to make the test pass",
      "- REFACTOR: improve the code while keeping tests passing",
    ].join("\n");

    return error ? `${error}\n\n${tddCycle}` : tddCycle;
  },

  /**
   * Format an error with phase-specific guidance.
   * Returns a string suitable for direct inclusion in a tool error response.
   */
  formatError(phase: string, error: string | Error): string {
    const errorMsg = error instanceof Error ? error.message : error;
    const phaseName = phase.toUpperCase();
    return `${errorMsg}\n\n${TDD_GUIDE.getPhaseGuidance(phaseName)}`;
  },
};

// ============================================================================
// Test runner - shell out to a test command
// ============================================================================

export interface RunTestsResult {
  /** Exit code from the test command. 0 = all passed. */
  exitCode: number;
  /** Combined stdout + stderr from the test run. */
  output: string;
  /** Number of passing tests (parsed from output). */
  passed: number;
  /** Number of failing tests (parsed from output). */
  failed: number;
}

/**
 * Run the test command and capture the result.
 * Strips ANSI escape codes from output before returning.
 */
export function runTests(config: { testCommand: string; cwd: string }): RunTestsResult {
  let exitCode: number;
  let output = "";
  try {
    const stdout = execSync(config.testCommand, {
      cwd: config.cwd,
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, FORCE_COLOR: "0" },
    });
    exitCode = 0;
    output = stripAnsi(stdout);
  } catch (err) {
    // Non-zero exit = test failure (still useful data, not an exception)
    const e = err as { status?: number; stdout?: string; stderr?: string };
    exitCode = e.status ?? 1;
    output = stripAnsi(((e.stdout ?? "") + "\n" + (e.stderr ?? "")) || (err instanceof Error ? err.message : String(err)));
  }
  const { passed, failed } = parseBunOutput(output);
  return { exitCode, output, passed, failed };
}

function stripAnsi(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\x1b\[[0-9;]*m/g, "");
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
// Scope guard - enforce deny_files
// ============================================================================

export interface ScopeConfig {
  /** Files the task will touch. */
  files: string[];
  /** Files that must NOT be touched (out-of-scope per draft.md). */
  deny_files?: string[];
}

export interface ScopeResult {
  /** True if no scope violation. */
  valid: boolean;
  /** First violation found, if any. */
  violation?: {
    file: string;
    matched_deny: string;
  };
}

/**
 * Check that no task file matches any deny_files entry (exact match or
 * relative path match).
 */
export function validateScope(config: ScopeConfig): ScopeResult {
  if (!config.deny_files || config.deny_files.length === 0) {
    return { valid: true };
  }

  for (const file of config.files) {
    for (const denied of config.deny_files) {
      if (file === denied || file.endsWith(`/${denied}`)) {
        return {
          valid: false,
          violation: { file, matched_deny: denied },
        };
      }
    }
  }
  return { valid: true };
}