/**
 * @sages/pi-orchestrator — public surface.
 *
 * Re-exports the brainstorming slash-command surface for downstream
 * consumers. The package's `pi.extensions` entry is `./src/extension.ts`
 * which wires the session hooks and registers the six consumer tools
 * (`task_inspect`, `task_consume`, `task_convert_intent`,
 * `task_plan_intent`, `task_add_phase`, `task_close_intent`).
 *
 * Most callers want:
 *   import brainstorming helpers from "@sages/pi-orchestrator";
 */

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

// Helper modules removed in chore/remove-orchestrator-advisory:
// chain-key, bash-guard, orchestrator-advisory — all had the advisory
// pipeline as their sole production caller and were retired together.