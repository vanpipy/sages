/**
 * Round 5: verification_cmd linter — rejects placeholders
 *
 * Submit a goal with placeholder verification_cmd ("echo yes", "pwd",
 * "true"). Expected: validation rejects with structured error pointing
 * to the placeholder.
 */

import { describe, it, expect } from "bun:test";
import {
  isPlaceholderVerificationCmd,
  validateVerificationCmd,
} from "@/tools/orchestrator/verification-cmd-linter.js";
import {
  validateGoalContractWithVerifierLinter,
} from "@/tools/orchestrator/goal-contract.js";

describe("Round 5: verification_cmd linter — rejects placeholder", () => {
  const PLACEHOLDERS = ["echo yes", "echo ok", "echo done", "true", ":", "cd .", "exit 0"];

  for (const cmd of PLACEHOLDERS) {
    it(`rejects '${cmd}' as placeholder`, () => {
      expect(isPlaceholderVerificationCmd(cmd)).toBe(true);
    });
  }

  it("validateVerificationCmd returns errors[] for placeholder", async () => {
    const r = await validateVerificationCmd("echo yes");
    expect(r.valid).toBe(false);
    expect(r.errors[0]).toContain("placeholder");
    expect(r.errors[0]).toContain("echo yes");
  });

  it("validateGoalContractWithVerifierLinter rejects goal with placeholder SC", () => {
    const r = validateGoalContractWithVerifierLinter({
      id: "GC-2026-TEST",
      title: "Test goal",
      rationale: "For testing",
      success_criteria: [
        {
          id: "SC1",
          criterion: "Test criterion",
          verification_cmd: "echo yes",
        },
      ],
      anti_goals: [],
      scope: { include: ["src/"], exclude: [] },
      constraints: {},
      done_definition: "Done",
    });
    expect(r.valid).toBe(false);
    expect(r.errors[0]).toMatch(/SC1.*placeholder/);
  });
});