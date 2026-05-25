/**
 * Four Sages - pi Package
 * 
 * Provides multi-agent workflow system with four specialized agents:
 * - Fuxi: Architectural design using MDD Seven Planes
 * - QiaoChui: Design review and task decomposition
 * - LuBan: TDD-based task execution
 * - GaoYao: Phase-guided quality audit
 */

// Tools
export { registerFuxiTools } from "./tools/fuxi-tools.js";
export { registerQiaoChuiTools } from "./tools/qiaochui-tools.js";
export { registerLuBanTools } from "./tools/luban-tools.js";
export { registerGaoYaoTools } from "./tools/gaoyao-tools.js";

// Services (NEW - refactored architecture)
export { FileService } from "./services/file-service.js";
export { WorkflowStateManager } from "./services/workflow-state-manager.js";
export type { WorkflowState, Task, AuditResult, FuxiPhase, ArchiveInfo } from "./services/workflow-state-manager.js";

// State (DEPRECATED - use services instead)
export { StateManager, WorkspaceManager } from "./state/index.js";
export type { WorkflowState as LegacyWorkflowState, Task as LegacyTask, AuditResult as LegacyAuditResult } from "./state/index.js";

// Executor
export { TDDRunner, TaskExecutor } from "./executor/index.js";
export type { TDDResult, TDDPhase, Task as ExecutorTask, ExecutionResult } from "./executor/index.js";

// Orchestrator
export { WorkflowOrchestrator } from "./orchestrator/index.js";
export type { Phase, OrchestratorConfig } from "./orchestrator/index.js";

// Utils
export { checkWritePermission, getModeInfo, getModeIndicator, getAccessDeniedMessage } from "./utils/mode-checker.js";
