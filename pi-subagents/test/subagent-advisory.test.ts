/**
 * subagent-advisory.test.ts — GC-2026-042
 *
 * Tests the advisoryFor helper. The helper produces 0-2 advisory strings
 * from the agent's last message, with severity + dedup + token-cap filters.
 *
 * Token cap is approximate (text.length / 4). The test verifies that
 * each advisory element is ≤ 200 tokens (≈ 800 chars).
 */

import { describe, expect, it } from "vitest";

import { advisoryFor, ADVISORY_MAX_TOKENS, ADVISORY_MAX_PER_DISPATCH } from "../src/agent-runner.js";

function approxTokens(text: string): number {
	return Math.ceil(text.length / 4);
}

describe("subagent advisory (GC-2026-042)", () => {
	it("T-ADV-01: empty findings (well-formed message) -> no advisories", () => {
		const msg = `\`\`\`yaml
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
		const out = advisoryFor(msg);
		expect(out).toEqual([]);
	});

	it("T-ADV-02: completed_no_commits (major) -> 1 advisory", () => {
		const msg = `\`\`\`yaml
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
		const out = advisoryFor(msg);
		expect(out.length).toBe(1);
		expect(out[0]).toMatch(/\[orchestrator audit advisory/);
		expect(out[0]).toMatch(/completed_no_commits/);
	});

	it("T-ADV-SEV: minor findings only -> no advisory (severity filter)", () => {
		// status=blocked + no commits + no open_questions => blocked_without_reason (minor)
		const msg = `\`\`\`yaml
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
		const out = advisoryFor(msg);
		// blocked_without_reason is minor — should NOT produce an advisory
		expect(out).toEqual([]);
	});

	it("T-ADV-DEDUP: same rule in context.alreadyAdvisedRules is suppressed", () => {
		const msg = `\`\`\`yaml
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
		const out = advisoryFor(msg, ctx);
		// Already advised this rule + already sent 1 advisory (at cap)
		expect(out).toEqual([]);
	});

	it("T-ADV-CAP: at most ADVISORY_MAX_PER_DISPATCH advisories per call", () => {
		// Construct a message that would trigger 3+ major findings
		const msg = `\`\`\`yaml
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
\`\`\`
[checkpoint 5/200 turns, 1m] nothing. 0 commits. blocker: none.
[checkpoint 10/200 turns, 2m] still nothing. 0 commits. blocker: none.`;
		const out = advisoryFor(msg);
		// 2 advisories: completed_no_commits + checkpoint_stuck_pattern
		expect(out.length).toBeLessThanOrEqual(ADVISORY_MAX_PER_DISPATCH);
		expect(out.length).toBeGreaterThan(0);
	});

	it("T-ADV-TOK: each advisory is ≤ ADVISORY_MAX_TOKENS tokens", () => {
		// Even with a long issue/recommendation, the advisory is truncated.
		const longMsg = `\`\`\`yaml
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
		const out = advisoryFor(longMsg);
		for (const a of out) {
			expect(approxTokens(a)).toBeLessThanOrEqual(ADVISORY_MAX_TOKENS);
		}
	});

	it("T-ADV-04: format includes N/M counter", () => {
		const msg = `\`\`\`yaml
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
		const out = advisoryFor(msg);
		expect(out[0]).toMatch(/^\[orchestrator audit advisory — 1\/\d+\]/);
	});

	it("T-ADV-05: not advised in final message (advisory is pre-audit)", () => {
		// The advisory helper returns advisories; the runAgent hook
		// decides NOT to inject on the last assistant message. The hook
		// logic is in agent-runner (next T2). For now, the helper
		// always returns advisories; the hook is what filters.
		// This test pins the contract: the helper is content-agnostic.
		const finalMessage = `Some prose.

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
		const out = advisoryFor(finalMessage);
		// Well-formed message -> no advisories
		expect(out).toEqual([]);
	});
});
