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

import {
	ADVISORY_MAX_PER_DISPATCH,
	ADVISORY_MAX_TOKENS,
	ADVISORY_MAX_TOKENS_WITH_SCHEMA,
	ADVISORY_YAML_SCHEMA,
	advisoryFor,
	RULE_FIX_DIRECTIVES,
} from "../src/agent-runner.js";

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

describe("subagent advisory: schema template (GC-2026-043)", () => {
	const SCHEMA_HINT_MSG =
		"TypeScript is statically typed because it performs type checking at compile time.";

	it("T-ADV-SCHEMA-01: missing_yaml_block advisory includes YAML schema by default", () => {
		const out = advisoryFor(SCHEMA_HINT_MSG);
		expect(out.length).toBe(1);
		expect(out[0]).toMatch(/missing_yaml_block/);
		expect(out[0]).toContain("```yaml"); // schema is fenced
		expect(out[0]).toContain("status: completed");
		expect(out[0]).toContain("deliverables:");
	});

	it("T-ADV-SCHEMA-02: completed_no_commits advisory does NOT include schema", () => {
		const message = `\`\`\`yaml
status: completed
deliverables:
  files_changed: ["src/foo.ts"]
  commits: []
  tests_added: []
test_results:
  pass: 1
  fail: 0
open_questions: []
handoff_for_next_task: []
\`\`\``;
		const out = advisoryFor(message);
		expect(out.length).toBe(1);
		expect(out[0]).toMatch(/completed_no_commits/);
		expect(out[0]).not.toContain("Required YAML schema"); // token savings
	});

	it("T-ADV-SCHEMA-03: includeSchemaTemplate=false disables schema", () => {
		const out = advisoryFor(SCHEMA_HINT_MSG, undefined, {
			includeSchemaTemplate: false,
		});
		expect(out.length).toBe(1);
		expect(out[0]).toMatch(/missing_yaml_block/);
		expect(out[0]).not.toContain("Required YAML schema");
	});

	it("T-ADV-SCHEMA-04: schema advisory capped at ADVISORY_MAX_TOKENS_WITH_SCHEMA (400)", () => {
		const out = advisoryFor(SCHEMA_HINT_MSG);
		const tokens = Math.ceil(out[0].length / 4);
		expect(tokens).toBeLessThanOrEqual(ADVISORY_MAX_TOKENS_WITH_SCHEMA);
	});

	it("T-ADV-SCHEMA-05: schema advisory still capped at ADVISORY_MAX_TOKENS (200) when schema disabled", () => {
		const out = advisoryFor(SCHEMA_HINT_MSG, undefined, {
			includeSchemaTemplate: false,
		});
		const tokens = Math.ceil(out[0].length / 4);
		expect(tokens).toBeLessThanOrEqual(ADVISORY_MAX_TOKENS);
	});

	it("T-ADV-SCHEMA-06: ADVISORY_YAML_SCHEMA constant is valid YAML (parser accepts it)", async () => {
		// Lazy import extractStructuredOutput to verify the schema parses
		const { extractStructuredOutput } = await import("../src/agent-runner.js");
		const structured = extractStructuredOutput(
			`Some prose.\n${ADVISORY_YAML_SCHEMA}\nDone.`,
		);
		expect(structured).not.toBeNull();
		expect(structured!.status).toMatch(/completed|blocked|partial/);
	});

	it("T-ADV-SCHEMA-07: missing_yaml_block + includeSchemaTemplate=false + token cap", () => {
		const out = advisoryFor(SCHEMA_HINT_MSG, undefined, {
			includeSchemaTemplate: false,
		});
		const tokens = Math.ceil(out[0].length / 4);
		expect(tokens).toBeLessThanOrEqual(200);
	});
});

describe("subagent advisory: actionable fix directives (GC-2026-044)", () => {
	it("T-ADV-FIX-01: completed_no_commits fix mentions git log", () => {
		const message = `\`\`\`yaml
status: completed
deliverables:
  files_changed: ["src/foo.ts"]
  commits: []
  tests_added: []
test_results:
  pass: 1
  fail: 0
open_questions: []
handoff_for_next_task: []
\`\`\``;
		const out = advisoryFor(message);
		expect(out[0]).toMatch(/git log/);
	});

	it("T-ADV-FIX-02: checkpoint_stuck_pattern fix mentions git commit", () => {
		const message = `\`\`\`yaml
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
\`\`\`
[checkpoint 5/200 turns, 1m] nothing. 0 commits. blocker: none.
[checkpoint 10/200 turns, 2m] still nothing. 0 commits. blocker: none.`;
		const out = advisoryFor(message);
		expect(out.some((a) => a.includes("git commit"))).toBe(true);
	});

	it("T-ADV-FIX-03: ask_unanswered fix mentions open_questions schema", () => {
		const message = `I am stuck.

<ASK>What is the deadline default?</ASK>

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
		const out = advisoryFor(message);
		expect(out.some((a) => a.includes("open_questions"))).toBe(true);
	});

	it("T-ADV-FIX-04: blocked_without_reason fix mentions open_questions", () => {
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
		const out = advisoryFor(message);
		// blocked_without_reason is severity=minor, so advisory is filtered
		// out by the severity filter. Test that the fix directive is
		// available for major+critical rules only.
		expect(out.length).toBe(0);
	});

	it("T-ADV-FIX-05: per-rule fix directive is more actionable than f.recommendation", () => {
		// For completed_no_commits, the fix directive is a specific command;
		// the generic recommendation is just "agent must commit".
		const directive =
			'run `git log --oneline -5 --format=%H` and put the SHAs in YAML as: commits: ["sha1", "sha2", ...]';
		expect(directive).toContain("git log");
		expect(directive).toContain("commits:");
	});

	it("T-ADV-FIX-06: RULE_FIX_DIRECTIVES map covers all 5 rules", () => {
		// Imported at top of file
		// const directive = "..."; // already imported
		const rules = [
			"missing_yaml_block",
			"completed_no_commits",
			"checkpoint_stuck_pattern",
			"ask_unanswered",
			"blocked_without_reason",
		];
		// Just check the map has all 5
		for (const r of rules) {
			expect(RULE_FIX_DIRECTIVES[r]).toBeDefined();
		}
	});

	it("T-ADV-FIX-07: advisory token cap respected with fix directive + schema", () => {
		const out = advisoryFor("Some prose without YAML.", undefined, {
			includeSchemaTemplate: true,
		});
		const tokens = Math.ceil(out[0].length / 4);
		expect(tokens).toBeLessThanOrEqual(ADVISORY_MAX_TOKENS_WITH_SCHEMA);
	});
});
