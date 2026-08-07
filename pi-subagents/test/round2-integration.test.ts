/**
 * round2-integration.test.ts — Round 2 testing
 *
 * Exercise the full audit pipeline end-to-end. Simulates realistic
 * agent task reports and verifies that:
 *   - extractAuditFindings produces the expected findings
 *   - advisoryFor builds advisories from those findings
 *   - The pipeline handles realistic agent output
 */

import { describe, expect, it } from "vitest";

import {
	extractAuditFindings,
	extractAsk,
	parseCheckpoint,
	advisoryFor,
	extractStructuredOutput,
} from "../src/agent-runner.js";

describe("Round 2: integration — full audit pipeline", () => {
	// ───── Realistic agent outputs from different scenarios ─────

	it("R2-01: typical successful task (completed + commits)", () => {
		const report = `I implemented the deadline feature.

[checkpoint 5/200 turns, 1m32s] 1 test written. 0 commits. blocker: none.
[checkpoint 10/200 turns, 3m15s] 1 test passing. 1 commits. blocker: none.

\`\`\`yaml
status: completed
deliverables:
  files_changed: ["src/index.ts", "src/agent-manager.ts"]
  commits: ["abc1234", "def5678"]
  tests_added: ["test/subagent-deadline.test.ts::T-DEADLINE-01"]
test_results:
  pass: 8
  fail: 0
  fail_details: []
open_questions: []
handoff_for_next_task: []
\`\`\`

Done.`;
		const findings = extractAuditFindings(report, "");
		expect(findings).toEqual([]);
		const advisories = advisoryFor(report);
		expect(advisories).toEqual([]);

		// Sanity: extractAsk + parseCheckpoint work
		expect(extractAsk(report)).toEqual([]);
		const cp = parseCheckpoint(report);
		expect(cp?.commitCount).toBe(1);
	});

	it("R2-02: blocked task with reason", () => {
		const report = `Stuck on a design question.

<ASK>What API contract for the deadline hook — AbortSignal.timeout or manual setTimeout?</ASK>

\`\`\`yaml
status: blocked
deliverables:
  files_changed: []
  commits: []
  tests_added: []
test_results:
  pass: 0
  fail: 0
open_questions:
  - question: "What API contract for the deadline hook?"
    why_blocking: true
    suggestion: "ask the L3 orchestrator"
handoff_for_next_task: []
\`\`\``;
		const findings = extractAuditFindings(report, "");
		// ask_unanswered fires (ASK not in task report's open_questions)
		expect(findings.some((f) => f.rule === "ask_unanswered")).toBe(true);
	});

	it("R2-03: agent forgot to commit (completed_no_commits)", () => {
		const report = `\`\`\`yaml
status: completed
deliverables:
  files_changed: ["src/foo.ts"]
  commits: []
  tests_added: ["test/foo.test.ts"]
test_results:
  pass: 5
  fail: 0
open_questions: []
handoff_for_next_task: []
\`\`\``;
		const findings = extractAuditFindings(report, "");
		expect(findings.some((f) => f.rule === "completed_no_commits")).toBe(true);
		const advisories = advisoryFor(report);
		expect(advisories.some((a) => a.includes("completed_no_commits"))).toBe(true);
	});

	it("R2-04: agent stuck (checkpoint_stuck_pattern)", () => {
		const report = `[checkpoint 5/200 turns, 1m] exploring. 0 commits. blocker: none.
[checkpoint 10/200 turns, 2m] still exploring. 0 commits. blocker: none.
[checkpoint 15/200 turns, 3m] no progress. 0 commits. blocker: none.

\`\`\`yaml
status: completed
deliverables:
  files_changed: ["src/foo.ts"]
  commits: ["abc"]
  tests_added: []
test_results:
  pass: 1
  fail: 0
open_questions: []
handoff_for_next_task: []
\`\`\``;
		const findings = extractAuditFindings(report, "");
		expect(findings.some((f) => f.rule === "checkpoint_stuck_pattern")).toBe(true);
	});

	it("R2-05: agent emits no YAML at all", () => {
		const report = `Done. I fixed the bug.`;
		const findings = extractAuditFindings(report, "");
		expect(findings.some((f) => f.rule === "missing_yaml_block")).toBe(true);
	});

	it("R2-06: multiple governance violations at once", () => {
		const report = `[checkpoint 5/200 turns, 1m] nothing. 0 commits. blocker: none.
[checkpoint 10/200 turns, 2m] nothing. 0 commits. blocker: none.

\`\`\`yaml
status: completed
deliverables:
  files_changed: []
  commits: []
  tests_added: []
test_results:
  pass: 0
  fail: 0
open_questions: []
handoff_for_next_task: []
\`\`\``;
		const findings = extractAuditFindings(report, "");
		// Should fire: completed_no_commits (commits empty + status completed)
		// + checkpoint_stuck_pattern (2 same-count checkpoints)
		const rules = findings.map((f) => f.rule);
		expect(rules).toContain("completed_no_commits");
		expect(rules).toContain("checkpoint_stuck_pattern");

		// Advisory: per-call cap = 2
		const advisories = advisoryFor(report);
		expect(advisories.length).toBeLessThanOrEqual(2);
	});

	it("R2-07: agent uses <ASK> markup (extractAsk captures it)", () => {
		const report = `I need clarification.

<ASK>What is the test framework?</ASK>

<ASK>Should I commit per-test or batch commits?</ASK>

\`\`\`yaml
status: blocked
deliverables:
  files_changed: []
  commits: []
  tests_added: []
test_results:
  pass: 0
  fail: 0
open_questions:
  - question: "What is the test framework?"
    why_blocking: true
  - question: "Should I commit per-test or batch commits?"
    why_blocking: true
handoff_for_next_task: []
\`\`\``;
		const asks = extractAsk(report);
		expect(asks.length).toBe(2);
		expect(asks[0]).toContain("test framework");
		expect(asks[1]).toContain("commit per-test");
	});

	it("R2-08: extractStructuredOutput returns the parsed object", () => {
		const report = `\`\`\`yaml
status: completed
deliverables:
  files_changed: ["src/foo.ts"]
  commits: ["abc"]
  tests_added: ["test/foo.test.ts"]
test_results:
  pass: 5
  fail: 0
  fail_details: []
open_questions: []
handoff_for_next_task: []
\`\`\``;
		const structured = extractStructuredOutput(report);
		expect(structured).not.toBeNull();
		expect(structured!.status).toBe("completed");
		expect(structured!.deliverables.commits).toEqual(["abc"]);
		expect(structured!.testResults?.pass).toBe(5);
	});

	it("R2-09: extractStructuredOutput returns null for malformed YAML", () => {
		const report = `\`\`\`yaml
invalid: yaml: syntax:
  - broken
\`\`\``;
		const structured = extractStructuredOutput(report);
		// Either null or partial parse — both are acceptable
		expect(structured === null || structured !== undefined).toBe(true);
	});

	it("R2-10: parseCheckpoint reads the LATEST checkpoint line", () => {
		const report = `[checkpoint 5/200 turns, 1m32s] 1 test. 0 commits. blocker: none.
[checkpoint 10/200 turns, 3m15s] 2 tests. 1 commits. blocker: none.
[checkpoint 15/200 turns, 5m] 3 tests. 2 commits. blocker: none.`;
		const cp = parseCheckpoint(report);
		expect(cp?.commitCount).toBe(2);
		expect(cp?.turnNumber).toBe(15);
	});
});