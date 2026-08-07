/**
 * GC-2026-041: Ambient module declaration for the cross-package import
 * from pi-subagents/src/agent-runner.ts. The runtime import is a static
 * ESM import (`import { extractAuditFindings } from "..."`) which Node
 * resolves at runtime via the relative path. TypeScript cannot resolve
 * the path because pi/tsconfig.json's rootDir restricts source files
 * to ./pi. This declaration tells tsc the shape of the module so the
 * type checking passes without expanding rootDir.
 *
 * The runtime path is: ../../../../pi-subagents/src/agent-runner.js
 * (4 levels up from pi/src/tools/orchestrator/orchestrator-audit.ts).
 */
declare module "../../../../pi-subagents/src/agent-runner.js" {
	export type AuditFindingSeverity = "minor" | "major" | "critical";
	export type AuditFindingCategory =
		| "ink"
		| "nose"
		| "foot"
		| "castration"
		| "death";
	export interface AuditFinding {
		id: string;
		rule:
			| "missing_yaml_block"
			| "completed_no_commits"
			| "checkpoint_stuck_pattern"
			| "ask_unanswered"
			| "blocked_without_reason";
		severity: AuditFindingSeverity;
		category: AuditFindingCategory;
		issue: string;
		evidence: string;
		recommendation: string;
	}
	export function extractAuditFindings(
		agentMessage: string,
		taskReport: string,
	): AuditFinding[];
}
