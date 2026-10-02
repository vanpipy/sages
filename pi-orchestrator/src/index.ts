/**
 * @sages/pi-orchestrator — public surface.
 *
 * Re-exports helper modules and the orchestrator tool registrars.
 * The package's `pi.extensions` entry is `./src/extension.ts` which
 * calls `registerOrchestratorTools`.
 *
 * After GC-2026-orchestrator-simplify the orchestrator exports just
 * one tool registrar (`registerGoalContractTool`); the four removed
 * DAG / dispatch / audit / reminder registrars are gone.
 *
 * Most callers want the register function:
 *   import { registerOrchestratorTools } from "@sages/pi-orchestrator";
 */

export { registerOrchestratorTools, registerBrainstormCommand } from "./extension.js";

// Individual tool registrars
export { registerGoalContractTool } from "./goal-contract.js";
export { loadGoalContract } from "./goal-contract.js";

// GC-2026-boundary-subagent-control: registerSubagentControlTools moved
// to pi-subagents. Callers that need to wire the 4 control tools onto a
// custom pi extension should now import from @sages/pi-subagents.

// Brainstorming slash command
export {
	startBrainstorm,
	processClarifyingPhase,
	processProposingPhase,
	processDesigningPhase,
	finalizeDesign,
	generateApprovalMessage,
	parseTransitionResponse,
	createOrchestratorContext,
	discoverProjectContext,
	generateClarifyingQuestions,
	generateApproaches,
	generateDesignSections,
	writeDesignDoc,
	type BrainstormContextResult,
	type BrainstormResponse,
	type TransitionResult,
	type OrchestratorPlanContext,
} from "./brainstorming/index.js";

// Helper modules (used by tests + downstream callers)
export * from "./types.js";
export * from "./state-persistence.js";
export * from "./template-loader.js";
export * from "./goal-lock.js";
export * from "./chain-key.js";
export * from "./namespace-ownership.js";
export * from "./planes.js";
export * from "./bash-guard.js";

export * as Observability from "./observability/index.js";
export * from "./orchestrator-advisory.js";
export * as ProjectAnalyzer from "./utils/analyzer/index.js";
export * as FileService from "./services/index.js";
