/**
 * State Index - DEPRECATED
 * 
 * @deprecated Use services instead:
 * - StateManager + WorkspaceManager → WorkflowStateManager (from ../services)
 * - WorkflowState → WorkflowState (from ../services)
 * 
 * This module exists for backward compatibility only.
 */

export { StateManager } from "./state-manager.js";
export { WorkspaceManager } from "./workspace-manager.js";

// Re-export types from services for compatibility
export type { WorkflowState, Task, AuditResult } from "../services/workflow-state-manager.js";
