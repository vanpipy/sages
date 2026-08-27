/**
 * developer-prompt-runtime.test.ts — Pins the runtime export carries the
 * governance sections (GC-2026-076 P1).
 *
 * Before GC-2026-076 the FINAL_VERDICT_ADDENDUM, COMMIT_DISCIPLINE_SECTION,
 * and CHECKPOINT_PROTOCOL_SECTION lived in `void`-suppressed const shells
 * below the runtime export — they were dead code on the LLM side, even
 * though the audit pipeline (`extractStructuredOutput`, `parseCheckpoint`,
 * `extractAuditFindings`) parses for them. This file pins the new
 * invariant: those sections MUST appear in the runtime export the agent
 * reads.
 *
 * Covers: SC1, SC2, SC3.
 */

import { describe, expect, it } from "vitest";
import { DEVELOPER_PROMPT } from "../src/agent-prompts/developer.js";

describe("developer-prompt runtime export: governance sections (GC-2026-076 P1)", () => {
	it("SC1: contains the FINAL_VERDICT YAML schema anchor", () => {
		// The audit pipeline (extractStructuredOutput, REQUIRED_FIELDS)
		// requires status / deliverables / test_results / open_questions
		// from every agent's final YAML block. The runtime export MUST
		// surface the schema so the agent emits a parseable block. The
		// "status: completed | blocked | partial" line is the canonical
		// anchor — its presence proves the schema is wired.
		expect(DEVELOPER_PROMPT).toContain("status: completed | blocked | partial");
	});

	it("SC2: contains the CHECKPOINT_PROTOCOL anchor", () => {
		// parseCheckpoint looks for `[checkpoint N/200 turns, Xm]` lines
		// every 5 turns. The runtime prompt must teach the agent to emit
		// them. Without this, checkpoint_stuck_pattern cannot fire and
		// the orchestrator cannot detect "agent is stuck on exploration".
		expect(DEVELOPER_PROMPT).toContain("[checkpoint N/200 turns");
	});

	it("SC3: contains the COMMIT_DISCIPLINE anchor", () => {
		// The agent-runner reads git history to verify progress. Without
		// `wip: <test name> red` as the RED-commit convention, the agent
		// has no durable progress signal between RED and GREEN.
		expect(DEVELOPER_PROMPT).toContain("wip: <test name> red");
	});

	it("carries the full YAML block (status + deliverables + test_results + open_questions)", () => {
		// The audit gate parses for these fields. The runtime prompt must
		// teach the agent the schema in full, not just the headline line.
		expect(DEVELOPER_PROMPT).toContain("status: completed");
		expect(DEVELOPER_PROMPT).toContain("deliverables:");
		expect(DEVELOPER_PROMPT).toContain("files_changed:");
		expect(DEVELOPER_PROMPT).toContain("commits:");
		expect(DEVELOPER_PROMPT).toContain("tests_added:");
		expect(DEVELOPER_PROMPT).toContain("test_results:");
		expect(DEVELOPER_PROMPT).toContain("open_questions:");
		expect(DEVELOPER_PROMPT).toContain("handoff_for_next_task:");
	});

	it("places the FINAL_VERDICT block AFTER the core mission and commit discipline", () => {
		// Section-order pin: the FINAL_VERDICT section sits late in the
		// prompt so the agent encounters it after the work has been done.
		// Regression guard: a future edit that moves the YAML schema to
		// the top of the prompt (or drops it into the middle of TDD
		// discipline) surfaces here.
		const coreIdx =
			DEVELOPER_PROMPT.match(/^##\s+.*🎯 Your Core Mission.*$/m)?.index ?? -1;
		const verdictIdx = DEVELOPER_PROMPT.indexOf(
			"## Final Verdict (Pinned Output Shape",
		);
		const commitIdx = DEVELOPER_PROMPT.indexOf(
			"## Commit Discipline (commit-as-checkpoint)",
		);
		expect(coreIdx).toBeGreaterThanOrEqual(0);
		expect(verdictIdx).toBeGreaterThanOrEqual(0);
		expect(commitIdx).toBeGreaterThanOrEqual(0);
		expect(coreIdx, "core mission must precede verdict").toBeLessThan(
			verdictIdx,
		);
		expect(commitIdx, "commit discipline must precede verdict").toBeLessThan(
			verdictIdx,
		);
	});

	it("preserves the existing workspace / handoff invariants from developer-prompt.test.ts", () => {
		// Regression guard: the extraction must not break the section
		// anchors pinned by developer-prompt.test.ts. We re-pin the
		// load-bearing ones here so a future edit can't silently remove
		// them while keeping the new YAML anchors.
		expect(DEVELOPER_PROMPT).toMatch(/^##\s+.*Workspace Context.*$/m);
		expect(DEVELOPER_PROMPT).toMatch(/^##\s+.*Workspace Output.*$/m);
		expect(DEVELOPER_PROMPT).toContain("### Template A — Standard");
		expect(DEVELOPER_PROMPT).toContain("### Template B — Phase Gate");
		expect(DEVELOPER_PROMPT).toContain("### Template C — Escalation");
		// The .pi/orchestrator write path and the audit-failure language
		// are load-bearing — both must remain in the runtime prompt.
		expect(DEVELOPER_PROMPT).toContain(
			".pi/orchestrator/handoff/<workspace_id>/<task_id>-handoff.md",
		);
		expect(DEVELOPER_PROMPT.toLowerCase()).toContain("automatic audit failure");
	});
});
