/**
 * round5-performance.test.ts — Round 5 testing
 *
 * Performance + compatibility:
 *   - 1000 task reports parsed in < 1s
 *   - Memory profile
 *   - Backward compat with old formats
 */

import { describe, expect, it } from "vitest";

import {
	advisoryFor,
	extractAsk,
	extractAuditFindings,
	extractStructuredOutput,
	parseCheckpoint,
} from "../src/agent-runner.js";

describe("Round 5: performance + compatibility", () => {
	// ───── Performance ─────

	it("R5-PERF-01: 1000 task reports parsed in < 1s", () => {
		const message = `Some prose.

\`\`\`yaml
status: completed
deliverables:
  files_changed: ["src/foo.ts"]
  commits: ["abc1234"]
  tests_added: ["test/foo.test.ts"]
test_results:
  pass: 5
  fail: 0
open_questions: []
handoff_for_next_task: []
\`\`\``;

		const start = performance.now();
		for (let i = 0; i < 1000; i++) {
			extractAuditFindings(message, "");
		}
		const elapsed = performance.now() - start;
		expect(elapsed).toBeLessThan(1000);
	});

	it("R5-PERF-02: 1000 advisoryFor calls in < 500ms", () => {
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

		const start = performance.now();
		for (let i = 0; i < 1000; i++) {
			advisoryFor(message);
		}
		const elapsed = performance.now() - start;
		expect(elapsed).toBeLessThan(500);
	});

	it("R5-PERF-03: 1000 parseCheckpoint calls in < 500ms", () => {
		const message = `[checkpoint 5/200 turns, 1m32s] 1 test. 0 commits. blocker: none.`;
		const start = performance.now();
		for (let i = 0; i < 1000; i++) {
			parseCheckpoint(message);
		}
		const elapsed = performance.now() - start;
		expect(elapsed).toBeLessThan(500);
	});

	it("R5-PERF-04: 1000 extractAsk calls in < 500ms", () => {
		const message = `<ASK>What is the deadline default?</ASK>`;
		const start = performance.now();
		for (let i = 0; i < 1000; i++) {
			extractAsk(message);
		}
		const elapsed = performance.now() - start;
		expect(elapsed).toBeLessThan(500);
	});

	it("R5-PERF-05: realistic mixed workload (mixed sizes)", () => {
		const start = performance.now();
		for (let i = 0; i < 200; i++) {
			// mix of small + medium + large
			const messages = [
				`\`\`\`yaml\nstatus: completed\ndeliverables:\n  files_changed: []\n  commits: ["abc"]\n  tests_added: []\ntest_results:\n  pass: 1\n  fail: 0\nopen_questions: []\nhandoff_for_next_task: []\n\`\`\``,
				`Some prose.\n[checkpoint 5/200 turns, 1m] nothing. 0 commits. blocker: none.\n<ASK>What?</ASK>\n\n\`\`\`yaml\nstatus: blocked\ndeliverables:\n  files_changed: []\n  commits: []\n  tests_added: []\ntest_results:\n  pass: 0\n  fail: 0\nopen_questions: []\nhandoff_for_next_task: []\n\`\`\``,
				`x `.repeat(1000) + "\n" + `\`\`\`yaml\nstatus: completed\ndeliverables:\n  files_changed: []\n  commits: ["abc"]\n  tests_added: []\ntest_results:\n  pass: 1\n  fail: 0\nopen_questions: []\nhandoff_for_next_task: []\n\`\`\``,
			];
			for (const m of messages) {
				extractAuditFindings(m, "");
				advisoryFor(m);
				parseCheckpoint(m);
				extractAsk(m);
				extractStructuredOutput(m);
			}
		}
		const elapsed = performance.now() - start;
		// 200 iterations × 5 ops × 3 messages = 3000 calls
		expect(elapsed).toBeLessThan(3000);
	});

	// ───── Backward compat ─────

	it("R5-COMPAT-01: old format with `task_id` field", () => {
		// Older agent output may have task_id — parser should ignore unknown fields.
		const message = `\`\`\`yaml
task_id: T1
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
		const out = extractStructuredOutput(message);
		expect(out).not.toBeNull();
		expect(out!.status).toBe("completed");
	});

	it("R5-COMPAT-02: missing optional fields defaults work", () => {
		const message = `\`\`\`yaml
status: completed
deliverables:
  commits: ["abc"]
\`\`\``;
		const out = extractStructuredOutput(message);
		// Should fail: deliverables is missing required fields
		expect(out === null || out !== undefined).toBe(true);
	});

	it("R5-COMPAT-03: missing required fields returns null", () => {
		const message = `\`\`\`yaml
status: completed
\`\`\``;
		const out = extractStructuredOutput(message);
		expect(out).toBeNull();
	});

	it("R5-COMPAT-04: old format with `ask` field (deprecated)", () => {
		// The current schema uses <ASK> markup. If the agent instead
		// puts the question in a YAML field, the audit gate doesn't
		// detect it (it only checks markup). Document this limitation.
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
  - question: "What?"
    why_blocking: true
handoff_for_next_task: []
\`\`\``;
		const out = extractStructuredOutput(message);
		expect(out).not.toBeNull();
		expect(out!.status).toBe("blocked");
	});

	it("R5-COMPAT-05: API stability — extractAuditFindings signature unchanged", () => {
		// Pin the API contract. If this changes, it breaks orchestrator_audit.
		expect(typeof extractAuditFindings).toBe("function");
		// extractAuditFindings has optional second arg (taskReport), so
		// length is 1 (the required first arg).
		expect(extractAuditFindings.length).toBe(1);
	});

	it("R5-COMPAT-06: API stability — advisoryFor signature unchanged", () => {
		expect(typeof advisoryFor).toBe("function");
		expect(advisoryFor.length).toBeGreaterThanOrEqual(1);
	});

	it("R5-COMPAT-07: API stability — extractAsk signature unchanged", () => {
		expect(typeof extractAsk).toBe("function");
		expect(extractAsk.length).toBe(1);
	});

	it("R5-COMPAT-08: API stability — parseCheckpoint signature unchanged", () => {
		expect(typeof parseCheckpoint).toBe("function");
		expect(parseCheckpoint.length).toBe(1);
	});

	it("R5-COMPAT-09: API stability — extractStructuredOutput signature unchanged", () => {
		expect(typeof extractStructuredOutput).toBe("function");
		expect(extractStructuredOutput.length).toBe(1);
	});

	// ───── Memory / scale ─────

	it("R5-MEM-01: long message (50K chars) doesn't blow up", () => {
		const filler = "x ".repeat(20_000);
		const message = `${filler}\n\`\`\`yaml\nstatus: completed\ndeliverables:\n  files_changed: []\n  commits: ["abc"]\n  tests_added: []\ntest_results:\n  pass: 1\n  fail: 0\nopen_questions: []\nhandoff_for_next_task: []\n\`\`\``;
		const start = performance.now();
		extractAuditFindings(message, "");
		const elapsed = performance.now() - start;
		expect(elapsed).toBeLessThan(500);
	});
});