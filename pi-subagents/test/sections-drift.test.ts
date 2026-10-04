/**
 * sections-drift.test.ts — Byte-identity pinning for shared prompt sections.
 *
 * After GC-2026-prompt-parser-contract-cleanup, every section that two
 * subagent prompts share (Developer + Reviewer) lives in a single
 * `_sections/*.ts` constant. The runtime prompts interpolate the constant
 * directly; this test asserts the byte slice is identical across the two
 * prompts, so a future edit that drifts the prose (between the two prompts
 * or between prompt and section) is caught here.
 *
 * Mirrors the GC-2026-076 P1 `workspace-protocol-drift.test.ts` pattern.
 */

import { describe, expect, it } from "vitest";
import { DEVELOPER_PROMPT } from "../src/agent-prompts/developer.js";
import { REVIEWER_PROMPT } from "../src/agent-prompts/reviewer.js";
import {
	COMMIT_DISCIPLINE_SECTION,
} from "../src/agent-prompts/_sections/commit-discipline.js";
import {
	BASH_TIMEOUT_SECTION,
} from "../src/agent-prompts/_sections/bash-timeout.js";
import {
	EXPLORATION_BUDGET_SECTION,
} from "../src/agent-prompts/_sections/exploration-budget.js";
import {
	UNCERTAINTY_THRESHOLD_SECTION,
} from "../src/agent-prompts/_sections/uncertainty-threshold.js";
import {
	PREVIOUS_FAILURE_SECTION,
} from "../src/agent-prompts/_sections/previous-failure.js";
import {
	FINAL_VERDICT_DEVELOPER_SECTION,
} from "../src/agent-prompts/_sections/final-verdict-developer.js";
import {
	FINAL_VERDICT_REVIEWER_SECTION,
} from "../src/agent-prompts/_sections/final-verdict-reviewer.js";

function extract(prompt: string, header: string, tailMarker?: string): number {
	const idx = prompt.indexOf(header);
	expect(
		idx,
		`prompt must contain section starting with ${header}`,
	).toBeGreaterThanOrEqual(0);
	if (!tailMarker) return idx;
	const tailIdx = prompt.slice(idx).indexOf(tailMarker);
	expect(
		tailIdx,
		`section starting at ${header} must contain tail marker ${tailMarker}`,
	).toBeGreaterThanOrEqual(0);
	return idx;
}

