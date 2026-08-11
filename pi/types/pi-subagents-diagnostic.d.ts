/**
 * GC-2026-044 T2: Ambient module declaration for the cross-package import
 * from pi-subagents/src/diagnostic.ts. Same rationale (and same shape) as
 * pi-subagents-audit.d.ts: the runtime import is a static ESM import that
 * Node resolves via the relative path, but pi/tsconfig.json's rootDir
 * restricts source files to ./pi so tsc cannot follow it. This declaration
 * gives tsc the module's shape without expanding rootDir.
 *
 * Only the surface `orchestrator-audit.ts` consumes is declared here — the
 * writer side of mechanism 1.4 is a sub-agent concern and stays in
 * pi-subagents.
 *
 * The runtime path is: ../../../../pi-subagents/src/diagnostic.js
 * (4 levels up from pi/src/tools/orchestrator/orchestrator-audit.ts).
 */
declare module "../../../../pi-subagents/src/diagnostic.js" {
	export type DiagnosticOutcome =
		| "success"
		| "needs-work"
		| "stalled"
		| "aborted"
		| "error"
		| "crashed";

	export interface DiagnosticEvidence {
		stderrDigest?: string;
		commitShas?: string[];
		prUrl?: string;
		verifierOutputs?: Array<{
			step: string;
			exitCode: number | null;
			outputDigest?: string;
		}>;
		worktreeLease?: { gitdir: string };
	}

	export interface DiagnosticJsonV1 {
		schemaVersion: "v1";
		emittedAt: string;
		dispatchId: string;
		context: { dagId?: string; taskId?: string; worktreeId?: string };
		subagentType: string;
		outcome: DiagnosticOutcome;
		cause: string;
		detail: string;
		evidence?: DiagnosticEvidence;
		retryBudgetLeft?: number;
		priorDispatchId?: string;
	}

	/** Sub-agent-owned diagnostics dir, relative to a repo root. */
	export const DIAGNOSTICS_RELDIR: string;

	export function readDiagnostic(filePath: string): DiagnosticJsonV1 | null;

	export function readAllDiagnostics(dirPath: string): DiagnosticJsonV1[];

	export function pruneOldDiagnostics(
		dirPath: string,
		retentionMs: number,
	): { removed: number };
}
