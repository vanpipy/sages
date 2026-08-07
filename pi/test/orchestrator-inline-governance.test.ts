/**
 * orchestrator-inline-governance.test.ts — GC-2026-039
 *
 * Tests the inline governance check function in orchestrator-audit.ts.
 * The full extractAuditFindings parser is in pi-subagents (5 rules);
 * this tests the 3-rule inline subset that the orchestrator can call
 * without crossing the package boundary.
 */

import { describe, expect, it } from "bun:test";

import { runInlineGovernanceCheck } from "../src/tools/orchestrator/orchestrator-audit.js";

describe("runInlineGovernanceCheck (GC-2026-039)", () => {
	it("T-INLINE-01: returns no findings for a well-formed task report", () => {
		const report = `# T1 Report
\`\`\`yaml
status: completed
deliverables:
  commits: ["abc1234"]
  files_changed: ["src/foo.ts"]
test_results:
  pass: 5
  fail: 0
open_questions: []
\`\`\``;
		expect(runInlineGovernanceCheck("T1", report)).toEqual([]);
	});

	it("T-INLINE-02: detects missing YAML block (major)", () => {
		const report = "Just a plain text report, no YAML.";
		const findings = runInlineGovernanceCheck("T1", report);
		const violation = findings.find(
			(f) => f.rule === "inline_yaml_block_missing",
		);
		expect(violation).toBeDefined();
		expect(violation!.severity).toBe("major");
	});

	it("T-INLINE-03: detects 2 consecutive checkpoints with same commit count (major)", () => {
		const report = `# T1
\`\`\`yaml
status: completed
deliverables:
  commits: ["abc"]
  files_changed: []
test_results:
  pass: 1
  fail: 0
open_questions: []
\`\`\`
[checkpoint 5/200 turns, 1m32s] nothing. 0 commits.
[checkpoint 10/200 turns, 3m15s] still nothing. 0 commits.`;
		const findings = runInlineGovernanceCheck("T1", report);
		const violation = findings.find(
			(f) => f.rule === "inline_checkpoint_stuck",
		);
		expect(violation).toBeDefined();
		expect(violation!.severity).toBe("major");
	});

	it("T-INLINE-04: 2 checkpoints with DIFFERENT commit counts do NOT fire", () => {
		const report = `[checkpoint 5/200 turns, 1m32s] 0 commits.
[checkpoint 10/200 turns, 3m15s] 1 commits.`;
		const findings = runInlineGovernanceCheck("T1", report);
		const violation = findings.find(
			(f) => f.rule === "inline_checkpoint_stuck",
		);
		expect(violation).toBeUndefined();
	});

	it("T-INLINE-05: detects BLOCKED with no commits and no open_questions (minor)", () => {
		const report = `# T1
\`\`\`yaml
status: blocked
deliverables:
  commits: []
  files_changed: []
test_results:
  pass: 0
  fail: 0
open_questions: []
\`\`\``;
		const findings = runInlineGovernanceCheck("T1", report);
		const violation = findings.find(
			(f) => f.rule === "inline_blocked_no_reason",
		);
		expect(violation).toBeDefined();
		expect(violation!.severity).toBe("minor");
	});

	it("T-INLINE-06: BLOCKED with open_questions does NOT fire blocked_no_reason", () => {
		const report = `# T1
\`\`\`yaml
status: blocked
deliverables:
  commits: []
  files_changed: []
test_results:
  pass: 0
  fail: 0
open_questions:
  - question: "What API?"
    why_blocking: true
\`\`\``;
		const findings = runInlineGovernanceCheck("T1", report);
		const violation = findings.find(
			(f) => f.rule === "inline_blocked_no_reason",
		);
		expect(violation).toBeUndefined();
	});
});
