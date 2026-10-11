/**
 * @sages/pi-orchestrator — public surface.
 *
 * Re-exports helper modules and the orchestrator registrars.
 * The package's `pi.extensions` entry is `./src/extension.ts` which
 * calls `registerOrchestratorTools`.
 *
 * Post the goal-contract removal the orchestrator registers NO tools of
 * its own. It only wires advisory handlers + session-level hooks and
 * re-exports the helper modules that downstream callers (brainstorming,
 * tests) consume.
 *
 * Most callers want:
 *   import { registerOrchestratorTools } from "@sages/pi-orchestrator";
 */

export { registerOrchestratorTools } from "./extension.js";

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
export * from "./chain-key.js";
export * from "./bash-guard.js";
export * from "./orchestrator-advisory.js";