/**
 * orchestrator-audit-verdict-file-fallback.test.ts — GC-2026-094 P4
 *
 * Wires `extractStructuredOutputFromFile` (added in P3 on the parallel
 * `sages/GC-2026-094/P3` branch) into the orchestrator's audit gate. The
 * `parseDeveloperYAML` call inside `parseAuditReportV2` previously returned
 * `null` whenever the developer's last assistant message lacked a YAML
 * block — the typical case when the agent loop is hard-aborted at the
 * soft/hard turn limit. The audit gate then fired `missing_yaml_block`
 * (a synthetic castration finding from `extractAuditFindings`) and
 * workflowReady flipped to false even though the agent HAD written a
 * well-formed YAML to `.pi/orchestrator/verdict-{task_id}.md` before
 * the abort.
 *
 * `parseDeveloperYAMLWithFallback` is the new sibling that:
 *   1. Tries the message first (preserves the original contract).
 *   2. Falls back to `.pi/orchestrator/verdict-{task_id}.md` via
 *      `extractStructuredOutputFromFile` (the P3 file-fallback helper).
 *   3. Returns null only when neither source produced a parsable block.
 *
 * Coverage: SC-2026-094-B (verdict survives boundary via file fallback).
 */

import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
	parseAuditReportV2,
	parseDeveloperYAML,
	parseDeveloperYAMLWithFallback,
} from "@/orchestrator-audit.js";

// A realistic YAML block as the developer subagent emits it (mirrors the
// shape in orchestrator-audit-yaml.test.ts so we exercise the same
// parser — no parallel fixture).
const VERDICT_YAML = `\`\`\`yaml
status: completed
deliverables:
  files_changed:
    - pi-orchestrator/src/orchestrator-audit.ts
    - pi-orchestrator/test/orchestrator-audit-verdict-file-fallback.test.ts
  commits:
    - feat(orchestrator): consume verdict-file fallback in audit gate (GC-2026-094 P4)
  tests_added:
    - pi-orchestrator/test/orchestrator-audit-verdict-file-fallback.test.ts
test_results:
  pass: 4
  fail: 0
  fail_details: []
open_questions: []
handoff_for_next_task: []
\`\`\``;

