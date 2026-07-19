/**
 * Four Sages - pi Package (role-based agents)
 *
 * Provides four specialized role-based agents, each with its own
 * simplified tool surface. No orchestrator runtime — the LLM routes
 * between agents via natural language and tool calls.
 *
 *   - Fuxi:     Architectural design using MDD Seven Planes (`fuxi_design`)
 *   - QiaoChui: Design review and task decomposition (`qiaochui_review`, `qiaochui_decompose`)
 *   - LuBan:    TDD-based task execution (`luban_execute_task`)
 *   - GaoYao:   Phase-guided quality audit (`gaoyao_audit`, `gaoyao_observe`, `gaoyao_finalize`)
 *
 * Outputs are persisted to `.sages/workspace/` (draft.md, plan.md,
 * execution.yaml, audit.md) via FileService and the per-tool state managers.
 */

// Tools
export { registerFuxiTools } from "./tools/fuxi-tools.js";
export { registerQiaoChuiTools } from "./tools/qiaochui/index.js";
export { registerLubanTools } from "./tools/luban/index.js";
export { registerGaoYaoTools } from "./tools/gaoyao-tools.js";

// Services (per-role runtime support — file I/O + per-tool state)
export { FileService } from "./services/file-service.js";
export { WorkflowStateManager } from "./services/workflow-state-manager.js";
export type { WorkflowState, Task, AuditResult, FuxiPhase, ArchiveInfo } from "./services/workflow-state-manager.js";

// Executor (from luban module)
export { runTask, runTDDCycle, parseExecutionYaml, resolveDependencies, sortByDependencies } from "./executor/index.js";
export type { LubanTask, TDDConfig, TaskResult, TDDPhase, ExecutionSettings, ExecutionPlan } from "./executor/index.js";

// Utils
export { checkWritePermission, getModeInfo, getModeIndicator, getAccessDeniedMessage } from "./utils/mode-checker.js";