/**
 * subagent-structured-output.test.ts — GC-2026-037 T2
 *
 * Structured YAML output schema. Every developer/auditor/Explore/Plan
 * final message MUST contain a YAML block with status, deliverables,
 * test_results, open_questions, handoff_for_next_task.
 *
 * This file pins the SCHEMA and the extractStructuredOutput() helper. The
 * helper lives in agent-runner.ts (or a new file) and is the source of
 * truth for parsing agent final messages into a structured shape the
 * orchestrator can read mechanically.
 *
 * T2 must satisfy SC3 (YAML schema in agent-prompts) + SC4 (parsing
 * helper exists + test passes).
 */

import { describe, expect, it } from "vitest";
import { extractStructuredOutput } from "../src/agent-runner.js";

describe("subagent structured output: extractStructuredOutput (GC-2026-037 T2)", () => {
	it("T-SOUTPUT-01a: returns the parsed shape when a complete YAML block is present", () => {
		const text = `I implemented the feature and added tests.

\`\`\`yaml
status: completed
deliverables:
  files_changed: ["src/foo.ts", "test/foo.test.ts"]
  commits: ["abc1234"]
  tests_added: ["test/foo.test.ts::does the thing"]
test_results:
  pass: 5
  fail: 0
  fail_details: []
open_questions: []
handoff_for_next_task:
  - read_first: "src/foo.ts"
    context: "new public API"
\`\`\`

Done.`;

		const out = extractStructuredOutput(text);
		expect(out).not.toBeNull();
		expect(out!.status).toBe("completed");
		expect(out!.deliverables.filesChanged).toEqual([
			"src/foo.ts",
			"test/foo.test.ts",
		]);
		expect(out!.deliverables.commits).toEqual(["abc1234"]);
		expect(out!.deliverables.testsAdded).toEqual([
			"test/foo.test.ts::does the thing",
		]);
		expect(out!.testResults.pass).toBe(5);
		expect(out!.testResults.fail).toBe(0);
		expect(out!.openQuestions).toEqual([]);
		expect(out!.handoffForNextTask).toEqual([
			{ readFirst: "src/foo.ts", context: "new public API" },
		]);
	});

	it("T-SOUTPUT-01b: returns status=blocked when the YAML status field is 'blocked'", () => {
		const text = `\`\`\`yaml
status: blocked
deliverables:
  files_changed: []
  commits: []
  tests_added: []
test_results:
  pass: 0
  fail: 0
  fail_details: []
open_questions:
  - question: "what API?"
    why_blocking: true
    suggestion: "ask the orchestrator"
handoff_for_next_task: []
\`\`\``;
		const out = extractStructuredOutput(text);
		expect(out).not.toBeNull();
		expect(out!.status).toBe("blocked");
		expect(out!.openQuestions[0]?.question).toBe("what API?");
	});

	it("T-SOUTPUT-01c: returns status=partial for the partial state", () => {
		const text = `\`\`\`yaml
status: partial
deliverables:
  files_changed: ["src/foo.ts"]
  commits: []
  tests_added: []
test_results:
  pass: 1
  fail: 1
  fail_details:
    - file: "test/foo.test.ts"
      test: "edge case"
      message: "expected 0 got 1"
open_questions: []
handoff_for_next_task: []
\`\`\``;
		const out = extractStructuredOutput(text);
		expect(out).not.toBeNull();
		expect(out!.status).toBe("partial");
		expect(out!.testResults.failDetails).toEqual([
			{
				file: "test/foo.test.ts",
				test: "edge case",
				message: "expected 0 got 1",
			},
		]);
	});

	it("T-SOUTPUT-02a: returns null when the message has no YAML block", () => {
		const text = "I just did some work. No structured report here, sorry.";
		const out = extractStructuredOutput(text);
		expect(out).toBeNull();
	});

	it("T-SOUTPUT-02b: returns null when the YAML block is missing required fields", () => {
		const text = `\`\`\`yaml
status: completed
\`\`\``;
		const out = extractStructuredOutput(text);
		// Either null (validation fails) or throws — but for the orchestrator to gate on
		// this, we need a clean null. The helper should validate required fields.
		expect(out).toBeNull();
	});

	it("T-SOUTPUT-03a: tolerates optional fields being missing (commits, tests_added, handoff_for_next_task can be empty)", () => {
		const text = `\`\`\`yaml
status: completed
deliverables:
  files_changed: ["src/x.ts"]
test_results:
  pass: 0
  fail: 0
open_questions: []
\`\`\``;
		const out = extractStructuredOutput(text);
		expect(out).not.toBeNull();
		expect(out!.deliverables.commits).toEqual([]);
		expect(out!.deliverables.testsAdded).toEqual([]);
		expect(out!.handoffForNextTask).toEqual([]);
	});

	it("T-SOUTPUT-04: extracts from ```yaml fence, indented code fence, or --- fence", () => {
		const variants = [
			"```yaml\nstatus: completed\ndeliverables:\n  files_changed: []\n  commits: []\n  tests_added: []\ntest_results:\n  pass: 0\n  fail: 0\nopen_questions: []\nhandoff_for_next_task: []\n```",
			"   ```yaml\n   status: completed\n   deliverables:\n     files_changed: []\n     commits: []\n     tests_added: []\n   test_results:\n     pass: 0\n     fail: 0\n   open_questions: []\n   handoff_for_next_task: []\n   ```",
			"---\nstatus: completed\ndeliverables:\n  files_changed: []\n  commits: []\n  tests_added: []\ntest_results:\n  pass: 0\n  fail: 0\nopen_questions: []\nhandoff_for_next_task: []\n---",
		];
		for (const text of variants) {
			const out = extractStructuredOutput(text);
			expect(out).not.toBeNull();
			expect(out!.status).toBe("completed");
		}
	});
});
