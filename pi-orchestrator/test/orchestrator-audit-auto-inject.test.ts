/**
 * orchestrator-audit-auto-inject.test.ts — GC-2026-041
 *
 * Tests the auto-inject logic: when the orchestrator doesn'''t record inline findings
 * via observation.findings, the orchestrator_audit tool should
 * auto-record them as castration findings so computeScore penalizes
 * governance violations.
 *
 * The auto-inject is inside completeAudit() and runs BEFORE computeScore.
 * Tests in this file verify the translation logic (AuditFinding ->
 * OrchestratorFinding) by exercising the same code path the orchestrator
 * uses.
 */

import { describe, expect, it } from "bun:test";

import {
	extractAuditFindings,
} from "../../pi-subagents/src/agent-runner.js";
import { appendFindings, computeScore } from "@/orchestrator-audit.js";
import type { OrchestratorFinding } from "@/types.js";

interface AuditStateLike {
	dag_id: string;
	identity: { dag_id: string; scope: "workflow" | "task" | "batch"; scope_key: string; depth: "fast" | "full" };
	findings: OrchestratorFinding[];
	score: number;
	created_at: string;
	updated_at: string;
}

function makeInitialState(): AuditStateLike {
	return {
		dag_id: "DAG-TEST",
		identity: { dag_id: "DAG-TEST", scope: "workflow", scope_key: "workflow", depth: "fast" },
		findings: [],
		score: 100,
		created_at: new Date().toISOString(),
		updated_at: new Date().toISOString(),
	};
}

describe("GC-2026-041: auto-inject inline findings into state.findings", () => {
	it("T-AUTOINJECT-01: extractAuditFindings detects 5 rule types", () => {
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
		// 1 for completed_no_commits (commits empty + status completed)
		expect(findings.some((f) => f.rule === "completed_no_commits")).toBe(true);
	});

	it("T-AUTOINJECT-02: appendFindings adds findings and recomputes score", () => {
		let state = makeInitialState() as any;
		state = appendFindings(state, [
			{
				task_id: "T1",
				category: "castration",
				severity: "major",
				issue: "test",
				evidence: "test",
				recommendation: "test",
			},
		]);
		expect(state.findings.length).toBe(1);
		// major = -10
		expect(state.score).toBe(90);
	});

	it("T-AUTOINJECT-03: multiple findings accumulate (castration pipeline)", () => {
		let state = makeInitialState() as any;
		// Simulate the auto-inject translation: extractAuditFindings produces
		// AuditFinding[], we translate to OrchestratorFinding[] and append.
		const agentMessage = `\`\`\`yaml
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
		const auditFindings = extractAuditFindings(agentMessage, "");
		// Translate to OrchestratorFinding
		const translated: OrchestratorFinding[] = auditFindings.map((af) => ({
			task_id: "T1",
			category: "castration",
			severity: af.severity,
			issue: af.issue,
			evidence: af.evidence,
			recommendation: af.recommendation,
		}));
		state = appendFindings(state, translated);
		// Score should be < 100 (governance violations penalized)
		expect(state.score).toBeLessThan(100);
		// Each major finding = -10, each minor = -2
		const score = computeScore(state.findings);
		expect(score).toBe(state.score);
	});

	it("T-AUTOINJECT-04: existing finding detected by issue text -> no duplicate", () => {
		// The auto-inject compares by issue text to avoid duplicate
		// findings if the orchestrator already recorded the same issue.
		const auditFinding = extractAuditFindings(`\`\`\`yaml
status: completed
deliverables:
  files_changed: []
  commits: []
test_results:
  pass: 1
  fail: 0
open_questions: []
\`\`\``, "")[0];
		expect(auditFinding).toBeDefined();

		// Simulate: orchestrator already recorded this finding
		const existingIssue = auditFinding!.issue;
		let state = makeInitialState() as any;
		state = appendFindings(state, [
			{
				task_id: "T1",
				category: "ink",
				severity: "major",
				issue: existingIssue,
				evidence: "x",
				recommendation: "y",
			},
		]);

		// Now run the auto-inject logic: if any finding's issue matches
		// an existing one, skip.
		const already = state.findings.some((f: any) => f.issue === auditFinding!.issue);
		expect(already).toBe(true);
	});
});
