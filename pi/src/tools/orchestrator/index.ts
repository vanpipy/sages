/**
 * Orchestrator Tools — registration entry point.
 *
 * The orchestrator adds 4 tools to the sages package:
 *   - goal_contract_create: Stage 1 (turn user intent into verifiable contract)
 *   - dag_synthesize:       Stage 2 (decompose into task DAG; supports task_template rendering)
 *   - task_dispatch:        Stage 3 (build dispatch plan, return for LLM to execute)
 *   - orchestrator_audit:   Stage 4 (workflow-level audit rollup — A3 split)
 *
 * Plus template helpers (from template-loader.ts):
 *   - loadPromptTemplate, loadGoalTemplate, loadDagTemplate
 *   - renderTemplate (substitutes {{var}} + handles {{#if}} blocks)
 *   - renderTaskPrompt (resolves task_template name to rendered prompt)
 *
 * Templates live at skills/orchestrator/templates/{prompts,goals,dag,responses}/
 * and are installed automatically alongside skills/ via install_sages_files().
 *
 * Subagent execution (TDD implementer, auditor) is delegated to the Agent
 * tool with `subagent_type: "software-developer"` / `"software-auditor"`.
 * See `pi/templates/SUBAGENTS.md` for the 4-stage pipeline
 * (Explore → Plan → software-developer → software-auditor).
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
  findSagesRoot,
  findTemplatesRoot,
  loadPromptTemplate,
  loadResponseTemplate,
  loadGoalTemplate,
  loadDagTemplate,
  listTemplates,
  renderTemplate,
  renderTaskPrompt,
  validateTemplateParams,
  getTemplateParamsSchema,
  type TemplateParam,
} from "./template-loader.js";

export {
  canMainAgentWrite,
  policyMessage,
  executeSagesWrite,
  executeSagesEdit,
  registerFileGate,
  SagesWriteParams,
  SagesEditParams,
  type ToolResponse,
} from "../file-gate.js";

export {
  type GoalContract,
  type SuccessCriterion,
  type TaskNode,
  type OrchestrationPlan,
  type OrchestratorAuditResult,
  type OrchestratorFinding,
  type AuditVerdict,
  type TaskTemplate,
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