/**
 * round4-adversarial.test.ts — Round 4 testing
 *
 * Try to game the system:
 *   - Status spoofing (claim completed without actually being done)
 *   - Fake YAML blocks (YAML-shaped but semantically empty)
 *   - Commit count padding (commits array with empty strings)
 *   - Advisory bypass attempts
 *   - Dedup bypass via multiple messages
 */

import { describe, expect, it } from "vitest";

import {
	advisoryFor,
	extractAuditFindings,
	extractStructuredOutput,
} from "../src/agent-runner.js";

describe("Round 4: adversarial scenarios", () => {
	it("R4-01: status spoofing — claims completed but commits empty", () => {
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
		const findings = extractAuditFindings(message, "");
		expect(findings.some((f) => f.rule === "completed_no_commits")).toBe(true);
	});

	it("R4-02: status spoofing — claims blocked but actually has commits", () => {
		const message = `\`\`\`yaml
status: blocked
deliverables:
  files_changed: []
  commits: ["abc1234"]
  tests_added: []
test_results:
  pass: 0
  fail: 0
open_questions:
  - question: "Why blocked?"
    why_blocking: true
handoff_for_next_task: []
\`\`\``;
		const findings = extractAuditFindings(message, "");
		// completed_no_commits should NOT fire (status is blocked)
		expect(findings.some((f) => f.rule === "completed_no_commits")).toBe(false);
	});

	it("R4-03: fake commit SHAs (empty strings) — known limitation", () => {
		// The parser treats empty strings as valid (still a non-empty array).
		// This is by design — the audit gate can't reliably distinguish
		// between genuine empty SHA and padding. The test documents the
		// current behavior.
		const message = `\`\`\`yaml
status: completed
deliverables:
  files_changed: ["src/foo.ts"]
  commits: ["", "", ""]
  tests_added: []
test_results:
  pass: 5
  fail: 0
open_questions: []
handoff_for_next_task: []
\`\`\``;
		const findings = extractAuditFindings(message, "");
		// Document: commits array with empty strings is NOT detected as
		// completed_no_commits. The gate can't tell if it's malicious.
		const completedNoCommits = findings.find(
			(f) => f.rule === "completed_no_commits",
		);
		expect(completedNoCommits).toBeUndefined();
	});

	it("R4-04: huge empty string commit padding — known limitation", () => {
		// commits: ["   "] — whitespace only
		const message = `\`\`\`yaml
status: completed
deliverables:
  files_changed: ["src/foo.ts"]
  commits: ["   "]
  tests_added: []
test_results:
  pass: 5
  fail: 0
open_questions: []
handoff_for_next_task: []
\`\`\``;
		const structured = extractStructuredOutput(message);
		expect(structured).not.toBeNull();
		// Document: same as R4-03, the gate can't tell.
		const findings = extractAuditFindings(message, "");
		expect(findings.some((f) => f.rule === "completed_no_commits")).toBe(false);
	});

	it("R4-05: status=partial with no commits — should NOT fire completed_no_commits", () => {
		const message = `\`\`\`yaml
status: partial
deliverables:
  files_changed: ["src/foo.ts"]
  commits: []
  tests_added: []
test_results:
  pass: 2
  fail: 3
open_questions: []
handoff_for_next_task: []
\`\`\``;
		const findings = extractAuditFindings(message, "");
		// partial is OK without commits
		expect(findings.some((f) => f.rule === "completed_no_commits")).toBe(false);
	});

	it("R4-06: asking without surfacing — <ASK> not in task report", () => {
		const message = `I am confused.

<ASK>What is the deadline default for auditor agent type?</ASK>

\`\`\`yaml
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
		// The orchestrator should have surfaced the question in the task report. If not,
		// the inline check fires ask_unanswered. The audit auto-injects.
		const findings = extractAuditFindings(message, "");
		expect(findings.some((f) => f.rule === "ask_unanswered")).toBe(true);
	});

	it("R4-07: asking surfaced — no ask_unanswered finding", () => {
		const message = `I am confused.

<ASK>What is the deadline default for auditor agent type?</ASK>

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
  - question: "What is the deadline default for auditor agent type?"
    why_blocking: true
handoff_for_next_task: []
\`\`\``;
		// When the orchestrator includes the question in the task report's
		// open_questions AND the agent message's open_questions, the
		// audit gate sees it as surfaced. We pass the task report as
		// the second arg (which is what orchestrator_audit does).
		// The audit uses .slice(0, 30) of the ask text + lowercase
		// substring match. The taskReport must contain the first 30
		// chars of the question (lowercased).
		const taskReport = `Open question: what is the deadline default for auditor agent type?`;
		const findings = extractAuditFindings(message, taskReport);
		expect(findings.some((f) => f.rule === "ask_unanswered")).toBe(false);
	});

	it("R4-08: dedup — same rule in alreadyAdvisedRules is suppressed", () => {
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
		const ctx = {
			alreadyAdvisedRules: new Set(["completed_no_commits"]),
			advisoriesSent: 1,
		};
		const advisories = advisoryFor(message, ctx);
		expect(advisories).toEqual([]);
	});

	it("R4-09: many findings — advisory cap respected (max 2)", () => {
		// Construct a message with 5+ findings
		const message = `\`\`\`yaml
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
\`\`\`
[checkpoint 5/200 turns, 1m] nothing. 0 commits. blocker: none.
[checkpoint 10/200 turns, 2m] nothing. 0 commits. blocker: none.`;
		const advisories = advisoryFor(message);
		expect(advisories.length).toBeLessThanOrEqual(2);
	});

	it("R4-10: empty commits + checkpoint stuck — both fire", () => {
		const message = `\`\`\`yaml
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
\`\`\`
[checkpoint 5/200 turns, 1m] nothing. 0 commits. blocker: none.
[checkpoint 10/200 turns, 2m] still nothing. 0 commits. blocker: none.`;
		const findings = extractAuditFindings(message, "");
		const rules = findings.map((f) => f.rule);
		expect(rules).toContain("completed_no_commits");
		expect(rules).toContain("checkpoint_stuck_pattern");
	});

	it("R4-11: 100 random YAML blocks — robustness", () => {
		for (let i = 0; i < 100; i++) {
			const status =
				i % 3 === 0 ? "completed" : i % 3 === 1 ? "blocked" : "partial";
			const commits = i % 5 === 0 ? ["abc"] : [];
			const message = `\`\`\`yaml
status: ${status}
deliverables:
  files_changed: []
  commits: ${JSON.stringify(commits)}
  tests_added: []
test_results:
  pass: 0
  fail: 0
open_questions: []
handoff_for_next_task: []
\`\`\``;
			const out = extractStructuredOutput(message);
			expect(out).not.toBeNull();
			expect(out!.status).toBe(status);
		}
	});

	it("R4-12: adversarial advisory — agent pretends to comply without fixing", () => {
		// Agent reads the advisory and produces a message that LOOKS compliant
		// but is actually the same (no real fix).
		const originalMessage = `\`\`\`yaml
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
		const advisory = advisoryFor(originalMessage);
		expect(advisory.length).toBeGreaterThan(0);

		// Simulate agent's "fix" — same broken message + acknowledgment
		const fakeFix = `[orchestrator audit advisory — 1/1] completed_no_commits: ... Fix: ...
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
\`\`\`

I acknowledged the advisory but did not commit.`;
		// The audit gate still catches the same violation
		const findings = extractAuditFindings(fakeFix, "");
		expect(findings.some((f) => f.rule === "completed_no_commits")).toBe(true);
	});
});
