/**
 * subagent-commit-discipline.test.ts — GC-2026-038 T1
 *
 * Verifies that the developer prompt contains the commit-discipline
 * section. The agent is the enforcer (no runtime check at this layer);
 * the test pins the prompt content so a regression would be caught.
 *
 * Checks:
 *   - the section is present in developer.ts
 *   - the rule "every RED test ends with wip: <test> red" is mentioned
 *   - the rule "every GREEN test ends with feat: <test> green" is mentioned
 *   - the rule "5 turns without a commit -> declare BLOCKED" is mentioned
 *   - the prompt mentions serialization: "Do NOT write multiple tests before committing"
 *   - the prompt mentions the escape hatch: "commit what you have immediately and declare BLOCKED"
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const DEVELOPER_PROMPT = readFileSync(
	join(import.meta.dirname, "../src/agent-prompts/developer.ts"),
	"utf8",
);

describe("subagent commit-discipline (GC-2026-038 T1)", () => {
	it("T-CD-01: developer.ts contains the commit discipline section header", () => {
		expect(DEVELOPER_PROMPT).toContain(
			"Commit Discipline (commit-as-checkpoint)",
		);
	});

	it("T-CD-02: every RED test ends with wip: <test> red", () => {
		expect(DEVELOPER_PROMPT).toMatch(/wip:\s*<test name> red|wip: <test> red/);
	});

	it("T-CD-03: every GREEN test ends with feat: <test> green", () => {
		expect(DEVELOPER_PROMPT).toMatch(
			/feat:\s*<test name> green|feat: <test> green/,
		);
	});

	it("T-CD-04: 5 turns without a commit -> declare BLOCKED (escape hatch)", () => {
		// The exact phrasing in the prompt: "If 5 turns have passed without a
		// commit, stop exploring. Commit what you have (even if RED) and emit
		// `BLOCKED` in your final message." The text wraps across lines so we
		// match with [\s\S] rather than /s. Use \b to anchor on the word "turns".
		expect(DEVELOPER_PROMPT).toMatch(/5\s+turns[\s\S]+?without a commit/);
		// The escape hatch sentence wraps across lines:
		//   "commit what you have immediately and declare\nBLOCKED"
		// and the anti-pattern says:
		//   "emit \`BLOCKED\` in your final message."
		expect(DEVELOPER_PROMPT).toMatch(/declare[\s\S]+?BLOCKED/);
		expect(DEVELOPER_PROMPT).toMatch(/emit[\s\S]+?BLOCKED/);
	});

	it("T-CD-05: do NOT write multiple tests before committing the first one", () => {
		expect(DEVELOPER_PROMPT).toMatch(
			/Do NOT write multiple tests before committing|write multiple tests.*before committing/i,
		);
	});

	it("T-CD-06: commit what you have immediately when stuck", () => {
		expect(DEVELOPER_PROMPT).toMatch(
			/commit what you have immediately|commit what you have.*declare BLOCKED/i,
		);
	});
});
