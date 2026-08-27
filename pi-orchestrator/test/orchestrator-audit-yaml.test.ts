/**
 * orchestrator-audit-yaml.test.ts — GC-2026-076 P2
 *
 * Verifies the developer-YAML cooperation contract:
 *   - parseDeveloperYAML wraps extractStructuredOutput (from pi-subagents)
 *     and returns SubagentOutput | null.
 *   - parseAuditReportV2 prefers developer YAML when present, populating
 *     developer_commits / developer_tests_added / developer_files_changed /
 *     developer_status. Falls back to the existing parseAuditReport regex
 *     path for the verdict.
 *   - When YAML is absent, the developer_* fields are undefined (never
 *     default to empty arrays / completed) — distinguishing "agent did not
 *     emit YAML" from "agent emitted an empty YAML".
 *   - Disagreement between auditor markdown and developer YAML is surfaced
 *     independently — neither overwrites the other.
 *
 * Coverage: SC6 from GC-2026-076.
 */

import { describe, expect, it } from "bun:test";

import {
	parseAuditReport,
	parseAuditReportV2,
	parseDeveloperYAML,
} from "@/orchestrator-audit.js";

// A realistic developer final message containing the structured YAML block
// from `developer.ts` FINAL_VERDICT_ADDENDUM (GC-2026-076 P1 wires it).
const SAMPLE_YAML_MESSAGE = `Here is my final summary.

\`\`\`yaml
status: completed
deliverables:
  files_changed:
    - pi-orchestrator/src/orchestrator-audit.ts
    - pi-orchestrator/test/orchestrator-audit-yaml.test.ts
  commits:
    - feat(orchestrator-audit): add parseDeveloperYAML helper
    - test(orchestrator-audit): add YAML cooperation tests
    - docs(orchestrator-audit): document V2 helper
  tests_added:
    - pi-orchestrator/test/orchestrator-audit-yaml.test.ts
test_results:
  pass: 6
  fail: 0
  fail_details: []
open_questions: []
handoff_for_next_task:
  - readFirst: pi-orchestrator/test/orchestrator-audit-yaml.test.ts
    context: 4 cases covering parseDeveloperYAML + parseAuditReportV2
\`\`\`

All gates green.`;

describe("GC-2026-076 P2: parseDeveloperYAML wraps extractStructuredOutput", () => {
	it("T-YAML-01: extracts status, commits, tests_added from sample developer message", () => {
		const parsed = parseDeveloperYAML(SAMPLE_YAML_MESSAGE);
		expect(parsed).not.toBeNull();
		expect(parsed!.status).toBe("completed");
		expect(parsed!.deliverables.commits).toEqual([
			"feat(orchestrator-audit): add parseDeveloperYAML helper",
			"test(orchestrator-audit): add YAML cooperation tests",
			"docs(orchestrator-audit): document V2 helper",
		]);
		expect(parsed!.deliverables.testsAdded).toEqual([
			"pi-orchestrator/test/orchestrator-audit-yaml.test.ts",
		]);
		expect(parsed!.deliverables.filesChanged).toEqual([
			"pi-orchestrator/src/orchestrator-audit.ts",
			"pi-orchestrator/test/orchestrator-audit-yaml.test.ts",
		]);
		expect(parsed!.testResults.pass).toBe(6);
		expect(parsed!.testResults.fail).toBe(0);
	});

	it("T-YAML-02: returns null when the message is null", () => {
		expect(parseDeveloperYAML(null)).toBeNull();
	});

	it("T-YAML-03: returns null when the message has no YAML block", () => {
		expect(parseDeveloperYAML("plain text, no yaml")).toBeNull();
	});

	it("T-YAML-04: returns null when YAML is missing required fields", () => {
		const malformed = `\`\`\`yaml
status: completed
\`\`\``;
		expect(parseDeveloperYAML(malformed)).toBeNull();
	});
});

