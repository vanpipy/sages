/**
 * audit-findings.test.ts — GC-2026-039
 *
 * Tests the `extractAuditFindings` combined parser. Each rule has at
 * least one positive case (rule fires) and one negative case (rule
 * doesn't fire on a well-formed message).
 */

import { describe, expect, it } from "vitest";

import { extractAuditFindings } from "../src/agent-runner.js";

const WELL_FORMED_YAML = `I finished the task.

\`\`\`yaml
status: completed
deliverables:
  files_changed: ["src/foo.ts"]
  commits: ["abc1234"]
  tests_added: ["test/foo.test.ts::does the thing"]
test_results:
  pass: 5
  fail: 0
  fail_details: []
open_questions: []
handoff_for_next_task: []
\`\`\`

Done.`;

describe("extractAuditFindings (GC-2026-039)", () => {
	it("T-AUDIT-01: returns no findings for a well-formed message", () => {
		const findings = extractAuditFindings(WELL_FORMED_YAML);
		expect(findings).toEqual([]);
	});

	it("T-AUDIT-02: missing_yaml_block (major) — no YAML block in message", () => {
		const message = "I finished the task. No structured report here.";
		const findings = extractAuditFindings(message);
		expect(findings.length).toBeGreaterThan(0);
		const missing = findings.find((f) => f.rule === "missing_yaml_block");
		expect(missing).toBeDefined();
		expect(missing!.severity).toBe("major");
	});

	it("T-AUDIT-03: completed_no_commits (major) — status=completed but commits empty", () => {
		const message = `\`\`\`yaml
status: completed
deliverables:
  files_changed: ["src/foo.ts"]
  commits: []
  tests_added: []
test_results:
  pass: 5
  fail: 0
open_questions: []
handoff_for_next_task: []
\`\`\``;
		const findings = extractAuditFindings(message);
		const violation = findings.find((f) => f.rule === "completed_no_commits");
		expect(violation).toBeDefined();
		expect(violation!.severity).toBe("major");
	});

	it("T-AUDIT-04: completed_with_commits does NOT fire completed_no_commits", () => {
		const message = `\`\`\`yaml
status: completed
deliverables:
  files_changed: ["src/foo.ts"]
  commits: ["abc1234"]
  tests_added: []
test_results:
  pass: 5
  fail: 0
open_questions: []
handoff_for_next_task: []
\`\`\``;
		const findings = extractAuditFindings(message);
		const violation = findings.find((f) => f.rule === "completed_no_commits");
		expect(violation).toBeUndefined();
	});

	it("T-AUDIT-05: checkpoint_stuck_pattern (major) — 2 consecutive checkpoints with same commit count", () => {
		const message = `Some progress.
[checkpoint 5/200 turns, 1m32s] 1 test written. 0 commits. blocker: none.
[checkpoint 10/200 turns, 3m15s] still exploring. 0 commits. blocker: none.
\`\`\`yaml
status: completed
deliverables:
  files_changed: ["src/foo.ts"]
  commits: ["abc1234"]
  tests_added: []
test_results:
  pass: 5
  fail: 0
open_questions: []
handoff_for_next_task: []
\`\`\``;
		const findings = extractAuditFindings(message);
		const violation = findings.find(
			(f) => f.rule === "checkpoint_stuck_pattern",
		);
		expect(violation).toBeDefined();
		expect(violation!.severity).toBe("major");
	});

	it("T-AUDIT-06: checkpoints_with_progress does NOT fire stuck pattern", () => {
		const message = `[checkpoint 5/200 turns, 1m32s] 1 test. 0 commits. blocker: none.
[checkpoint 10/200 turns, 3m15s] tests pass. 1 commits. blocker: none.
\`\`\`yaml
status: completed
deliverables:
  files_changed: ["src/foo.ts"]
  commits: ["abc1234"]
  tests_added: []
test_results:
  pass: 5
  fail: 0
open_questions: []
handoff_for_next_task: []
\`\`\``;
		const findings = extractAuditFindings(message);
		const violation = findings.find(
			(f) => f.rule === "checkpoint_stuck_pattern",
		);
		expect(violation).toBeUndefined();
	});

	it("T-AUDIT-07: ask_unanswered (major) — <ASK> blocks present but task report doesn't surface them", () => {
		const message = `I am stuck on a question.

<ASK>What is the deadline default for auditor agent type?</ASK>

\`\`\`yaml
status: completed
deliverables:
  files_changed: ["src/foo.ts"]
  commits: ["abc1234"]
  tests_added: []
test_results:
  pass: 5
  fail: 0
open_questions: []
handoff_for_next_task: []
\`\`\``;
		const taskReport = "Task T1 completed successfully. Tests pass."; // doesn't mention the ask
		const findings = extractAuditFindings(message, taskReport);
		const violation = findings.find((f) => f.rule === "ask_unanswered");
		expect(violation).toBeDefined();
		expect(violation!.severity).toBe("major");
	});

	it("T-AUDIT-08: ask_surfaced_in_report does NOT fire ask_unanswered", () => {
		const message = `I am stuck.

<ASK>What is the deadline default for auditor agent type?</ASK>

\`\`\`yaml
status: completed
deliverables:
  files_changed: ["src/foo.ts"]
  commits: ["abc1234"]
  tests_added: []
test_results:
  pass: 5
  fail: 0
open_questions:
  - question: "What is the deadline default for auditor agent type?"
    why_blocking: true
handoff_for_next_task: []
\`\`\``;
		// The task report surfaces the question word-for-word (substring match).
		const taskReport =
			"Open question: What is the deadline default for auditor agent type?";
		const findings = extractAuditFindings(message, taskReport);
		const violation = findings.find((f) => f.rule === "ask_unanswered");
		expect(violation).toBeUndefined();
	});

	it("T-AUDIT-09: blocked_without_reason (minor) — status=blocked but no open_questions", () => {
		const message = `\`\`\`yaml
status: blocked
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
		const findings = extractAuditFindings(message);
		const violation = findings.find((f) => f.rule === "blocked_without_reason");
		expect(violation).toBeDefined();
		expect(violation!.severity).toBe("minor");
	});

	it("T-AUDIT-10: blocked_with_reason does NOT fire blocked_without_reason", () => {
		const message = `\`\`\`yaml
status: blocked
deliverables:
  files_changed: []
  commits: []
  tests_added: []
test_results:
  pass: 0
  fail: 0
open_questions:
  - question: "What is the API contract?"
    why_blocking: true
handoff_for_next_task: []
\`\`\``;
		const findings = extractAuditFindings(message);
		const violation = findings.find((f) => f.rule === "blocked_without_reason");
		expect(violation).toBeUndefined();
	});

	it("T-AUDIT-11: findings are sorted by severity (critical > major > minor)", () => {
		// Build a message that triggers 3 findings of mixed severity.
		const message = `\`\`\`yaml
status: blocked
deliverables:
  files_changed: []
  commits: []
  tests_added: []
test_results:
  pass: 0
  fail: 0
open_questions: []
handoff_for_next_task: []
\`\`\`
[checkpoint 5/200 turns, 1m] nothing. 0 commits. blocker: none.
[checkpoint 10/200 turns, 2m] still nothing. 0 commits. blocker: none.`;
		const findings = extractAuditFindings(message);
		const severities = findings.map((f) => f.severity);
		// The list should be sorted: any major first, then minor.
		const majorIdx = severities.indexOf("major");
		const minorIdx = severities.indexOf("minor");
		if (majorIdx >= 0 && minorIdx >= 0) {
			expect(majorIdx).toBeLessThan(minorIdx);
		}
	});
});