describe("shared sections: shape", () => {
	it("COMMIT_DISCIPLINE_SECTION is exported, non-empty, and Developer-only", () => {
		expect(typeof COMMIT_DISCIPLINE_SECTION).toBe("string");
		expect(COMMIT_DISCIPLINE_SECTION.length).toBeGreaterThan(500);
		expect(COMMIT_DISCIPLINE_SECTION).toContain("Commit Discipline (commit-as-checkpoint)");
		expect(DEVELOPER_PROMPT).toContain(COMMIT_DISCIPLINE_SECTION);
		// Reviewer is read-only — it does not commit and does not need this section.
		expect(REVIEWER_PROMPT).not.toContain(COMMIT_DISCIPLINE_SECTION);
	});

	it("BASH_TIMEOUT_SECTION is byte-identical across Developer and Reviewer", () => {
		expect(typeof BASH_TIMEOUT_SECTION).toBe("string");
		expect(BASH_TIMEOUT_SECTION.length).toBeGreaterThan(500);
		expect(BASH_TIMEOUT_SECTION).toContain("Bash Timeout Guard (per-bucket timeouts");
		expect(DEVELOPER_PROMPT).toContain(BASH_TIMEOUT_SECTION);
		expect(REVIEWER_PROMPT).toContain(BASH_TIMEOUT_SECTION);
	});

	it("EXPLORATION_BUDGET_SECTION is byte-identical across Developer and Reviewer", () => {
		expect(typeof EXPLORATION_BUDGET_SECTION).toBe("string");
		expect(EXPLORATION_BUDGET_SECTION.length).toBeGreaterThan(500);
		expect(EXPLORATION_BUDGET_SECTION).toContain("Exploration Budget (hard caps on read tools)");
		expect(DEVELOPER_PROMPT).toContain(EXPLORATION_BUDGET_SECTION);
		expect(REVIEWER_PROMPT).toContain(EXPLORATION_BUDGET_SECTION);
	});

	it("UNCERTAINTY_THRESHOLD_SECTION is byte-identical across Developer and Reviewer", () => {
		expect(typeof UNCERTAINTY_THRESHOLD_SECTION).toBe("string");
		expect(UNCERTAINTY_THRESHOLD_SECTION.length).toBeGreaterThan(500);
		expect(UNCERTAINTY_THRESHOLD_SECTION).toContain("Uncertainty Threshold (ask early, ask once)");
		expect(DEVELOPER_PROMPT).toContain(UNCERTAINTY_THRESHOLD_SECTION);
		expect(REVIEWER_PROMPT).toContain(UNCERTAINTY_THRESHOLD_SECTION);
	});

	it("PREVIOUS_FAILURE_SECTION is Developer-only", () => {
		expect(typeof PREVIOUS_FAILURE_SECTION).toBe("string");
		expect(PREVIOUS_FAILURE_SECTION.length).toBeGreaterThan(500);
		expect(PREVIOUS_FAILURE_SECTION).toContain("Previous failure");
		expect(PREVIOUS_FAILURE_SECTION).toContain("{mode_id}");
		expect(DEVELOPER_PROMPT).toContain(PREVIOUS_FAILURE_SECTION);
		// Reviewer is not retried in the same sense — only Developer is.
		expect(REVIEWER_PROMPT).not.toContain(PREVIOUS_FAILURE_SECTION);
	});

	it("FINAL_VERDICT_DEVELOPER_SECTION has the developer schema (status / deliverables / commits)", () => {
		expect(typeof FINAL_VERDICT_DEVELOPER_SECTION).toBe("string");
		expect(FINAL_VERDICT_DEVELOPER_SECTION.length).toBeGreaterThan(500);
		expect(FINAL_VERDICT_DEVELOPER_SECTION).toContain("status: completed | blocked | partial");
		expect(FINAL_VERDICT_DEVELOPER_SECTION).toContain("deliverables:");
		expect(FINAL_VERDICT_DEVELOPER_SECTION).toContain("test_results:");
		expect(DEVELOPER_PROMPT).toContain(FINAL_VERDICT_DEVELOPER_SECTION);
	});

	it("FINAL_VERDICT_REVIEWER_SECTION has the reviewer schema (verdict / findings / scope_check / anti_goal_check)", () => {
		expect(typeof FINAL_VERDICT_REVIEWER_SECTION).toBe("string");
		expect(FINAL_VERDICT_REVIEWER_SECTION.length).toBeGreaterThan(500);
		expect(FINAL_VERDICT_REVIEWER_SECTION).toContain("verdict: CLEAN | NEEDS_WORK");
		expect(FINAL_VERDICT_REVIEWER_SECTION).toContain("findings:");
		expect(FINAL_VERDICT_REVIEWER_SECTION).toContain("scope_check: pass | fail");
		expect(FINAL_VERDICT_REVIEWER_SECTION).toContain("anti_goal_check: pass | fail");
		expect(REVIEWER_PROMPT).toContain(FINAL_VERDICT_REVIEWER_SECTION);
	});
});

describe("shared sections: removed unused-void suppression", () => {
	// GC-2026-prompt-parser-contract-cleanup #2: previously the Developer
	// prompt declared EXPLORATION_BUDGET_SECTION / UNCERTAINTY_THRESHOLD_SECTION /
	// BASH_TIMEOUT_SECTION / PREVIOUS_FAILURE_SECTION as `const` then
	// `void`-suppressed them — the audit pipeline never saw them. After
	// this GC the four sections are concatenated into DEVELOPER_PROMPT
	// for real. The anchor strings below are unique enough that a regression
	// to void-suppression makes every one of these tests fail.
	it("DEVELOPER_PROMPT contains the EXPLORATION_BUDGET_SECTION header", () => {
		extract(DEVELOPER_PROMPT, "## Exploration Budget (hard caps on read tools)");
	});
	it("DEVELOPER_PROMPT contains the UNCERTAINTY_THRESHOLD_SECTION header", () => {
		extract(DEVELOPER_PROMPT, "## Uncertainty Threshold (ask early, ask once)");
	});
	it("DEVELOPER_PROMPT contains the BASH_TIMEOUT_SECTION header", () => {
		extract(
			DEVELOPER_PROMPT,
			"## Bash Timeout Guard (per-bucket timeouts",
		);
	});
	it("DEVELOPER_PROMPT contains the PREVIOUS_FAILURE_SECTION header", () => {
		extract(DEVELOPER_PROMPT, "## Previous failure");
	});
});