/**
 * @sages/pi-orchestrator — public surface.
 *
 * Re-exports helper modules and the 4 orchestrator tool registrars.
 * The package's `pi.extensions` entry is `./src/extension.ts` which
 * calls `registerOrchestratorTools`.
 *
 * Most callers want the register function:
 *   import { registerOrchestratorTools } from "@sages/pi-orchestrator";
 */

export { registerOrchestratorTools, registerBrainstormCommand } from "./extension.js";

// Individual tool registrars (rarely needed externally)
export { registerGoalContractTool } from "./goal-contract.js";
export { registerDAGSynthesizerTool } from "./dag-synthesizer.js";
export { registerTaskDispatcherTool } from "./task-dispatcher.js";
export { registerOrchestratorAuditTool } from "./orchestrator-audit.js";
export { registerSagesReminderTool } from "./sages-reminder.js";

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
export * from "./verdict-enforcement.js";
export * from "./verification-cmd-linter.js";
export * from "./bash-guard.js";
export {
	loadGoalContract,
	loadPlan,
} from "./dag-synthesizer.js";

export * as Observability from "./observability/index.js";
export * from "./orchestrator-advisory.js";
export * from "./observability/index.js";
export * as ProjectAnalyzer from "./utils/analyzer/index.js";
export * as FileService from "./services/index.js";
export * from "./bash-guard.js";
export * from "./template-loader.js";