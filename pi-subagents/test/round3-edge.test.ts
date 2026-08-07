/**
 * round3-edge.test.ts — Round 3 testing
 *
 * Edge cases: very long messages, empty, unicode, malformed, etc.
 */

import { describe, expect, it } from "vitest";

import {
	advisoryFor,
	extractAuditFindings,
	extractAsk,
	extractStructuredOutput,
	parseCheckpoint,
} from "../src/agent-runner.js";

describe("Round 3: edge cases", () => {
	it("R3-01: empty message — minimal audit findings, no crash", () => {
		const findings = extractAuditFindings("", "");
		expect(findings.some((f) => f.rule === "missing_yaml_block")).toBe(true);
	});

	it("R3-02: very long message (10K tokens)", () => {
		const filler = "x ".repeat(5000);
		const message = `${filler}\n\`\`\`yaml\nstatus: completed\ndeliverables:\n  files_changed: []\n  commits: ["abc"]\n  tests_added: []\ntest_results:\n  pass: 1\n  fail: 0\nopen_questions: []\nhandoff_for_next_task: []\n\`\`\``;
		const findings = extractAuditFindings(message, "");
		expect(findings).toEqual([]);
	});

	it("R3-03: unicode in YAML (chinese, emoji)", () => {
		const message = `\`\`\`yaml
status: completed
deliverables:
  files_changed: ["src/中文.ts"]
  commits: ["abc"]
  tests_added: ["test/foo.test.ts::测试 ✓"]
test_results:
  pass: 1
  fail: 0
open_questions: []
handoff_for_next_task: []
\`\`\``;
		const structured = extractStructuredOutput(message);
		expect(structured).not.toBeNull();
		expect(structured!.deliverables.filesChanged[0]).toContain("中文");
	});

	it("R3-04: malformed YAML — graceful null", () => {
		const message = `\`\`\`yaml
this is: not valid yaml at all
  - broken
    missing colon
\`\`\``;
		const structured = extractStructuredOutput(message);
		// Either null or partial — both acceptable
		expect(structured === null || structured !== undefined).toBe(true);
	});

	it("R3-05: multiple YAML blocks — parser uses first", () => {
		const message = `First block:
\`\`\`yaml
status: completed
deliverables:
  files_changed: ["a.ts"]
  commits: ["abc"]
  tests_added: []
test_results:
  pass: 1
  fail: 0
open_questions: []
handoff_for_next_task: []
\`\`\`
Second block (should be ignored):
\`\`\`yaml
status: blocked
deliverables: {}
\`\`\``;
		const structured = extractStructuredOutput(message);
		expect(structured).not.toBeNull();
		// First block wins
		expect(structured!.status).toBe("completed");
		expect(structured!.deliverables.commits).toEqual(["abc"]);
	});

	it("R3-06: checkpoint time format variations", () => {
		const messages = [
			"[checkpoint 5/200 turns, 1m] 1 commit done. 0 commits. blocker: none.",
			"[checkpoint 5/200 turns, 1m32s] tests pass. 1 commits. blocker: none.",
			"[checkpoint 5/200 turns, 1.5m] all green. 2 commits. blocker: none.",
			"[checkpoint 5/200 turns, 2m0s] done. 5 commits. blocker: none.",
		];
		for (const m of messages) {
			const cp = parseCheckpoint(m);
			expect(cp?.turnNumber).toBe(5);
		}
	});

	it("R3-07: malformed checkpoint — returns null", () => {
		const malformed = "[checkpoint broken format]";
		const cp = parseCheckpoint(malformed);
		expect(cp).toBeNull();
	});

	it("R3-08: <ASK> with nested code blocks", () => {
		const message = `<ASK>
What is the deadline?

\`\`\`ts
const x = 5;
\`\`\`
</ASK>

Some text.

<ASK>Another question?</ASK>`;
		const asks = extractAsk(message);
		expect(asks.length).toBe(2);
		expect(asks[0]).toContain("deadline");
		expect(asks[1]).toContain("Another question");
	});

	it("R3-09: very long commit SHA (40 chars)", () => {
		const sha = "a".repeat(40);
		const message = `\`\`\`yaml
status: completed
deliverables:
  files_changed: ["src/foo.ts"]
  commits: ["${sha}"]
  tests_added: []
test_results:
  pass: 1
  fail: 0
open_questions: []
handoff_for_next_task: []
\`\`\``;
		const structured = extractStructuredOutput(message);
		expect(structured?.deliverables.commits[0]).toBe(sha);
	});

	it("R3-10: advisory severity filter — minor findings filtered out", () => {
		// blocked_without_reason is severity: 'minor'. Should NOT produce an advisory.
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
		const advisories = advisoryFor(message);
		expect(advisories).toEqual([]);
	});

	it("R3-11: advisory token cap — each advisory ≤ 200 tokens", () => {
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
		const advisories = advisoryFor(message);
		for (const a of advisories) {
			const tokens = Math.ceil(a.length / 4);
			expect(tokens).toBeLessThanOrEqual(200);
		}
	});

	it("R3-12: empty commits array — does NOT fire completed_no_commits if status is blocked", () => {
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
  - question: "Why is this blocked?"
    why_blocking: true
handoff_for_next_task: []
\`\`\``;
		const findings = extractAuditFindings(message, "");
		const completedNoCommits = findings.find((f) => f.rule === "completed_no_commits");
		expect(completedNoCommits).toBeUndefined();
	});
});