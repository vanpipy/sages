/**
 * Round 6: verification_cmd linter — accepts real commands
 *
 * Submit a goal with real verification_cmd ("bun test ./src", "pwd"
 * is actually fine since it outputs working dir — wait no, pwd is
 * rejected. Use "cat README.md" or "ls -la" instead).
 */

import { describe, it, expect } from "bun:test";
import {
  isPlaceholderVerificationCmd,
  validateVerificationCmd,
  runVerificationProbe,
} from "@/tools/orchestrator/verification-cmd-linter.js";
import {
  validateGoalContractWithVerifierLinter,
} from "@/tools/orchestrator/goal-contract.js";

describe("Round 6: verification_cmd linter — accepts real commands", () => {
  const REAL_COMMANDS = [
    "bun test ./src",
    "ls -la",
    "cat README.md",
    "grep -r TODO src/",
  ];

  for (const cmd of REAL_COMMANDS) {
    it(`accepts '${cmd}'`, () => {
      expect(isPlaceholderVerificationCmd(cmd)).toBe(false);
    });
  }

  it("validateVerificationCmd passes real command", async () => {
    const r = await validateVerificationCmd("echo hello world");
    expect(r.valid).toBe(true);
    expect(r.errors).toEqual([]);
  });

  it("runVerificationProbe runs real command and reports meaningful output", async () => {
    const r = await runVerificationProbe("echo probe-output");
    expect(r.ran).toBe(true);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("probe-output");
    expect(r.meaningful).toBe(true);
  });

  it("validateGoalContractWithVerifierLinter accepts goal with real SC", () => {
    const r = validateGoalContractWithVerifierLinter({
      id: "GC-2026-REAL",
      title: "Real goal",
      rationale: "For testing",
      success_criteria: [
        {
          id: "SC1",
          criterion: "Bun tests pass",
          verification_cmd: "bun test ./src",
        },
      ],
      anti_goals: [],
      scope: { include: ["src/"], exclude: [] },
      constraints: {},
      done_definition: "Done",
    });
    expect(r.valid).toBe(true);
    expect(r.errors).toEqual([]);
  });
});