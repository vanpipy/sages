/**
 * auditor-prompt-runtime.test.ts — Pins the runtime export carries the
 * FINAL_VERDICT YAML schema (GC-2026-076 P1).
 *
 * Before GC-2026-076 the FINAL_VERDICT_ADDENDUM lived in a `void`-suppressed
 * const shell below the runtime export. The orchestrator's
 * extractStructuredOutput parser, however, parses every agent's final
 * message for the YAML schema — including the auditor's. Without the
 * schema in the runtime prompt, the auditor never emits a parseable
 * block, and the audit gate fires `missing_yaml_block`.
 *
 * Covers: SC4.
 */

import { describe, expect, it } from "vitest";
import { AUDITOR_PROMPT } from "../src/agent-prompts/auditor.js";

describe("auditor-prompt runtime export: FINAL_VERDICT YAML schema (GC-2026-076 P1)", () => {
	it("SC4: contains the FINAL_VERDICT YAML schema anchor", () => {
		// The audit gate parses the YAML schema from every agent's final
		// message. The auditor's runtime export must surface the schema
		// so it emits a parseable block. The "status: completed |
		// blocked | partial" line is the canonical anchor.
		expect(AUDITOR_PROMPT).toContain("status: completed | blocked | partial");
	});

	it("carries the full YAML block (status + deliverables + test_results + open_questions)", () => {
		// The audit gate parses for these fields. The runtime prompt must
		// teach the auditor agent the schema in full, not just the headline.
		expect(AUDITOR_PROMPT).toContain("status: completed");
		expect(AUDITOR_PROMPT).toContain("deliverables:");
		expect(AUDITOR_PROMPT).toContain("files_changed:");
		expect(AUDITOR_PROMPT).toContain("commits:");
		expect(AUDITOR_PROMPT).toContain("tests_added:");
		expect(AUDITOR_PROMPT).toContain("test_results:");
		expect(AUDITOR_PROMPT).toContain("open_questions:");
		expect(AUDITOR_PROMPT).toContain("handoff_for_next_task:");
	});

	it("explains the audit-gate's mechanical verification of the YAML block", () => {
		// The auditor must understand that the orchestrator parses the
		// YAML and may reject the dispatch if status claims tests pass
		// while the actual bun test output shows fewer passes. The
		// auditor's verify-only role makes this load-bearing.
		expect(AUDITOR_PROMPT.toLowerCase()).toContain("audit gate");
		// The YAML schema exposes pass + fail counts; the regex must span
		// newlines because the schema is multi-line.
		expect(AUDITOR_PROMPT.toLowerCase()).toMatch(
			/yaml[\s\S]*pass[\s\S]*fail|pass[\s\S]*fail[\s\S]*yaml/,
		);
	});

	it("preserves the auditor's existing CERTIFIED / NEEDS WORK / BLOCKED prose", () => {
		// Regression guard: wiring the YAML schema must NOT remove the
		// markdown `**CERTIFIED / NEEDS WORK / BLOCKED**` markers that
		// the orchestrator's parseAuditReport regex still scans. The
		// orchestrator prefers YAML but falls back to the markdown regex.
		expect(AUDITOR_PROMPT).toContain("CERTIFIED");
		expect(AUDITOR_PROMPT).toContain("NEEDS WORK");
		expect(AUDITOR_PROMPT).toContain("BLOCKED");
		expect(AUDITOR_PROMPT).toContain("## Final Verdict");
	});

	it("preserves the auditor's verify-only contract and audit-file write target", () => {
		// Regression guard: the auditor's single allowed write target is
		// `.pi/orchestrator/audit-{task_id}.md`. Wiring YAML into the
		// runtime must NOT remove the path or the verify-only language.
		expect(AUDITOR_PROMPT.toLowerCase()).toContain("verify only");
		expect(AUDITOR_PROMPT).toContain("audit-{task_id}.md");
	});
});
