/**
 * Orchestrator Tools — registration entry point.
 *
 * The orchestrator adds 4 tools to the sages package:
 *   - goal_contract_create: Stage 1 (turn user intent into verifiable contract)
 *   - dag_synthesize:       Stage 2 (decompose into task DAG)
 *   - task_dispatch:        Stage 3 (build dispatch plan, return for LLM to execute)
 *   - orchestrator_audit:   Stage 4 (5-phase audit of completed tasks)
 *
 * These complement (don't replace) the existing sages tools:
 *   - fuxi_design:     main agent design workflow
 *   - qiaochui_review: reviews design drafts (process-level)
 *   - luban_execute_task: TDD enforcement per task
 *   - gaoyao_audit:    process-level audit on .sages/workspace/
 *
 * Orchestrator is for orchestrator-managed multi-task workflows;
 * sages is for single-workflow process governance.
 */

import { registerGoalContractTool } from "./goal-contract.js";
import { registerDAGSynthesizerTool } from "./dag-synthesizer.js";
import { registerTaskDispatcherTool } from "./task-dispatcher.js";
import { registerOrchestratorAuditTool } from "./orchestrator-audit.js";

export {
  buildGoalContract,
  goalContractToYaml,
  validateGoalContract,
} from "./goal-contract.js";

export {
  buildPlan,
  planToYaml,
  validateDAG,
  loadPlan,
  loadGoalContract,
} from "./dag-synthesizer.js";

export {
  buildDispatchPlan,
  type DispatchPlan,
  type DispatchBatch,
  type DispatchTask,
} from "./task-dispatcher.js";

export {
  writeAuditReport,
} from "./orchestrator-audit.js";

export {
  type GoalContract,
  type SuccessCriterion,
  type TaskNode,
  type OrchestrationPlan,
  type OrchestratorAuditResult,
  type OrchestratorFinding,
  type AuditVerdict,
  ORCHESTRATOR_DIR,
  goalContractPath,
  dagPath,
  taskReportPath,
  taskAuditPath,
} from "./types.js";

// Internal types (used by other orchestrator modules, not re-exported from index):
// GoalContractInput, DAGInput, TaskDispatchInput, OrchestratorAuditInput, AuditState

/**
 * Register all orchestrator tools on the pi extension API.
 * Called from src/extension.ts alongside the 4 sages.
 */
export function registerOrchestratorTools(pi: any): void {
  registerGoalContractTool(pi);
  registerDAGSynthesizerTool(pi);
  registerTaskDispatcherTool(pi);
  registerOrchestratorAuditTool(pi);
}