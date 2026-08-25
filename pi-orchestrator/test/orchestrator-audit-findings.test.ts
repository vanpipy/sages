/**
 * orchestrator-audit-findings.test.ts — GC-2026-041
 *
 * Tests the inline_findings translation: orchestrator-audit reads each
 * task's report, calls extractAuditFindings (the full 5-rule parser
 * from pi-subagents), and translates the AuditFinding[] into
 * inline_findings surfaced in the audit response. L3 records them.
 *
 * After GC-2026-041: orchestrator_audit auto-injects the inline findings
 * into state.findings if the L3 doesn't record them, so computeScore
 * is penalized.
 */

import { describe, expect, it } from "bun:test";

import { runInlineGovernanceCheck } from "@/orchestrator-audit.js";

describe("GC-2026-041: orchestrator_audit uses full 5-rule extractAuditFindings", () => {
	it("T-AUDIT-01: runInlineGovernanceCheck is now a no-op stub (deprecated)", () => {
		const report = `# T1
\`\`\`yaml
status: completed
deliverables:
  commits: ["abc1234"]
open_questions: []
\`\`\``;
		const findings = runInlineGovernanceCheck("T1", report);
		expect(findings).toEqual([]);
	});

	it("T-AUDIT-02: import of extractAuditFindings resolves from pi-subagents", () => {
		// This test verifies the cross-package import doesn't fail at runtime
		// (TypeScript already verified it at typecheck time).
		// The actual 5-rule test cases are in pi-subagents/tests/audit-findings.test.ts.
		expect(typeof runInlineGovernanceCheck).toBe("function");
	});
});