describe("GC-2026-076 P2: parseAuditReportV2 prefers YAML, falls back to regex", () => {
	it("T-V2-01: populates developer_commits from YAML even if auditor says NEEDS WORK", () => {
		// Auditor verdict says NEEDS WORK (verdict still surfaces from regex)
		const auditorMarkdown = `# P2 Audit

**Final Verdict**

**NEEDS WORK**

## Concerns
- Lint complaints
`;
		const summary = parseAuditReportV2("P2", auditorMarkdown, SAMPLE_YAML_MESSAGE);
		expect(summary.developer_commits).toEqual([
			"feat(orchestrator-audit): add parseDeveloperYAML helper",
			"test(orchestrator-audit): add YAML cooperation tests",
			"docs(orchestrator-audit): document V2 helper",
		]);
		expect(summary.developer_status).toBe("completed");
		expect(summary.developer_files_changed).toContain(
			"pi-orchestrator/src/orchestrator-audit.ts",
		);
		expect(summary.developer_tests_added).toContain(
			"pi-orchestrator/test/orchestrator-audit-yaml.test.ts",
		);
		// Verdict still falls back to the regex path
		expect(summary.verdict).toBe("NEEDS WORK");
		expect(summary.has_report).toBe(true);
	});

	it("T-V2-02: returns developer_status undefined when YAML absent, verdict falls back to regex", () => {
		const auditorMarkdown = `# P2 Audit

**Final Verdict**

**CERTIFIED**

## Concerns
`;
		const summary = parseAuditReportV2("P2", auditorMarkdown, null);
		expect(summary.developer_status).toBeUndefined();
		expect(summary.developer_commits).toBeUndefined();
		expect(summary.developer_files_changed).toBeUndefined();
		expect(summary.developer_tests_added).toBeUndefined();
		// Verdict still surfaces from the regex
		expect(summary.verdict).toBe("CERTIFIED");
	});

	it("T-V2-03: backward-compat — parseAuditReport (legacy) still works on the same markdown", () => {
		const auditorMarkdown = `# P2 Audit

**Final Verdict**

**CERTIFIED**

## Concerns
- one
- two
`;
		const legacy = parseAuditReport("P2", auditorMarkdown);
		expect(legacy.verdict).toBe("CERTIFIED");
		expect(legacy.findings_total).toBe(2);
		expect(legacy.has_report).toBe(true);
		expect((legacy as any).developer_commits).toBeUndefined();
	});

	it("T-V2-04: regression — disagreement surfaces both fields, neither overrides", () => {
		// Auditor markdown says NEEDS WORK; developer YAML says completed.
		// Both must be visible — neither overwrites the other.
		const auditorMarkdown = `# P2 Audit

**Final Verdict**

**NEEDS WORK**

## Concerns
- some auditor concern
`;
		const developerYaml = `\`\`\`yaml
status: completed
deliverables:
  files_changed: ["x.ts"]
  commits: ["abc1234"]
  tests_added: ["a.test.ts"]
test_results:
  pass: 1
  fail: 0
open_questions: []
handoff_for_next_task: []
\`\`\``;
		const summary = parseAuditReportV2("P2", auditorMarkdown, developerYaml);
		expect(summary.verdict).toBe("NEEDS WORK");
		expect(summary.developer_status).toBe("completed");
		// Both signals surfaced — no override, no silent reconciliation
		expect(summary.developer_commits).toEqual(["abc1234"]);
	});

	it("T-V2-05: developer_message omitted (undefined) behaves the same as null", () => {
		const auditorMarkdown = `# P2 Audit

**Final Verdict**

**CERTIFIED**
`;
		const summary = parseAuditReportV2("P2", auditorMarkdown);
		expect(summary.verdict).toBe("CERTIFIED");
		expect(summary.developer_status).toBeUndefined();
	});

	it("T-V2-06: malformed YAML returns developer_status undefined, verdict still parsed", () => {
		const auditorMarkdown = `# P2 Audit

**Final Verdict**

**NEEDS WORK**
`;
		const malformedYaml = `\`\`\`yaml
not: valid: structured: output
\`\`\``;
		const summary = parseAuditReportV2("P2", auditorMarkdown, malformedYaml);
		expect(summary.developer_status).toBeUndefined();
		expect(summary.developer_commits).toBeUndefined();
		expect(summary.verdict).toBe("NEEDS WORK");
	});
});