describe("GC-2026-094 P4: parseDeveloperYAMLWithFallback (verdict-file fallback)", () => {
	let cwd: string;

	beforeEach(() => {
		// Fresh isolated cwd per test — verdict files persist between tests
		// if we don't clean up.
		cwd = mkdtempSync(join(tmpdir(), "gc-2026-094-p4-"));
	});

	afterEach(() => {
		rmSync(cwd, { recursive: true, force: true });
	});

	it("T-FB-01: file-only — empty message + well-formed verdict file returns parsed SubagentOutput", () => {
		const verdictDir = join(cwd, ".pi", "orchestrator");
		mkdirSync(verdictDir, { recursive: true });
		writeFileSync(join(verdictDir, "verdict-T1.md"), VERDICT_YAML);

		// The developer's last assistant message was lost to the boundary
		// abort, but the file fallback recovers the verdict.
		const parsed = parseDeveloperYAMLWithFallback(null, "T1", cwd);
		expect(parsed).not.toBeNull();
		expect(parsed!.status).toBe("completed");
		expect(parsed!.deliverables.commits).toEqual([
			"feat(orchestrator): consume verdict-file fallback in audit gate (GC-2026-094 P4)",
		]);
		expect(parsed!.deliverables.testsAdded).toEqual([
			"pi-orchestrator/test/orchestrator-audit-verdict-file-fallback.test.ts",
		]);
		expect(parsed!.testResults.pass).toBe(4);
		expect(parsed!.testResults.fail).toBe(0);
	});

	it("T-FB-02: message wins — both message-YAML and file-YAML present, message wins", () => {
		const verdictDir = join(cwd, ".pi", "orchestrator");
		mkdirSync(verdictDir, { recursive: true });
		// File claims BLOCKED — a deliberately stale / pre-finalization write.
		writeFileSync(
			join(verdictDir, "verdict-T2.md"),
			VERDICT_YAML.replace("status: completed", "status: blocked"),
		);
		// Message claims completed — the developer's final message has the
		// authoritative verdict.
		const messageResult = parseDeveloperYAMLWithFallback(VERDICT_YAML, "T2", cwd);
		expect(messageResult).not.toBeNull();
		expect(messageResult!.status).toBe("completed");
		// Sanity: the message path also proves parseDeveloperYAML agrees.
		expect(parseDeveloperYAML(VERDICT_YAML)!.status).toBe("completed");
	});

	it("T-FB-03: neither — null message + missing file returns null (preserves existing behavior)", () => {
		const parsed = parseDeveloperYAMLWithFallback(null, "T3", cwd);
		expect(parsed).toBeNull();
	});

	it("T-FB-04: malformed file — null message + garbage file returns null", () => {
		const verdictDir = join(cwd, ".pi", "orchestrator");
		mkdirSync(verdictDir, { recursive: true });
		writeFileSync(
			join(verdictDir, "verdict-T4.md"),
			"this is not a yaml block at all\n\njust text\n",
		);
		const parsed = parseDeveloperYAMLWithFallback(null, "T4", cwd);
		expect(parsed).toBeNull();
	});

	it("T-FB-05: empty string message behaves like null — file fallback fires", () => {
		const verdictDir = join(cwd, ".pi", "orchestrator");
		mkdirSync(verdictDir, { recursive: true });
		writeFileSync(join(verdictDir, "verdict-T5.md"), VERDICT_YAML);
		const parsed = parseDeveloperYAMLWithFallback("", "T5", cwd);
		expect(parsed).not.toBeNull();
		expect(parsed!.status).toBe("completed");
	});
});

describe("GC-2026-094 P4: parseAuditReportV2 threads cwd through to file fallback", () => {
	let cwd: string;

	beforeEach(() => {
		cwd = mkdtempSync(join(tmpdir(), "gc-2026-094-p4-v2-"));
	});

	afterEach(() => {
		rmSync(cwd, { recursive: true, force: true });
	});

	it("T-V2FB-01: file-only verdict populates developer_* fields without a developerMessage", () => {
		const verdictDir = join(cwd, ".pi", "orchestrator");
		mkdirSync(verdictDir, { recursive: true });
		writeFileSync(join(verdictDir, "verdict-P4.md"), VERDICT_YAML);

		const auditorMarkdown = `# P4 Audit

**Final Verdict**

**CERTIFIED**
`;
		// developerMessage is null — the boundary-aborted case. cwd is the
		// wiring that activates the file fallback.
		const summary = parseAuditReportV2("P4", auditorMarkdown, null, cwd);
		expect(summary.developer_status).toBe("completed");
		expect(summary.developer_commits).toEqual([
			"feat(orchestrator): consume verdict-file fallback in audit gate (GC-2026-094 P4)",
		]);
		expect(summary.developer_tests_added).toEqual([
			"pi-orchestrator/test/orchestrator-audit-verdict-file-fallback.test.ts",
		]);
		// Verdict still surfaces from the markdown regex path.
		expect(summary.verdict).toBe("CERTIFIED");
		expect(summary.has_report).toBe(true);
	});

	it("T-V2FB-02: backward-compat — without cwd, missing YAML yields developer_status undefined", () => {
		const auditorMarkdown = `# P4 Audit

**Final Verdict**

**CERTIFIED**
`;
		const summary = parseAuditReportV2("P4", auditorMarkdown, null);
		// No cwd = no file fallback = legacy behavior preserved.
		expect(summary.developer_status).toBeUndefined();
		expect(summary.developer_commits).toBeUndefined();
		expect(summary.verdict).toBe("CERTIFIED");
	});
});